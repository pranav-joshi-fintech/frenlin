# Frenlin — Your AI Conversationalist Aid

> A voice-to-voice coding companion. Direct, intense, occasionally unhinged, and weirdly, genuinely supportive.

Most AI tools wait politely for you to type. This one *talks back*. Speak your bugs, your frustrations, and your 2 AM existential dread out loud — and get a real spoken response with attitude. It tracks your todos, calls you out when you doomscroll between tabs, and yells at you when you've been staring at your `.env` for half a minute like it's going to fix itself.

It's not a copilot. It's a thinking and productivity partner that happens to have opinions.

Powered by **ChatGPT** for the brains and **ElevenLabs** for the voice.

---

## Features

### 🎙️ Conversational Voice (no buttons, just talk)
Real back-and-forth — not push-to-talk. It listens, detects when you've naturally stopped speaking, and responds out loud. Mute whenever you want; it shuts up immediately. (Type it instead if your mic is being dramatic.)

### ✅ Todo Tracker Widget
A persistent task board that lives right in the panel. Just *say* what you need:
- *"Add fix the auth bug to my list"* → it's on there
- *"Move the deploy task to in progress"* → done
- *"Mark the login refactor complete"* → boom, finished

Tasks persist across restarts, show how long they've been sitting there (*"2 hours ago"* — no judgment... mostly), and you can click to cycle status or delete manually.

### 👀 Focus Enforcement
Flick between tabs more than 5 times in 15 seconds without actually *editing* anything? You'll hear about it. In character. It backs off for 5 minutes after — it's a partner, not a nag.

### 🔐 `.env` Safety Intervention
Sit motionless on a `.env` file for 30 seconds and your companion gets... concerned. Those are live secrets. It'll snap you out of it (once per visit — no spam).

### 🧠 Workspace Awareness
It knows your active file, language, open tabs, and whether you've got unsaved changes — and references them naturally. *"You've been buried in `webview.ts` for a while, huh?"*

### 🎉 Celebration & Resource Widgets
- Squash a hard bug or finish a task → confetti, on the house (plays a few times, then politely steps aside)
- Ask for docs or a tutorial → a tidy resource card with a button that **actually opens a working link** (validated server-side, with a smart search fallback so you never hit a dead 404)

### 🎭 The Classics
- **Companion Profiles** — Vegeta, Frieren, Zoey, each with their own energy
- **Dynamic Avatar** — character art that emotes with the conversation
- **Live Waveform** — reacts to whoever's talking
- **Conversation History** — persistent, resumable sessions

---

## Setup

### 1. Install dependencies

```bash
npm install
npm run compile
```

### 2. Configure API keys

Copy the example env files and add your keys:

```bash
cp backend/.env.example backend/.env
cp config/keys.env.example config/keys.env
```

Edit `backend/.env`:

```env
OPENAI_API_KEY=your-openai-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key
VEGETA_VOICE_ID=your-elevenlabs-voice-id
```

Get an OpenAI API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

> ChatGPT (`gpt-4o-mini`) handles the responses **and** transcription (via Whisper) — one key covers the brains, ears, and the URL-validating resource cards.

### 3. Start the backend

```bash
cd backend
./start.sh
```

Or manually:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

**Important:** If you previously had a `frenlin` venv (or an older `mommyasmr-ai` / `vegetaasmr-ai` one), delete `backend/.venv` and recreate it (the old venv may point to the wrong path).

The server runs at `http://127.0.0.1:5001`.

### 4. Run the extension

Press `F5` in VS Code to launch the Extension Development Host.

Click the sidebar icon to open the companion panel, then **just start talking** — it listens automatically.

Voice capture runs through the **Python backend** (not the VS Code webview). On macOS, grant Microphone access to **Terminal** or **Cursor** in System Settings → Privacy & Security → Microphone, then restart the backend. Use the command **Open Microphone Settings** to jump there quickly.

If voice doesn't cooperate, just type in the text box below the dialogue. The companion won't hold it against you.

---

## Architecture

```
frenlin/
├── backend/
│   └── app.py                      — Flask API (ChatGPT + Whisper + ElevenLabs)
├── src/
│   ├── extension.ts                — activation, webview provider, service wiring
│   ├── conversationStore.ts        — persistent conversation history
│   ├── webview.ts                  — UI, voice, waveform, widget stack
│   └── services/
│       ├── todoManager.ts          — todo CRUD + persistence
│       ├── workspaceContext.ts     — active file / language / tab awareness
│       ├── focusMonitor.ts         — tab-switching focus enforcement
│       └── envMonitor.ts           — .env safety intervention
├── characters/
│   └── vegeta/                     — prompt + emotion art
├── config/
│   └── keys.env                    — extension-side keys (gitignored)
└── media/
    └── companion.css
```

The AI replies with a single structured JSON object — spoken text, an emotion, optional todo `actions`, and an optional `widget` — so one round-trip can talk, manage your list, and drive the UI at once.

---

## Controls

Mostly you just talk. But for the manual moments:

| Control | Action |
|---------|--------|
| Mic | Mute / unmute listening |
| Send | Send a typed message |
| Todo item | Click to cycle status • ✕ to delete |
| `+` | New conversation |
| ☰ | Conversation history |
| Voice dropdown | Switch character profile |

Press `Cmd+Shift+M` (Mac) or `Ctrl+Shift+M` to focus the companion panel.

---

*Built with TypeScript, the VS Code Extension API, the Web Audio API, Flask, ChatGPT (OpenAI), Whisper, and ElevenLabs — and a slightly concerning amount of personality.*
