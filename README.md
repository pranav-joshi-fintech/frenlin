# Vegeta ASMR — VS Code Companion Extension

> A voice-to-voice AI coding companion with Vegeta's energy — direct, intense, and weirdly supportive.

Talk through your bugs, frustrations, and coding anxieties in VS Code. Get blunt, motivating support back — with ElevenLabs voice and Gemini-powered responses.

---

## Features

- **Voice-to-Voice** — speak your problem, hear a response (or type if mic is blocked)
- **Companion Profiles** — Vegeta, Frieran, Zoey with distinct personalities
- **Dynamic Avatar** — character art that expresses emotions
- **Live Waveform** — reacts to your voice when mic access is available
- **Editor Context** — companion sees your active file and selection
- **Conversation History** — persistent sessions, resumable anytime

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
GEMINI_API_KEY=your-gemini-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key
VEGETA_VOICE_ID=your-elevenlabs-voice-id
```

Get a Gemini key at [Google AI Studio](https://aistudio.google.com/apikey).

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

**Important:** If you previously had a `mommyasmr-ai` venv, delete `backend/.venv` and recreate it (the old venv may point to the wrong path).

The server runs at `http://127.0.0.1:5001`.

### 4. Run the extension

Press `F5` in VS Code to launch the Extension Development Host.

Click the sidebar icon to open the companion panel. **Click the mic button** to start voice input.

Voice capture runs through the **Python backend** (not the VS Code webview). On macOS, grant Microphone access to **Terminal** or **Cursor** in System Settings → Privacy & Security → Microphone, then restart the backend. Use the command **Vegeta ASMR: Open Microphone Settings** to jump there quickly.

If voice doesn't work, type in the text box below the dialogue.

---

## Architecture

```
vegetaasmr-ai/
├── backend/
│   └── app.py              — Flask API (Gemini + ElevenLabs)
├── src/
│   ├── extension.ts        — activation, webview provider
│   ├── conversationStore.ts
│   └── webview.ts          — UI, voice, waveform
├── characters/
│   └── vegeta/             — prompt + emotion art
├── config/
│   └── keys.env            — extension-side keys (gitignored)
└── media/
    └── companion.css
```

---

## Controls

| Button | Action |
|--------|--------|
| Mic | Toggle voice input (click once to enable) |
| Send | Send typed message |
| `+` | New conversation |
| ☰ | Conversation history |
| Voice dropdown | Switch character profile |

Press `Cmd+Shift+M` (Mac) or `Ctrl+Shift+M` to focus the companion panel.

---

*Built with TypeScript, VS Code Extension API, Web Speech API, Flask, Gemini, and ElevenLabs.*
