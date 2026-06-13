# Vegeta ASMR — Customization Guide

Everything you need to plug in real assets, voices, and API keys.

---

## 1. API Keys

Keys live in two places (both gitignored):

| File | Used by |
|------|---------|
| `backend/.env` | Flask server (Gemini + ElevenLabs) |
| `config/keys.env` | VS Code extension (voice IDs, backend URL) |

Copy the examples:

```bash
cp backend/.env.example backend/.env
cp config/keys.env.example config/keys.env
```

Fill in:

```env
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
VEGETA_VOICE_ID=...
FRIERAN_VOICE_ID=...
ZOEY_VOICE_ID=...
VEGETAASMR_BACKEND_URL=http://127.0.0.1:5001/respond
```

---

## 2. Character Art — `characters/<name>/emotions/`

```
characters/
  vegeta/
    emotions/
      happy.svg
      sad.svg
      angry.svg
      ...
    prompt.txt
```

Supported formats: `.png`, `.gif`, `.jpg`, `.jpeg`, `.svg`, `.webp`

---

## 3. Character Personalities — `characters/<name>/prompt.txt`

Each `prompt.txt` is sent to Gemini as the persona for that character.

---

## 4. Adding a New Character

1. Create `characters/yourname/emotions/` with art files
2. Write `characters/yourname/prompt.txt`
3. Add accent color and voice ID in `src/extension.ts` (`ACCENT_MAP`, `VOICE_MAP`)
4. Add `YOURNAME_VOICE_ID=...` to `config/keys.env` and `backend/.env`
5. Run `npm run compile` and reload the extension

---

## 5. First-Time Setup

```bash
cd vegetaasmr-ai
npm install
npm run compile
cd backend && pip install -r requirements.txt && python app.py
```

Press `F5` in VS Code, open the Vegeta ASMR sidebar, and click the mic button to start talking.
