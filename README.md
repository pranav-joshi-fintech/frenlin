# MommyASMR.ai — VS Code Companion Extension

> Bringing personality and calm to an otherwise rage-inducing industry.

A voice-to-voice AI coding companion that lives in your VS Code sidebar. Talk through your bugs, frustrations, and coding anxieties — and receive warm, grounding support back.

Mental Optimization and Motivation Middleware for You
---

## Features

- **Voice-to-Voice** — speak your problem, hear a supportive response
- **3 Companion Profiles** with distinct personalities and color themes:
  - **Aurora** — warm, nurturing, soft (pink accent)
  - **Kai** — calm, measured, steady (blue accent)
  - **Sage** — grounded, witty, real (teal accent)
- **Dynamic Avatar** — hand-drawn characters that express emotions
- **Live Waveform Visualizer** — reacts to your voice in real time
- **Editor Context** — send selected code directly to your companion
- **Conversation History** — persistent sessions, resumable anytime

---

## Setup

### 1. Install dependencies

```bash
npm install
npm run compile
```

### 2. Add your API key

The extension uses the Anthropic Claude API for AI responses.

Open VS Code settings (`Ctrl+,`) and search for `mommyasmr`. Set:

```
mommyasmr.apiKey: YOUR_ANTHROPIC_API_KEY
```

Or set it via environment variable before launching VS Code:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

> **Note:** The webview reads the key from VS Code settings via the extension host. Update `src/webview.ts` → `callCompanionAI()` to inject it from the backend for production security.

### 3. Run the extension

Press `F5` in VS Code to launch the Extension Development Host.

Click the headphone icon in the Activity Bar to open the companion panel.

---

## Voice profiles

| Profile | Accent | Personality |
|---------|--------|-------------|
| Aurora  | Pink `#d4537e` | Warm, nurturing, endearing |
| Kai     | Blue `#378add` | Calm, steady, composed |
| Sage    | Teal `#1d9e75` | Grounded, witty, real |

Switching profiles changes: avatar art, color accent, waveform color, and AI personality prompt.

---

## Controls

| Button | Action |
|--------|--------|
| `+` | New conversation |
| 🗑 | Delete current conversation |
| ☰ | Open/close conversation history |
| Mic button | Start/stop voice input |
| `<>` | Send selected editor code as context |
| `‹ ›` | Flip through previous advice |
| A / K / S | Switch to Aurora / Kai / Sage profile |

---

## Adding real avatars

Replace the canvas-drawn avatars with PNG assets per profile:

```
media/
  profiles/
    aurora/
      happy.png
      thinking.png
      caring.png
      calm.png
      playful.png
      surprised.png
      ready.png
    kai/
      (same filenames)
    sage/
      (same filenames)
```

In `src/webview.ts`, the `drawAvatar()` function can be updated to load image assets instead of rendering to canvas.

---

## Architecture

```
mommyasmr-ai/
├── src/
│   ├── extension.ts        — activation, commands, CompanionViewProvider
│   ├── companionPanel.ts   — standalone editor panel (optional)
│   ├── conversationStore.ts — persistent conversation history
│   └── webview.ts          — full frontend (voice, UI, AI, avatar)
├── media/
│   ├── companion.css       — all styles
│   └── icons/
│       └── sidebar-icon.svg
├── package.json            — extension manifest
└── tsconfig.json
```

---

## Extending

- **Add TTS:** Integrate ElevenLabs or Web Speech API's `SpeechSynthesis` in `webview.ts` after receiving an AI response
- **Add more profiles:** Copy a profile object in `PROFILES`, add its drawXxxAvatar function
- **Custom avatars:** Replace canvas drawing with `<img>` tags swapped on emotion change
- **Mood detection:** Parse the `[emotion]` tag from AI responses to trigger GIF overlays

---

## Philosophy

Coding is hard. Imposter syndrome is real. Debugging at 2am is a special kind of lonely.

MommyASMR.ai doesn't solve your code for you — it helps you calm down enough to solve it yourself.

The name is intentionally a bit silly. That's the point.

---

*Built with TypeScript, VS Code Extension API, Web Speech API, Canvas 2D, and the Anthropic Claude API.*
