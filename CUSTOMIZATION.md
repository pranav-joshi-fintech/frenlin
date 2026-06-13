# MommyASMR.ai — Customization Guide

Everything you need to plug in real assets, voices, and API keys.

---

## 1. API Keys — `config/keys.env`

Open `config/keys.env` and fill in your keys:

```env
# Claude (AI responses) — https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-...

# ElevenLabs (voice synthesis) — https://elevenlabs.io/
# Leave blank to run in text-only mode
ELEVENLABS_API_KEY=...

# ElevenLabs voice IDs per character
# Find them at: https://elevenlabs.io/voice-lab → click a voice → copy ID from URL
AURORA_VOICE_ID=...
KAI_VOICE_ID=...
SAGE_VOICE_ID=...
```

> **Never commit `keys.env` to git.** It's already in `.gitignore`.

---

## 2. Adding/Replacing Character Art — `characters/<name>/emotions/`

Each character has its own folder:

```
characters/
  aurora/
    emotions/
      happy.png       ← shown for [happy] responses
      sad.png         ← shown for [sad] responses
      angry.png       ← shown for [angry] responses
      surprised.png   ← triggers shake animation
      supportive.png  ← triggers glow pulse animation
      thinking.png    ← shown while waiting for AI
    prompt.txt        ← personality & system prompt
  kai/
    emotions/  ...
    prompt.txt
  sage/
    emotions/  ...
    prompt.txt
```

**Supported formats:** `.png`, `.gif`, `.jpg`, `.jpeg`, `.svg`, `.webp`

**Size:** 300×300px recommended. The frame is 200×200px display size.
**GIFs work** — great for a 1–2 second surprised/happy loop.

The filename (without extension) is the emotion name. You can add custom emotions
(e.g. `excited.png`) as long as your `prompt.txt` tells Claude to use `[excited]`.

---

## 3. Editing Character Personalities — `characters/<name>/prompt.txt`

Each `prompt.txt` is the full system prompt sent to Claude for that character.

**Required format rules** (Claude needs these to work correctly):

```
RESPONSE FORMAT: Always start with an emotion tag on its own line, then your response.
Valid emotions: [happy] [sad] [angry] [surprised] [supportive] [thinking]

RESPONSE LENGTH: 2-4 sentences maximum.
```

Keep this block in every prompt. Customize everything else freely — personality,
backstory, speech patterns, pet names, areas of expertise.

---

## 4. Adding a New Character

1. Create folder: `characters/yourname/`
2. Create folder: `characters/yourname/emotions/`
3. Drop in your art files: `happy.png`, `sad.png`, etc.
4. Write `characters/yourname/prompt.txt`
5. Add accent color in `src/extension.ts` → `ACCENT_MAP`:
   ```ts
   const ACCENT_MAP: Record<string, string> = {
     aurora: '#d4537e',
     kai:    '#378add',
     sage:   '#1d9e75',
     yourname: '#your-hex-color',   // ← add this
   };
   ```
6. Add ElevenLabs voice ID in `config/keys.env`:
   ```env
   YOURNAME_VOICE_ID=...
   ```
   And reference it in `VOICE_MAP` in `src/extension.ts`:
   ```ts
   yourname: cfg['YOURNAME_VOICE_ID'] || '',
   ```
7. Run `npm run compile` and reload the extension.

The character will automatically appear in the voice dropdown.

---

## 5. Changing Accent Colors

Each character's accent color controls:
- The waveform color
- The emotion status text
- The dialogue box top border
- The mute button glow
- The active profile indicator in the dropdown

Edit `ACCENT_MAP` in `src/extension.ts`.

---

## 6. First-Time Setup (full flow)

```bash
cd mommyasmr-ai
npm install
npm run compile
```

Then in VS Code: press `F5` to open the Extension Development Host.
The panel opens in the bottom panel area by default. Drag it to the right side
via View → Move Panel Right, or drag the tab.

Press `Ctrl+Shift+M` to open/focus the companion from anywhere.
