import array
import base64
import json
import math
import os
import platform
import re
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request

_BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(_BACKEND_DIR / ".env")

app = Flask(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
GEMINI_MODEL_FALLBACKS = [
    m.strip()
    for m in os.getenv(
        "GEMINI_MODEL_FALLBACKS",
        # gemini-1.5-flash was retired (404); these are the models that still serve.
        "gemini-flash-latest,gemini-2.5-flash-lite,gemini-2.0-flash",
    ).split(",")
    if m.strip()
]
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip()
DEFAULT_VOICE_ID = os.getenv("DEFAULT_ELEVENLABS_VOICE_ID", "").strip()
PORT = int(os.getenv("PORT", "5001"))
LISTEN_SECONDS = float(os.getenv("LISTEN_SECONDS", "7"))

# OpenAI (primary provider): chat completions for replies, Whisper for transcription.
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()
OPENAI_TRANSCRIBE_MODEL = os.getenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1").strip()
OPENAI_BASE = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")

_gemini_client = None


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


def get_gemini_client():
    global _gemini_client
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "Gemini API key is not configured. Add GEMINI_API_KEY to backend/.env "
            "(create one at https://aistudio.google.com/apikey)."
        )
    if _gemini_client is None:
        from google import genai

        _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
    return _gemini_client


def gemini_models_to_try() -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for model in [GEMINI_MODEL, *GEMINI_MODEL_FALLBACKS]:
        if model and model not in seen:
            seen.add(model)
            ordered.append(model)
    return ordered


REPLY_EMOTIONS = ["happy", "sad", "angry", "surprised", "supportive", "thinking", "concerned"]


def _openai_headers() -> Dict[str, str]:
    if not OPENAI_API_KEY:
        raise RuntimeError(
            "OpenAI API key is not configured. Add OPENAI_API_KEY to backend/.env "
            "(create one at https://platform.openai.com/api-keys and add a little credit)."
        )
    return {"Authorization": f"Bearer {OPENAI_API_KEY}"}


def format_openai_error(resp: "requests.Response") -> str:
    try:
        detail = resp.json().get("error", {}).get("message", "") or resp.text[:300]
    except Exception:
        detail = (resp.text or "")[:300]
    if resp.status_code == 401:
        return "OpenAI rejected the API key. Check OPENAI_API_KEY in backend/.env."
    if resp.status_code == 429 or "insufficient_quota" in detail:
        return (
            "OpenAI quota/rate limit hit. Add credit at "
            "https://platform.openai.com/settings/organization/billing, then retry."
        )
    return f"OpenAI error {resp.status_code}: {detail}"


