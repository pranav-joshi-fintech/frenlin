import base64
import json
import os
import re
import subprocess
import tempfile
import time
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
    if json_mode:
        base_kwargs["response_mime_type"] = "application/json"

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
            text = (response.text or "").strip()
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
        f"You are {role}, a voice-reactive VS Code companion. "
        "Reply with ONLY a single JSON object and nothing else — no preamble, no "
        "explanation, no 'here is the JSON', no markdown fences. "
        'The JSON schema is {"text":"...","emotion":"happy|sad|angry|surprised|supportive|thinking|concerned"}. '
        "The \"text\" value will be read aloud by a text-to-speech voice, so it MUST be "
        "one to three natural spoken sentences of plain English. In \"text\" do NOT use "
        "emojis, emoticons (like :) or :D), markdown, asterisks, backticks, code blocks, "
        "bullet points, URLs, file paths, or any symbols a person would not say out loud. "
        "Spell things out as words. Put the feeling in the \"emotion\" field, not in symbols."
        + (f"\n\nPersona prompt:\n{character_prompt.strip()}" if character_prompt.strip() else "")
    )


def call_gemini(
    transcript: str,
    history: List[Dict[str, Any]],
    editor_context: Dict[str, Any],
    character_prompt: str,
    character_name: str,
) -> Dict[str, str]:
    system_prompt = build_system_prompt(character_prompt, character_name)
    history_lines: List[str] = []
    for item in history[-10:]:
        role = str(item.get("role", "user"))
        content = str(item.get("content", ""))
        if content:
            history_lines.append(f"{role}: {content}")

    editor_parts: List[str] = []
    if editor_context.get("fileName"):
        editor_parts.append(f"file={editor_context['fileName']}")
    if editor_context.get("language"):
        editor_parts.append(f"language={editor_context['language']}")
    if editor_context.get("selectedText"):
        selected = str(editor_context["selectedText"])
        editor_parts.append(f"selection={selected[:600]}")

    user_prompt = "\n".join(
        [
            "Current transcript:",
            transcript,
            "",
            "Recent conversation:",
            "\n".join(history_lines) if history_lines else "(none)",
            "",
            "Editor context:",
            " | ".join(editor_parts) if editor_parts else "(none)",
            "",
            'Return only JSON with keys "text" and "emotion".',
        ]
    )

    text = generate_with_gemini(system_prompt=system_prompt, user_prompt=user_prompt, json_mode=True)

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
    return {"text": spoken, "emotion": emotion}


def record_audio(seconds: float) -> str:
    duration = max(1.0, min(float(seconds), 20.0))
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    wav_path = tmp.name

    ffmpeg = "ffmpeg"
    # macOS default input device via avfoundation
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "avfoundation",
        "-i",
        ":0",
        "-t",
        str(duration),
        "-ar",
        "16000",
        "-ac",
        "1",
        wav_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=duration + 15)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "ffmpeg is required for microphone capture. Install it with: brew install ffmpeg"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Microphone recording timed out.") from exc

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        if "not authorized" in stderr.lower() or "permission" in stderr.lower():
            raise RuntimeError(
                "Microphone permission denied for the backend process. On macOS open "
                "System Settings → Privacy & Security → Microphone and enable access for "
                "Terminal (or Cursor/VS Code if you start the backend from the integrated terminal), "
                "then restart the backend."
            )
        raise RuntimeError(f"Could not record audio: {stderr or 'unknown ffmpeg error'}")

    if not os.path.exists(wav_path) or os.path.getsize(wav_path) < 256:
        raise RuntimeError("No audio was captured. Check your microphone input device.")

    return wav_path


def transcribe_audio(wav_path: str) -> str:
    from google.genai import types

    with open(wav_path, "rb") as handle:
        audio_bytes = handle.read()

    client = get_gemini_client()
    prompt = (
        "Transcribe the spoken English in this clip. "
        "Return only the transcript text with no quotes or commentary."
    )

    last_error: Optional[Exception] = None
    for model in gemini_models_to_try():
        try:
            response = client.models.generate_content(
                model=model,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(data=audio_bytes, mime_type="audio/wav"),
                            types.Part.from_text(text=prompt),
                        ],
                    )
                ],
            )
            transcript = (response.text or "").strip()
            if transcript:
                return transcript
            raise RuntimeError("Gemini returned an empty transcript.")
        except Exception as exc:
            last_error = exc
            continue

    raise RuntimeError(format_gemini_error(last_error or RuntimeError("Transcription failed.")))


def transcribe_audio_bytes(audio_bytes: bytes, mime_type: str) -> str:
    from google.genai import types

    safe_mime = mime_type if mime_type else "audio/webm"
    client = get_gemini_client()
    prompt = (
        "Transcribe the spoken English in this audio clip. "
        "Return only the transcript text with no quotes, labels, or commentary."
    )
    last_error: Optional[Exception] = None
    for model in gemini_models_to_try():
        try:
            response = client.models.generate_content(
                model=model,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(data=audio_bytes, mime_type=safe_mime),
                            types.Part.from_text(text=prompt),
                        ],
                    )
                ],
            )
            transcript = (response.text or "").strip()
            if transcript:
                return transcript
            raise RuntimeError("Gemini returned an empty transcript.")
        except Exception as exc:
            last_error = exc
            continue

    raise RuntimeError(format_gemini_error(last_error or RuntimeError("Transcription failed.")))


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
    key_type = "missing"
    if GEMINI_API_KEY.startswith("AQ."):
        key_type = "auth"
    elif GEMINI_API_KEY.startswith("AIza"):
        key_type = "standard"
    elif GEMINI_API_KEY:
        key_type = "unknown"

    return jsonify({
        "ok": True,
        "geminiConfigured": bool(GEMINI_API_KEY),
        "geminiKeyType": key_type,
        "geminiModel": GEMINI_MODEL,
        "elevenLabsConfigured": bool(ELEVENLABS_API_KEY),
    })


@app.route("/listen", methods=["POST", "OPTIONS"])
def listen() -> Any:
    if request.method == "OPTIONS":
        return ("", 204)

    payload = request.get_json(silent=True) or {}
    duration = float(payload.get("duration", LISTEN_SECONDS))

    wav_path = ""
    try:
        wav_path = record_audio(duration)
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

    if not transcript and audio_b64:
        try:
            audio_bytes = base64.b64decode(audio_b64)
            transcript = transcribe_audio_bytes(audio_bytes, audio_mime)
        except Exception as exc:
            return jsonify({"error": f"Transcription failed: {exc}"}), 500

    if not transcript:
        return jsonify({"text": "I did not catch that.", "emotion": "thinking"}), 400

    try:
        reply = call_gemini(transcript, history, editor_context, character_prompt, character_name)
        response_payload: Dict[str, Any] = {
            "text": reply.get("text", "").strip(),
            "emotion": reply.get("emotion", "supportive") or "supportive",
            "transcript": transcript,
        }
        try:
            response_payload.update(synthesize_speech(reply["text"], voice_id))
        except Exception as tts_exc:
            response_payload["audioError"] = str(tts_exc)
        return jsonify(response_payload)
    except Exception as exc:
        return jsonify({"error": format_gemini_error(exc)}), 500


if __name__ == "__main__":
    # use_reloader=False: the stat reloader was watching the system Python stdlib and
    # restarting on every file-touch, dropping in-flight requests. Disable for stability.
    app.run(host="127.0.0.1", port=PORT, debug=True, use_reloader=False)
