# MOMMY ASMR — Workflow & Architecture

A voice-to-voice AI coding companion. There are three runtime pieces:

1. **Webview** (browser sandbox) — the UI: avatar, waveform, chat, todo board, widgets, audio playback.
2. **Extension Host** (Node) — owns VS Code state, proxies network calls (avoids webview CORS), tracks todos/workspace/focus/.env.
3. **Flask Backend** (Python) — records the mic, transcribes (Whisper), generates the reply (OpenAI), and synthesizes voice (ElevenLabs).

---

## 1. Component / Architecture Map

```mermaid
graph TB
    subgraph Webview["🖥️ Webview (sandboxed UI) — webview.ts"]
        UI["Avatar · Waveform · Chat · Todo board · Resource/Celebration widgets"]
        Mic["Mic button / Text input"]
        Audio["AudioContext playback (TTS)"]
    end

    subgraph Host["⚙️ Extension Host (Node) — extension.ts"]
        Provider["CompanionViewProvider<br/>(message router + network proxy)"]
        Store["ConversationStore<br/>(globalState)"]
        Todos["TodoManager<br/>(globalState)"]
        WS["WorkspaceContextService<br/>(active file, tabs, dirty)"]
        Focus["FocusMonitor<br/>(tab-thrash detector)"]
        Env["EnvMonitor<br/>(.env dwell timer)"]
    end

    subgraph Backend["🐍 Flask Backend — app.py"]
        Listen["/listen — ffmpeg VAD record"]
        Stop["/stop — interrupt recording"]
        Respond["/respond — generate reply + TTS"]
        Health["/health"]
    end

    subgraph Ext["☁️ External APIs"]
        Whisper["OpenAI Whisper (STT)"]
        GPT["OpenAI Chat (reply JSON)"]
        Eleven["ElevenLabs (TTS)"]
    end

    Files["📁 characters/ (prompts + emotion art)<br/>config/keys.env · backend/.env · quotes.txt"]

    Mic -->|postMessage| Provider
    UI -->|postMessage| Provider
    Provider -->|postMessage| UI
    Provider --> Audio

    Provider <-->|HTTP proxy| Listen
    Provider <-->|HTTP proxy| Respond
    Provider -->|HTTP| Stop

    Listen --> Whisper
    Respond --> Whisper
    Respond --> GPT
    Respond --> Eleven

    Provider -.reads.- Files
    Provider --- Store
    Provider --- Todos
    Provider --- WS
    Focus -.fires.-> Provider
    Env -.fires.-> Provider
```

---

## 2. Voice Conversation Flow (a single turn)

```mermaid
sequenceDiagram
    actor User
    participant W as Webview
    participant H as Extension Host
    participant B as Flask Backend
    participant AI as OpenAI
    participant EL as ElevenLabs

    User->>W: Tap mic (or type)
    W->>H: startBackendListen
    H->>B: POST /listen
    B->>B: ffmpeg captures until pause (VAD)
    B->>AI: Whisper transcription
    AI-->>B: transcript text
    B-->>H: { transcript }
    H-->>W: sttResult

    W->>H: sendTranscript (transcript, history, editorContext)
    Note over H: Inject authoritative<br/>todos + workspace snapshot
    H->>B: POST /respond
    B->>B: build_system_prompt(persona)
    B->>AI: Chat completion (JSON mode)
    AI-->>B: { text, emotion, actions, widget }
    B->>B: sanitize text · validate resource URL
    B->>EL: synthesize_speech(text, voiceId)
    EL-->>B: MP3 (base64)
    B-->>H: { text, emotion, audio, actions, widget }

    Note over H: Apply todo actions →<br/>broadcast updated list
    H-->>W: backendResponse
    W->>W: setEmotion(avatar) · render widgets
    W->>User: 🔊 Play voice + show reply
    W->>H: saveMessage (persist turn)
```

---

## 3. Proactive Interventions (the companion speaks unprompted)

Two background monitors in the extension host nudge the user in-character without any mic input.

```mermaid
flowchart TD
    subgraph Triggers
        F["FocusMonitor:<br/>>5 tab switches in 15s<br/>with no edits"]
        E["EnvMonitor:<br/>30s idle on a .env file"]
    end

    F -->|cooldown 5 min| INT
    E -->|once per visit| INT
    INT["_intervene(kind)"] -->|trigger 'intervention'| WV["Webview"]
    WV --> DIR["Build in-character directive<br/>(focus nudge / .env warning)"]
    DIR -->|sendTranscript directive=true| H["Extension Host"]
    H -->|/respond| BK["Backend → OpenAI → ElevenLabs"]
    BK -->|spoken reply| WV2["Webview speaks it aloud"]
```

---

## Key design notes

- **Why proxy through the host?** The webview CSP sets `connect-src 'none'` — it can't make network calls. The extension host owns all HTTP to Flask, and is also the source of truth for todos and workspace state, which it injects into every `/respond`.
- **Two mic paths:** the primary path records on the **backend** via ffmpeg (`/listen`), sidestepping the unreliable webview `getUserMedia` permission layer. Raw audio can also be sent to `/respond` as a fallback.
- **Structured replies:** the model must return a single JSON object (`text`, `emotion`, optional `actions`, `widget`). Text is sanitized for TTS (no emojis/markdown/URLs) and resource-widget URLs are liveness-checked with a Google-search fallback.
- **Personas** live in `characters/<id>/` (a `prompt.txt` + emotion art); voice IDs and API keys come from `config/keys.env` / `backend/.env`.