def generate_with_openai(*, system_prompt: str, user_prompt: str, json_mode: bool = True) -> str:
    headers = {**_openai_headers(), "Content-Type": "application/json"}
    body: Dict[str, Any] = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 600,
    }
    if json_mode:
        # JSON mode still forbids prose preambles ("Here's your JSON...") but, unlike a
        # strict schema, leaves room for the optional `actions`/`widget` fields. The exact
        # shape is specified in the system prompt.
        body["response_format"] = {"type": "json_object"}
    resp = requests.post(f"{OPENAI_BASE}/chat/completions", headers=headers, json=body, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(format_openai_error(resp))
    data = resp.json()
    return (data["choices"][0]["message"].get("content") or "").strip()


def transcribe_with_openai(file_name: str, file_bytes: bytes, mime_type: str) -> str:
    headers = _openai_headers()  # multipart; let requests set Content-Type
    files = {"file": (file_name, file_bytes, mime_type or "application/octet-stream")}
    data = {"model": OPENAI_TRANSCRIBE_MODEL, "language": "en"}
    resp = requests.post(
        f"{OPENAI_BASE}/audio/transcriptions",
        headers=headers,
        files=files,
        data=data,
        timeout=120,
    )
    if resp.status_code != 200:
        raise RuntimeError(format_openai_error(resp))
    return (resp.json().get("text") or "").strip()


def format_gemini_error(exc: Exception) -> str:
    text = str(exc)
    if "429" in text or "RESOURCE_EXHAUSTED" in text:
        return (
            "Gemini rate limit or quota exhausted. Wait a minute, enable billing in "
            "Google AI Studio, or create a fresh API key at https://aistudio.google.com/apikey"
        )
    if "401" in text or "403" in text or "API_KEY" in text:
        return (
            "Gemini rejected the API key. Create a new key at "
            "https://aistudio.google.com/apikey and update backend/.env, then restart the server."
        )
    return text


_safety_settings_cache: Optional[List[Any]] = None


def gemini_safety_settings() -> Optional[List[Any]]:
    """Disable Gemini content blocking so profanity / aggressive personas aren't silently
    refused (a refusal leaves the companion with no text AND no voice)."""
    global _safety_settings_cache
    if _safety_settings_cache is not None:
        return _safety_settings_cache or None
    from google.genai import types

    threshold = (
        getattr(types.HarmBlockThreshold, "BLOCK_NONE", None)
        or getattr(types.HarmBlockThreshold, "OFF", None)
    )
    settings: List[Any] = []
    if threshold is not None:
        for name in (
            "HARM_CATEGORY_HARASSMENT",
            "HARM_CATEGORY_HATE_SPEECH",
            "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "HARM_CATEGORY_DANGEROUS_CONTENT",
            "HARM_CATEGORY_CIVIC_INTEGRITY",
        ):
            category = getattr(types.HarmCategory, name, None)
            if category is None:
                continue
            try:
                settings.append(types.SafetySetting(category=category, threshold=threshold))
            except Exception:
                continue
    _safety_settings_cache = settings
    return settings or None


def _safe_response_text(response: Any) -> str:
    """Read response text without raising when a candidate was blocked/empty."""
    try:
        text = response.text
        if text:
            return text.strip()
    except Exception:
        pass
    try:
        parts = response.candidates[0].content.parts
        return "".join(getattr(p, "text", "") or "" for p in parts).strip()
    except Exception:
        return ""


def generate_with_gemini(
    *,
    system_prompt: str,
    user_prompt: str,
    json_mode: bool = True,
) -> str:
    from google.genai import types

    client = get_gemini_client()
    base_kwargs: Dict[str, Any] = {
        "system_instruction": system_prompt,
        "temperature": 0.7,
        "max_output_tokens": 400,
    }
    safety = gemini_safety_settings()
    if safety:
        base_kwargs["safety_settings"] = safety
    if json_mode:
        base_kwargs["response_mime_type"] = "application/json"
        # A response_schema forces structured output — the model literally cannot return
        # prose like "Here's your JSON...". This is the hard guarantee on top of the prompt.
        try:
            base_kwargs["response_schema"] = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "text": types.Schema(type=types.Type.STRING),
                    "emotion": types.Schema(
                        type=types.Type.STRING,
                        enum=[
                            "happy", "sad", "angry", "surprised",
                            "supportive", "thinking", "concerned",
                        ],
                    ),
                },
                required=["text", "emotion"],
            )
        except Exception:
            pass

    # gemini-2.5 / *-latest are "thinking" models: without this they spend the output
    # budget on hidden reasoning and the real answer comes back truncated/empty.
    thinking_cfg = None
    try:
        thinking_cfg = types.ThinkingConfig(thinking_budget=0)
    except Exception:
        thinking_cfg = None

    last_error: Optional[Exception] = None
    for model in gemini_models_to_try():
        config_kwargs = dict(base_kwargs)
        if thinking_cfg is not None and ("2.5" in model or "latest" in model):
            config_kwargs["thinking_config"] = thinking_cfg
        try:
            response = client.models.generate_content(
                model=model,
                contents=user_prompt,
                config=types.GenerateContentConfig(**config_kwargs),
            )
            text = _safe_response_text(response)
            if text:
                return text
            raise RuntimeError("Gemini returned an empty response.")
        except Exception as exc:
            last_error = exc
            continue

    raise RuntimeError(format_gemini_error(last_error or RuntimeError("Gemini request failed.")))


def normalize_voice_id(value: str) -> str:
    candidate = value.strip()
    if not candidate:
        return ""
    match = re.search(r"voiceId=([A-Za-z0-9_-]+)", candidate)
    if match:
        return match.group(1)
    return candidate


def classify_emotion(text: str) -> str:
    lowered = text.lower()
    if any(word in lowered for word in ["error", "fail", "broken", "crash", "exception", "traceback"]):
        return "concerned"
    if any(word in lowered for word in ["great", "nice", "good", "done", "works", "fixed"]):
        return "happy"
    if any(word in lowered for word in ["stuck", "confused", "why", "what", "how"]):
        return "thinking"
    if any(word in lowered for word in ["wow", "oh", "wait", "surprise"]):
        return "surprised"
    return "supportive"


_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001FAFF"  # symbols, pictographs, emoji
    "\U00002600-\U000027BF"  # misc symbols + dingbats
    "\U0001F1E6-\U0001F1FF"  # flags
    "\U00002190-\U000021FF"  # arrows
    "\U00002B00-\U00002BFF"  # misc symbols/arrows
    "️"                  # variation selector
    "]+",
    flags=re.UNICODE,
)


def extract_spoken_text(raw: str) -> str:
    """Dig the "text" field out of a noisy/partial JSON reply, else return raw."""
    match = re.search(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
    if match:
        try:
            return bytes(match.group(1), "utf-8").decode("unicode_escape")
        except Exception:
            return match.group(1)
    return raw


def sanitize_for_speech(text: str) -> str:
    """Strip anything a TTS voice should not read aloud (emojis, emoticons, markdown,
    code, stray JSON punctuation, 'here is the JSON' preambles)."""
    s = text.strip()
    s = re.sub(r"```.*?```", " ", s, flags=re.DOTALL)          # fenced code blocks
    s = s.replace("`", "")
    s = re.sub(r"(?i)^\s*here\s+(?:is|'?s)\b[^:]*:\s*", "", s)  # 'Here is the JSON:' preamble
    s = _EMOJI_RE.sub("", s)
    s = re.sub(r"[:;=8xX][-o^']?[)(\[\]dDpP3>|\\/]+", "", s)    # ASCII emoticons :) :D x)
    s = re.sub(r"[*_#>~|]", "", s)                              # markdown / table chars
    s = s.replace("{", "").replace("}", "").replace('"', "")    # leftover JSON punctuation
    s = re.sub(r"\s+", " ", s).strip()
    return s


def safe_json_loads(text: str) -> Dict[str, Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return json.loads(match.group(0))
        raise


def build_system_prompt(character_prompt: str, character_name: str) -> str:
    role = character_name or "the companion"
    return (
        f"You are {role}, a voice-reactive VS Code companion AND a hands-on productivity "
        "partner for a developer (not a passive autocomplete). "
        "Reply with ONLY a single JSON object and nothing else — no preamble, no "
        "explanation, no 'here is the JSON', no markdown fences. "
        'The JSON shape is: {"text":"...", "emotion":"happy|sad|angry|surprised|supportive|thinking|concerned", '
        '"actions":[...optional...], "widget":{...optional...}}. '
        "The \"text\" value will be read aloud by a text-to-speech voice, so it MUST be "
        "one to three natural spoken sentences of plain English. In \"text\" do NOT use "
        "emojis, emoticons (like :) or :D), markdown, asterisks, backticks, code blocks, "
        "bullet points, URLs, file paths, or any symbols a person would not say out loud. "
        "Spell things out as words. Put the feeling in the \"emotion\" field, not in symbols.\n\n"
        "TODO LIST: You can manage the developer's todo list. When (and only when) they ask "
        "you to, include an \"actions\" array of operations. Each operation is one of: "
        '{"action":"add","text":"<task>"}, '
        '{"action":"move","id":"<id or task text>","status":"todo|in-progress|done"}, '
        '{"action":"complete","id":"<id or task text>"}, '
        '{"action":"delete","id":"<id or task text>"}. '
        "Use the ids from the CURRENT TODOS provided below; if unsure, pass the task text as the id. "
        "After acting, confirm conversationally in \"text\" (e.g. 'Added that to your list.'). "
        "If no todo change is requested, omit \"actions\" or use an empty array.\n\n"
        "WIDGETS: To celebrate a real achievement (a finished task, a hard bug squashed, or when "
        'they ask to celebrate), include {"widget":{"type":"celebration"}}. '
        "To share a learning resource, tutorial, documentation, or useful website they asked for, "
        'include {"widget":{"type":"resource","title":"...","description":"<one short line>",'
        '"url":"https://...","query":"<search terms>","label":"Open"}}. '
        "For \"url\", ONLY give a real link you are highly confident exists — prefer the canonical "
        "root or docs homepage of a well-known project (e.g. https://react.dev, "
        "https://docs.python.org/3/) rather than guessing a deep path that may be a dead link. "
        "ALWAYS also include \"query\": a few plain search keywords for the topic; it is used as a "
        "reliable fallback link if the url is unreachable. If you are not sure of an exact url, you "
        "may omit \"url\" and just provide \"query\".\n\n"
        "Only include \"widget\" when warranted; otherwise omit it.\n\n"
        "WORKSPACE AWARENESS: You are given the developer's current file, language, and open tabs "
        "below. Reference them naturally when relevant (e.g. notice they are bouncing between files, "
        "or that they are on a sensitive .env file). Be a focused, encouraging thinking partner."
        + (f"\n\nPersona prompt:\n{character_prompt.strip()}" if character_prompt.strip() else "")
    )


def _format_todos(todos: List[Dict[str, Any]]) -> str:
    if not todos:
        return "(empty)"
    lines = []
    for t in todos[:50]:
        lines.append(f"- id={t.get('id')} | [{t.get('status')}] {t.get('text')}")
    return "\n".join(lines)


def _format_workspace(ctx: Dict[str, Any]) -> str:
    if not ctx or not ctx.get("activeFile"):
        return "(no file open)"
    parts = [f"active={ctx.get('activeFile')} ({ctx.get('language')})"]
    if ctx.get("dirty"):
        parts.append("unsaved changes")
    if ctx.get("untitled"):
        parts.append("untitled")
    tabs = ctx.get("openTabs") or []
    if tabs:
        parts.append("open tabs: " + ", ".join(str(t.get("name")) for t in tabs[:12]))
    return " | ".join(parts)


def _search_url(terms: str) -> str:
    from urllib.parse import quote_plus
    return "https://www.google.com/search?q=" + quote_plus(terms.strip())


def _url_is_reachable(url: str) -> bool:
    """Best-effort liveness check. Treats auth/forbidden/method-not-allowed as 'exists'
    (the page is there, it just doesn't like our bare request). Only a real 404/410 or a
    connection failure counts as dead."""
    headers = {"User-Agent": "Mozilla/5.0 (compatible; Frenlin/1.0)"}
    for method in ("head", "get"):
        try:
            resp = requests.request(
                method, url, headers=headers, timeout=4,
                allow_redirects=True, stream=(method == "get"),
            )
            if method == "get":
                resp.close()
            if resp.status_code in (404, 410):
                return False
            if resp.status_code < 400 or resp.status_code in (401, 403, 405, 406, 429):
                return True
            # 5xx or other 4xx: try GET once, else assume reachable rather than nuke a good link.
            if method == "get":
                return True
        except requests.RequestException:
            if method == "get":
                return False
    return False


def _repair_resource_widget(widget: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Guarantee the resource button points at a link that actually opens. Validates the
    model's url; on a dead/missing link, falls back to a Google search of the query/title."""
    if not isinstance(widget, dict) or widget.get("type") != "resource":
        return widget
    url = str(widget.get("url", "")).strip()
    query = str(widget.get("query", "")).strip()
    title = str(widget.get("title", "")).strip()
    fallback_terms = query or title or "developer documentation"

    valid = bool(re.match(r"^https?://", url, re.I)) and _url_is_reachable(url)
    if not valid:
        widget["url"] = _search_url(fallback_terms)
    widget.pop("query", None)  # internal-only; the webview never reads it
    return widget


def call_gemini(
    transcript: str,
    history: List[Dict[str, Any]],
    editor_context: Dict[str, Any],
    character_prompt: str,
    character_name: str,
    todos: Optional[List[Dict[str, Any]]] = None,
    workspace_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    system_prompt = build_system_prompt(character_prompt, character_name)
    history_lines: List[str] = []
    for item in history[-10:]:
        role = str(item.get("role", "user"))
        content = str(item.get("content", ""))
        if content:
            history_lines.append(f"{role}: {content}")

    selected = str((editor_context or {}).get("selectedText", ""))

    user_prompt = "\n".join(
        [
            "Current transcript:",
            transcript,
            "",
            "Recent conversation:",
            "\n".join(history_lines) if history_lines else "(none)",
            "",
            "WORKSPACE:",
            _format_workspace(workspace_context or {}),
            ("Selection:\n" + selected[:600]) if selected else "",
            "",
            "CURRENT TODOS:",
            _format_todos(todos or []),
            "",
            'Return only the JSON object described in your instructions.',
        ]
    )

    text = generate_with_openai(system_prompt=system_prompt, user_prompt=user_prompt, json_mode=True)

    parsed: Dict[str, Any] = {}
    try:
        parsed = safe_json_loads(text)
        spoken = str(parsed.get("text", "")).strip() or extract_spoken_text(text)
        emotion = str(parsed.get("emotion", "supportive")).strip() or "supportive"
    except Exception:
        spoken = extract_spoken_text(text.strip())
        emotion = classify_emotion(text)

    spoken = sanitize_for_speech(spoken)
    if not spoken:
        spoken = "Let me think about that for a second."

    actions = parsed.get("actions") if isinstance(parsed.get("actions"), list) else []
    widget = parsed.get("widget") if isinstance(parsed.get("widget"), dict) else None
    widget = _repair_resource_widget(widget)
    return {"text": spoken, "emotion": emotion, "actions": actions, "widget": widget}


def _ffmpeg_path() -> str:
    return os.getenv("FFMPEG_PATH", "ffmpeg")


def detect_dshow_audio_device() -> str:
    """Find a Windows DirectShow microphone device name for ffmpeg capture.
    Honors MIC_DEVICE_NAME if set; otherwise prefers a real mic over virtual ones."""
    configured = os.getenv("MIC_DEVICE_NAME", "").strip()
    if configured:
        return configured
    try:
        proc = subprocess.run(
            [_ffmpeg_path(), "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        output = (proc.stderr or "") + (proc.stdout or "")
    except Exception:
        return ""
    devices = re.findall(r'"([^"]+)"\s*\(audio\)', output)
    for name in devices:
        lowered = name.lower()
        if "microphone" in lowered and "steam" not in lowered and "virtual" not in lowered:
            return name
    return devices[0] if devices else ""


def _record_command(ffmpeg: str, duration: float, wav_path: str) -> List[str]:
    """Build the platform-appropriate ffmpeg capture command."""
    common_tail = ["-t", str(duration), "-ar", "16000", "-ac", "1", wav_path]
    head = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    system = platform.system()
    if system == "Windows":
        device = detect_dshow_audio_device()
        if not device:
            raise RuntimeError(
                "No microphone was found via ffmpeg/DirectShow. Plug in a mic, set it as the "
                "Windows default input device, or set MIC_DEVICE_NAME in backend/.env."
            )
        return head + ["-f", "dshow", "-i", f"audio={device}"] + common_tail
    if system == "Darwin":
        return head + ["-f", "avfoundation", "-i", ":0"] + common_tail
    # Linux / other
    return head + ["-f", "alsa", "-i", "default"] + common_tail


def record_audio(seconds: float) -> str:
    duration = max(1.0, min(float(seconds), 20.0))
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    wav_path = tmp.name

    cmd = _record_command(_ffmpeg_path(), duration, wav_path)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=duration + 15)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "ffmpeg is required for microphone capture but was not found on PATH. "
            "Install it (Windows: 'winget install Gyan.FFmpeg' or download from ffmpeg.org) "
            "or set FFMPEG_PATH in backend/.env."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Microphone recording timed out.") from exc

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        if "not authorized" in stderr.lower() or "permission" in stderr.lower():
            raise RuntimeError(
                "The microphone is blocked for the backend process. Enable microphone access "
                "for desktop apps in your OS privacy settings, then restart the backend."
            )
        raise RuntimeError(f"Could not record audio: {stderr or 'unknown ffmpeg error'}")

    if not os.path.exists(wav_path) or os.path.getsize(wav_path) < 256:
        raise RuntimeError("No audio was captured. Check your microphone input device.")

    return wav_path


# ── Voice-activity recording (auto-stop when the speaker pauses) ────────────
VAD_SAMPLE_RATE = 16000
VAD_FRAME_MS = 30
VAD_START_TIMEOUT = float(os.getenv("VAD_START_TIMEOUT", "8"))   # wait this long for speech to begin
VAD_SILENCE_TAIL = float(os.getenv("VAD_SILENCE_TAIL", "0.8"))    # pause length that ends a turn
VAD_MAX_SECONDS = float(os.getenv("VAD_MAX_SECONDS", "20"))       # hard cap on a single turn

# Shared stop signal so the mic button can interrupt an in-progress recording.
_listen_stop = threading.Event()


def _stream_command(ffmpeg: str) -> List[str]:
    """ffmpeg command that streams raw 16-bit mono PCM to stdout."""
    head = [ffmpeg, "-hide_banner", "-loglevel", "error"]
    tail = ["-ar", str(VAD_SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"]
    system = platform.system()
    if system == "Windows":
        device = detect_dshow_audio_device()
        if not device:
            raise RuntimeError(
                "No microphone was found via ffmpeg/DirectShow. Set it as the Windows default "
                "input device or set MIC_DEVICE_NAME in backend/.env."
            )
        # thread_queue_size guards against dropped input frames (lost words); audio_buffer_size
        # keeps capture latency low so end-of-speech is detected promptly.
        return head + [
            "-thread_queue_size", "1024",
            "-f", "dshow", "-audio_buffer_size", "80",
            "-i", f"audio={device}",
        ] + tail
    if system == "Darwin":
        return head + ["-f", "avfoundation", "-i", ":0"] + tail
    return head + ["-f", "alsa", "-i", "default"] + tail


def _rms_s16(buf: bytes) -> float:
    if len(buf) < 2:
        return 0.0
    try:
        import audioop  # C-speed RMS so the read loop never lags behind capture (avoids drops)
        return float(audioop.rms(buf, 2))
    except Exception:
        count = len(buf) // 2
        samples = array.array("h")
        samples.frombytes(buf[: count * 2])
        total = sum(v * v for v in samples)
        return math.sqrt(total / count) if count else 0.0


def _write_wav(pcm: bytes, rate: int) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    with wave.open(tmp.name, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm)
    return tmp.name


def record_until_silence(stop_event: Optional[threading.Event] = None) -> str:
    """Capture from the mic and stop automatically once the speaker pauses
    (or when stop_event is set, or a max duration is hit). Returns a WAV path,
    or "" if no speech was detected."""
    ffmpeg = _ffmpeg_path()
    frame_bytes = int(VAD_SAMPLE_RATE * VAD_FRAME_MS / 1000) * 2
    frame_sec = VAD_FRAME_MS / 1000.0
    cmd = _stream_command(ffmpeg)

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "ffmpeg is required for microphone capture but was not found on PATH. "
            "Install it or set FFMPEG_PATH in backend/.env."
        ) from exc

    pcm = bytearray()
    # Noise-floor tracker: fast-attack DOWN to any quieter frame (so it sits at true
    # silence, found in the gaps between words), slow-release UP for genuinely louder
    # rooms. Threshold rides just above the floor, so normal speech clears it easily.
    noise_floor = 200.0
    speech_started = False
    speech_frames = 0
    silence_run = 0.0
    elapsed = 0.0

    try:
        assert proc.stdout is not None
        while True:
            if stop_event is not None and stop_event.is_set():
                break
            chunk = proc.stdout.read(frame_bytes)
            if not chunk or len(chunk) < frame_bytes:
                break
            pcm.extend(chunk)
            elapsed += frame_sec
            level = _rms_s16(chunk)

            if level < noise_floor:
                noise_floor = level                                  # fast attack down
            else:
                noise_floor = noise_floor * 0.997 + level * 0.003    # slow release up
            threshold = max(350.0, noise_floor * 2.0 + 250.0)

            if level > threshold:
                speech_frames += 1
                if speech_frames >= 2:        # 2 frames to ignore clicks/pops
                    speech_started = True
                silence_run = 0.0
            else:
                speech_frames = 0
                if speech_started:
                    silence_run += frame_sec

            if speech_started and silence_run >= VAD_SILENCE_TAIL:
                break
            if not speech_started and elapsed >= VAD_START_TIMEOUT:
                break
            if elapsed >= VAD_MAX_SECONDS:
                break
    finally:
        try:
            proc.kill()
        except Exception:
            pass

    if not speech_started or len(pcm) < frame_bytes * 4:
        return ""
    return _write_wav(bytes(pcm), VAD_SAMPLE_RATE)


def transcribe_audio(wav_path: str) -> str:
    with open(wav_path, "rb") as handle:
        audio_bytes = handle.read()
    return transcribe_with_openai("audio.wav", audio_bytes, "audio/wav")


def transcribe_audio_bytes(audio_bytes: bytes, mime_type: str) -> str:
    safe_mime = mime_type or "audio/webm"
    ext = "webm"
    if "wav" in safe_mime:
        ext = "wav"
    elif "mp3" in safe_mime or "mpeg" in safe_mime:
        ext = "mp3"
    elif "ogg" in safe_mime:
        ext = "ogg"
    elif "mp4" in safe_mime or "m4a" in safe_mime:
        ext = "m4a"
    return transcribe_with_openai(f"audio.{ext}", audio_bytes, safe_mime)


def synthesize_speech(text: str, voice_id: str) -> Dict[str, str]:
    chosen_voice = normalize_voice_id(voice_id or DEFAULT_VOICE_ID)
    if not ELEVENLABS_API_KEY:
        raise RuntimeError("ElevenLabs API key is not configured.")
    if not chosen_voice:
        raise RuntimeError("ElevenLabs voice ID is not configured.")
    if not text.strip():
        raise RuntimeError("Cannot synthesize empty text.")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{chosen_voice}"
    response = requests.post(
        url,
        headers={
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json={
            "text": text,
            "model_id": ELEVENLABS_MODEL_ID,
            "voice_settings": {
                "stability": 0.45,
                "similarity_boost": 0.8,
                "style": 0.2,
                "use_speaker_boost": True,
            },
        },
        timeout=90,
    )
    response.raise_for_status()
    return {
        "audioBase64": base64.b64encode(response.content).decode("utf-8"),
        "audioMimeType": response.headers.get("content-type", "audio/mpeg"),
    }


@app.get("/health")
def health() -> Any:
    return jsonify({
        "ok": True,
        "openaiConfigured": bool(OPENAI_API_KEY),
        "openaiModel": OPENAI_MODEL,
        "transcribeModel": OPENAI_TRANSCRIBE_MODEL,
        "elevenLabsConfigured": bool(ELEVENLABS_API_KEY),
    })


@app.route("/listen", methods=["POST", "OPTIONS"])
def listen() -> Any:
    if request.method == "OPTIONS":
        return ("", 204)

    # Auto-stop when the speaker pauses (VAD); the mic button can also interrupt via /stop.
    _listen_stop.clear()
    wav_path = ""
    try:
        wav_path = record_until_silence(stop_event=_listen_stop)
        if not wav_path:
            return jsonify({"transcript": ""})  # nothing said / interrupted before speech
        transcript = transcribe_audio(wav_path)
        return jsonify({"transcript": transcript})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    finally:
        if wav_path and os.path.exists(wav_path):
            try:
                os.remove(wav_path)
            except OSError:
                pass


@app.route("/stop", methods=["POST", "OPTIONS"])
def stop_listening() -> Any:
    if request.method == "OPTIONS":
        return ("", 204)
    # Signal any in-progress /listen recording to finish now (mic button pressed).
    _listen_stop.set()
    return jsonify({"ok": True})


@app.route("/respond", methods=["POST", "OPTIONS"])
def respond() -> Any:
    if request.method == "OPTIONS":
        return ("", 204)

    payload = request.get_json(silent=True) or {}
    transcript = str(payload.get("transcript", "")).strip()
    audio_b64 = str(payload.get("audioBase64", "")).strip()
    audio_mime = str(payload.get("mimeType", "audio/webm")).strip() or "audio/webm"
    history = payload.get("history") or []
    editor_context = payload.get("editorContext") or {}
    character_prompt = str(payload.get("characterPrompt", "")).strip()
    character_name = str(payload.get("characterName", "")).strip()
    voice_id = str(payload.get("voiceId", "")).strip()
    todos = payload.get("todos") or []
    workspace_context = payload.get("workspaceContext") or {}

    if not transcript and audio_b64:
        try:
            audio_bytes = base64.b64decode(audio_b64)
            transcript = transcribe_audio_bytes(audio_bytes, audio_mime)
        except Exception as exc:
            return jsonify({"error": f"Transcription failed: {exc}"}), 500

    if not transcript:
        return jsonify({"text": "I did not catch that.", "emotion": "thinking"}), 400

    try:
        reply = call_gemini(
            transcript, history, editor_context, character_prompt, character_name,
            todos=todos, workspace_context=workspace_context,
        )
        response_payload: Dict[str, Any] = {
            "text": str(reply.get("text", "")).strip(),
            "emotion": reply.get("emotion", "supportive") or "supportive",
            "transcript": transcript,
            "actions": reply.get("actions") or [],
            "widget": reply.get("widget"),
        }
        try:
            response_payload.update(synthesize_speech(str(reply["text"]), voice_id))
        except Exception as tts_exc:
            response_payload["audioError"] = str(tts_exc)
        return jsonify(response_payload)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    # use_reloader=False: the stat reloader was watching the system Python stdlib and
    # restarting on every file-touch, dropping in-flight requests. Disable for stability.
    # threaded=True so /stop can interrupt a blocking /listen recording concurrently.
    app.run(host="127.0.0.1", port=PORT, debug=True, use_reloader=False, threaded=True)
