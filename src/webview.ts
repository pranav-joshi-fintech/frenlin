// ── MommyASMR.ai webview — complete frontend ──────────────────────────────
// Runs in VS Code webview context (browser-like, no Node APIs)

declare function acquireVsCodeApi(): VSCodeApi;
interface VSCodeApi { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void; }

// ── Types ─────────────────────────────────────────────────────────────────
interface EmotionUris  { [emotion: string]: string }
interface CharacterMeta {
  id: string; name: string; prompt: string;
  emotions: string[]; accentColor: string; voiceId: string;
}
interface Message      { id: string; role: 'user'|'assistant'; content: string; emotion?: string; timestamp: number; }
interface Conversation { id: string; title: string; createdAt: number; updatedAt: number; messages: Message[]; }

const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────
let characters: CharacterMeta[]           = [];
let emotionUris: Record<string, EmotionUris> = {};
let activeProfileId  = 'aurora';
let conversations: Conversation[]         = [];
let currentConvoId: string|null           = null;
let currentMessages: Message[]            = [];
let adviceList: string[]                  = [];
let adviceIdx                             = 0;
let anthropicKey                          = '';
let elevenLabsKey                         = '';
let historyOpen                           = false;
let isMuted                               = false;   // starts UNMUTED = always listening
let isProcessing                          = false;
let typewriterTimer: ReturnType<typeof setInterval>|null = null;

// audio
let audioCtx: AudioContext|null           = null;
let analyser: AnalyserNode|null           = null;
let mediaStream: MediaStream|null         = null;
let recognition: InstanceType<typeof SpeechRecognition>|null = null;
let waveRaf: number|null                  = null;
let wavePhase                             = 0;
let isActuallyListening                   = false;

// ── Ambient speech API types (supplement DOM lib gaps) ───────────────────
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionError extends Event { error: string; }
declare class SpeechRecognition {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult:  ((e: SpeechRecognitionEvent) => void)|null;
  onerror:   ((e: SpeechRecognitionError) => void)|null;
  onend:     (()=>void)|null; onstart: (()=>void)|null;
  start(): void; stop(): void; abort(): void;
}
declare const webkitSpeechRecognition: typeof SpeechRecognition;

// ── DOM helpers ───────────────────────────────────────────────────────────
const el   = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const make = (tag: string, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls)  { e.className = cls; }
  if (html) { e.innerHTML = html; }
  return e;
};

// ── Root render ───────────────────────────────────────────────────────────
function renderApp(): void {
  document.getElementById('root')!.innerHTML = `
  <!-- History drawer -->
  <div id="history-panel" class="history-panel hidden">
    <div class="history-header">
      <span class="mono dim">// sessions</span>
      <button id="btn-close-hist" class="icon-btn" title="Close">✕</button>
    </div>
    <ul id="history-list" class="history-list"></ul>
    <div class="history-footer">
      <button id="btn-new-hist" class="hist-action-btn">+ New session</button>
    </div>
  </div>

  <!-- Main panel -->
  <div id="main" class="main">

    <!-- ① Top bar -->
    <div class="topbar">
      <button id="btn-hist" class="topbar-btn" title="Sessions">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3" cy="6" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/><circle cx="3" cy="18" r="1" fill="currentColor"/></svg>
      </button>
      <button id="btn-rename" class="topbar-btn" title="Rename session">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <span id="session-title" class="session-title">New session</span>
      <button id="btn-new" class="topbar-btn" title="New session">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <button id="btn-del" class="topbar-btn danger" title="Delete session">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    </div>

    <!-- ② Avatar frame (gold border, concept art style) -->
    <div id="avatar-wrap" class="avatar-wrap">
      <div id="avatar-frame" class="avatar-frame">
        <img id="avatar-img" class="avatar-img" src="" alt="companion" draggable="false"/>
        <div id="avatar-placeholder" class="avatar-placeholder">
          <div class="placeholder-icon">✦</div>
        </div>
      </div>
    </div>

    <!-- ③ Emotion status + voice selector -->
    <div class="status-row">
      <span id="emotion-tag" class="emotion-tag accent-text">// ready</span>
      <button id="btn-voice" class="voice-btn accent-btn">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        <span id="voice-label">Voice</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    </div>

    <!-- Voice dropdown (hidden by default) -->
    <div id="voice-dropdown" class="voice-dropdown hidden"></div>

    <!-- ④ Waveform -->
    <div class="wave-container">
      <canvas id="waveform" class="waveform"></canvas>
    </div>

    <!-- ⑤ Subtitle / dialogue box -->
    <div class="dialogue-box">
      <div id="dialogue" class="dialogue-text"></div>
    </div>

    <!-- ⑥ Quote / advice nav -->
    <div class="advice-row">
      <button id="btn-prev" class="adv-btn">‹</button>
      <span id="adv-counter" class="adv-counter mono dim">—</span>
      <button id="btn-next" class="adv-btn">›</button>
    </div>

    <!-- ⑦ Mute toggle (the "mic") -->
    <div class="mic-row">
      <button id="btn-mute" class="mute-btn" title="Toggle microphone">
        <svg id="ico-unmuted" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        <svg id="ico-muted" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden">
          <line x1="1" y1="1" x2="23" y2="23"/>
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
          <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        <div id="mute-ripple" class="mute-ripple"></div>
      </button>
    </div>

  </div><!-- /main -->
  `;
}

// ── Profile helpers ───────────────────────────────────────────────────────
function activeChar(): CharacterMeta|undefined {
  return characters.find(c => c.id === activeProfileId);
}

function setAccent(color: string): void {
  document.documentElement.style.setProperty('--accent', color);
  // derive subtle glow
  document.documentElement.style.setProperty('--accent-glow',
    color + '44');
}

function applyProfile(id: string): void {
  activeProfileId = id;
  const c = activeChar();
  if (!c) { return; }
  setAccent(c.accentColor);
  // refresh voice button label
  const voiceLabel = document.getElementById('voice-label');
  if (voiceLabel) { voiceLabel.textContent = c.name; }
  // mark active in dropdown if open
  document.querySelectorAll('.vd-item').forEach(btn => {
    (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.id === id);
  });
  setEmotion('ready');
}

// ── Emotion / avatar ──────────────────────────────────────────────────────
const EMOTION_LABELS: Record<string, string> = {
  happy:'happy', sad:'sad', angry:'angry',
  surprised:'surprised', supportive:'supportive', thinking:'thinking...', ready:'ready'
};

function setEmotion(emotion: string): void {
  const tag = document.getElementById('emotion-tag');
  if (tag) { tag.textContent = `// ${EMOTION_LABELS[emotion] ?? emotion}`; }

  const img = document.getElementById('avatar-img') as HTMLImageElement|null;
  const ph  = document.getElementById('avatar-placeholder');
  const frame = document.getElementById('avatar-frame');
  const char  = activeChar();

  if (img && char) {
    const uris = emotionUris[char.id] ?? {};
    const src = uris[emotion] ?? uris['happy'] ?? uris[char.emotions[0]] ?? '';
    if (src) {
      img.src = src;
      img.classList.remove('hidden');
      if (ph) { ph.classList.add('hidden'); }
    } else {
      img.classList.add('hidden');
      if (ph) { ph.classList.remove('hidden'); }
    }
  }

  // CSS animation per emotion
  if (frame) {
    frame.classList.remove('anim-shake','anim-bounce','anim-pulse','anim-wobble');
    if (emotion === 'surprised') { frame.classList.add('anim-shake'); }
    else if (emotion === 'happy') { frame.classList.add('anim-bounce'); }
    else if (emotion === 'angry') { frame.classList.add('anim-wobble'); }
    else if (emotion === 'supportive') { frame.classList.add('anim-pulse'); }
  }
}

// ── Voice dropdown ────────────────────────────────────────────────────────
function buildVoiceDropdown(): void {
  const dd = document.getElementById('voice-dropdown');
  if (!dd) { return; }
  dd.innerHTML = '';
  for (const c of characters) {
    const btn = make('button', `vd-item${c.id === activeProfileId ? ' active' : ''}`);
    btn.dataset.id = c.id;
    btn.innerHTML = `<span class="vd-dot" style="background:${c.accentColor}"></span>${c.name}`;
    btn.addEventListener('click', () => {
      applyProfile(c.id);
      vscode.postMessage({ type: 'setActiveProfile', profile: c.id });
      closeDropdown();
    });
    dd.appendChild(btn);
  }
}

function toggleDropdown(): void {
  const dd = document.getElementById('voice-dropdown');
  if (!dd) { return; }
  dd.classList.toggle('hidden');
}
function closeDropdown(): void {
  document.getElementById('voice-dropdown')?.classList.add('hidden');
}

// ── Conversation history ──────────────────────────────────────────────────
function renderHistory(): void {
  const list = document.getElementById('history-list');
  if (!list) { return; }
  list.innerHTML = '';
  for (const cv of conversations) {
    const li = make('li', `hist-item${cv.id === currentConvoId ? ' active' : ''}`);
    li.innerHTML = `
      <span class="hist-title">${esc(cv.title)}</span>
      <span class="hist-date mono dim">${fmtDate(cv.updatedAt)}</span>
    `;
    li.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectConversation', id: cv.id });
      toggleHistory(false);
    });
    list.appendChild(li);
  }
}

function toggleHistory(force?: boolean): void {
  historyOpen = force !== undefined ? force : !historyOpen;
  document.getElementById('history-panel')?.classList.toggle('hidden', !historyOpen);
}

// ── Dialogue / typewriter ─────────────────────────────────────────────────
function setDialogue(text: string, instant?: boolean): void {
  if (typewriterTimer !== null) { clearInterval(typewriterTimer); typewriterTimer = null; }
  const el2 = document.getElementById('dialogue');
  if (!el2) { return; }
  if (instant || !text) { el2.textContent = text; return; }
  el2.textContent = '';
  let i = 0;
  typewriterTimer = setInterval(() => {
    el2.textContent += text[i++];
    if (i >= text.length) { clearInterval(typewriterTimer!); typewriterTimer = null; }
  }, 20);
}

function updateAdviceNav(): void {
  const counter = document.getElementById('adv-counter');
  if (counter) { counter.textContent = adviceList.length ? `${adviceIdx + 1}/${adviceList.length}` : '—'; }
}

function showAdvice(idx2: number): void {
  if (!adviceList.length) { return; }
  adviceIdx = Math.max(0, Math.min(idx2, adviceList.length - 1));
  setDialogue(adviceList[adviceIdx]);
  updateAdviceNav();
}

// ── Waveform ──────────────────────────────────────────────────────────────
function startIdleWave(): void {
  const cv  = document.getElementById('waveform') as HTMLCanvasElement|null;
  if (!cv) { return; }
  const ctx2 = cv.getContext('2d');
  if (!ctx2) { return; }
  cv.width  = cv.offsetWidth  || 240;
  cv.height = cv.offsetHeight || 56;

  function drawIdle(): void {
    if (analyser) { return; } // live wave takes over
    const w = cv!.width, h = cv!.height;
    ctx2!.clearRect(0, 0, w, h);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d4537e';
    ctx2!.strokeStyle = accent;
    ctx2!.lineWidth = 1.8;
    ctx2!.lineCap = 'round';
    wavePhase += 0.025;
    ctx2!.beginPath();
    for (let x = 0; x <= w; x++) {
      const amp = 7 + Math.sin(x * 0.018 + wavePhase * 0.7) * 3;
      const y = h / 2 + Math.sin(x * 0.045 + wavePhase) * amp + Math.sin(x * 0.09 + wavePhase * 1.6) * 3;
      if (x === 0) { ctx2!.moveTo(x, y); } else { ctx2!.lineTo(x, y); }
    }
    ctx2!.stroke();
    waveRaf = requestAnimationFrame(drawIdle);
  }
  if (waveRaf) { cancelAnimationFrame(waveRaf); }
  drawIdle();
}

function startLiveWave(): void {
  if (!analyser) { return; }
  const cv  = document.getElementById('waveform') as HTMLCanvasElement|null;
  if (!cv) { return; }
  const ctx2 = cv.getContext('2d');
  if (!ctx2) { return; }
  cv.width  = cv.offsetWidth  || 240;
  cv.height = cv.offsetHeight || 56;
  const buf = new Uint8Array(analyser.frequencyBinCount);

  function drawLive(): void {
    if (!analyser) { startIdleWave(); return; }
    analyser.getByteTimeDomainData(buf);
    const w = cv!.width, h = cv!.height;
    ctx2!.clearRect(0, 0, w, h);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d4537e';
    ctx2!.strokeStyle = accent;
    ctx2!.lineWidth = 2;
    ctx2!.lineCap = 'round';
    ctx2!.shadowColor = accent;
    ctx2!.shadowBlur = 5;
    ctx2!.beginPath();
    const slice = w / buf.length;
    let x = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) { ctx2!.moveTo(x, y); } else { ctx2!.lineTo(x, y); }
      x += slice;
    }
    ctx2!.stroke();
    ctx2!.shadowBlur = 0;
    waveRaf = requestAnimationFrame(drawLive);
  }
  if (waveRaf) { cancelAnimationFrame(waveRaf); }
  drawLive();
}

// ── Mic / recognition lifecycle ───────────────────────────────────────────
async function startListening(): Promise<void> {
  if (isActuallyListening || isMuted) { return; }

  // Prefer to detect SpeechRecognition support before prompting for mic permission
  const SpeechRecCtor: typeof SpeechRecognition|undefined =
    (window as unknown as {SpeechRecognition?: typeof SpeechRecognition}).SpeechRecognition ??
    (window as unknown as {webkitSpeechRecognition?: typeof SpeechRecognition}).webkitSpeechRecognition ??
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

  if (!SpeechRecCtor) { return; }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // silently fail — NotAllowedError happens when no perms
    return;
  }

  audioCtx  = new AudioContext();
  analyser  = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const src = audioCtx.createMediaStreamSource(mediaStream);
  src.connect(analyser);
  startLiveWave();

  recognition = new SpeechRecCtor();
  recognition.continuous      = false;
  recognition.interimResults  = true;
  recognition.lang            = 'en-US';
  recognition.onstart = () => { isActuallyListening = true; };

  recognition.onresult = (ev: SpeechRecognitionEvent) => {
    const transcript = Array.from({ length: ev.results.length }, (_, i) => ev.results[i][0].transcript).join('');
    if (ev.results[ev.results.length - 1].isFinal) {
      stopMic();
      if (transcript.trim()) { handleUserSpeech(transcript.trim()); }
    } else {
      // Show interim transcript faintly
      const d = document.getElementById('dialogue');
      if (d) { d.innerHTML = `<span style="opacity:0.45;font-style:italic">${esc(transcript)}</span>`; }
    }
  };

  recognition.onerror = (ev: SpeechRecognitionError) => {
    if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
      console.warn('Recognition error:', ev.error);
    }
    stopMic();
    // auto-restart unless muted
    if (!isMuted) { setTimeout(() => startListening(), 600); }
  };

  recognition.onend = () => {
    isActuallyListening = false;
    stopMic();
    if (!isMuted && !isProcessing) { setTimeout(() => startListening(), 400); }
  };

  recognition.start();
}

function stopMic(): void {
  isActuallyListening = false;
  try {
    if (recognition) {
      try { recognition.stop(); } catch { /* some impls only have abort */ }
      try { recognition.abort(); } catch { /* ignore */ }
    }
  } catch { /* */ }
  recognition = null;
  try { mediaStream?.getTracks().forEach(t => t.stop()); } catch { /* */ }
  mediaStream = null;
  if (audioCtx) { try { audioCtx.close(); } catch { /* */ } audioCtx = null; }
  analyser = null;
  startIdleWave();
}

function setMuted(muted: boolean): void {
  isMuted = muted;
  const ico1 = document.getElementById('ico-unmuted');
  const ico2 = document.getElementById('ico-muted');
  const btn  = document.getElementById('btn-mute');
  const rip  = document.getElementById('mute-ripple');
  if (ico1) { ico1.classList.toggle('hidden', muted); }
  if (ico2) { ico2.classList.toggle('hidden', !muted); }
  if (btn)  { btn.classList.toggle('muted', muted); }
  if (rip)  { rip.classList.toggle('hidden', muted); }
  if (muted) { stopMic(); }
  else       { startListening(); }
}

// ── Editor context (one-shot request → response) ─────────────────────────
interface EditorContext { selectedText: string; language: string; fileName: string; }

function requestEditorContext(timeoutMs = 600): Promise<EditorContext> {
  return new Promise((resolve) => {
    const empty: EditorContext = { selectedText: '', language: '', fileName: '' };
    let done = false;
    const handler = (ev: MessageEvent) => {
      const m = ev.data as Record<string, unknown>;
      if (m && m.type === 'editorContext') {
        done = true;
        window.removeEventListener('message', handler);
        resolve({
          selectedText: (m.selectedText as string) ?? '',
          language:     (m.language     as string) ?? '',
          fileName:     (m.fileName     as string) ?? '',
        });
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getEditorContext' });
    setTimeout(() => {
      if (done) { return; }
      window.removeEventListener('message', handler);
      resolve(empty);
    }, timeoutMs);
  });
}

function buildSystemPrompt(base: string, ctx: EditorContext): string {
  if (!ctx.fileName && !ctx.selectedText) { return base; }
  const parts: string[] = [];
  if (ctx.fileName) { parts.push(`file: ${ctx.fileName}`); }
  if (ctx.language) { parts.push(`language: ${ctx.language}`); }
  if (ctx.selectedText) { parts.push(`selection:\n"""${ctx.selectedText.slice(0, 600)}"""`); }
  return `${base}\n\n[Editor context — ${parts.join(' | ')}]`;
}

// ── AI call ───────────────────────────────────────────────────────────────
async function handleUserSpeech(text: string): Promise<void> {
  if (isProcessing || !text) { return; }
  isProcessing = true;
  setEmotion('thinking');
  setDialogue(text, true); // show user text instantly

  // save user msg
  if (currentConvoId) {
    vscode.postMessage({ type: 'saveMessage', conversationId: currentConvoId, role: 'user', content: text });
  }
  currentMessages.push({ id: '', role: 'user', content: text, timestamp: Date.now() });

  const char = activeChar();
  if (!char) { isProcessing = false; return; }

  // Build history (last 10 messages)
  const history = currentMessages.slice(-10).map(m => ({ role: m.role, content: m.content }));

  try {
    const editorCtx = await requestEditorContext();
    const systemPrompt = buildSystemPrompt(char.prompt, editorCtx);
    const reply = await callClaude(systemPrompt, history);
    const { clean, emotion } = parseReply(reply);

    setEmotion(emotion);
    setDialogue(clean); // typewriter

    adviceList.push(clean);
    adviceIdx = adviceList.length - 1;
    updateAdviceNav();

    currentMessages.push({ id: '', role: 'assistant', content: clean, emotion, timestamp: Date.now() });
    if (currentConvoId) {
      vscode.postMessage({ type: 'saveMessage', conversationId: currentConvoId, role: 'assistant', content: clean, emotion });
    }

    // TTS
    if (elevenLabsKey && char.voiceId) {
      speakElevenLabs(clean, elevenLabsKey, char.voiceId).catch(() => { /* optional */ });
    }
  } catch (e) {
    setDialogue('Something went wrong — want to try again?', true);
    setEmotion('sad');
  } finally {
    isProcessing = false;
    if (!isMuted) { setTimeout(() => startListening(), 600); }
  }
}

async function callClaude(
  systemPrompt: string,
  history: Array<{role: string; content: string}>
): Promise<string> {
  if (!anthropicKey) { throw new Error('No Anthropic API key'); }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as {error?: {message: string}};
    throw new Error(e.error?.message ?? `HTTP ${res.status}`);
  }
  const d = await res.json() as {content: Array<{type: string; text: string}>};
  return d.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function speakElevenLabs(text: string, key: string, voiceId: string): Promise<void> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_monolingual_v1', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  });
  if (!res.ok) { return; }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch(() => { /* autoplay blocked */ });
  audio.onended = () => URL.revokeObjectURL(url);
}

function parseReply(text: string): { clean: string; emotion: string } {
  const m = text.match(/^\[(\w+)\]\s*\n?/);
  if (m) {
    const validEmotions = ['happy','sad','angry','surprised','supportive','thinking'];
    const emotion = validEmotions.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : 'supportive';
    return { clean: text.slice(m[0].length).trim(), emotion };
  }
  return { clean: text.trim(), emotion: 'supportive' };
}

// ── Utilities ─────────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// ── Event wiring ──────────────────────────────────────────────────────────
function bindEvents(): void {
  el('btn-hist').addEventListener('click',  () => toggleHistory());
  el('btn-close-hist').addEventListener('click', () => toggleHistory(false));
  el('btn-new-hist').addEventListener('click', () => vscode.postMessage({ type: 'newConversation' }));
  el('btn-new').addEventListener('click',   () => vscode.postMessage({ type: 'newConversation' }));
  el('btn-del').addEventListener('click',   () => {
    if (currentConvoId) { vscode.postMessage({ type: 'deleteConversation', id: currentConvoId }); }
  });
  el('btn-rename').addEventListener('click', () => {
    const title = document.getElementById('session-title')?.textContent ?? 'New session';
    vscode.postMessage({ type: 'promptRename', id: currentConvoId, current: title });
  });
  el('btn-voice').addEventListener('click', (e) => {
    e.stopPropagation();
    buildVoiceDropdown();
    toggleDropdown();
  });
  document.addEventListener('click', () => closeDropdown());
  el('btn-mute').addEventListener('click', () => setMuted(!isMuted));
  el('btn-prev').addEventListener('click', () => showAdvice(adviceIdx - 1));
  el('btn-next').addEventListener('click', () => showAdvice(adviceIdx + 1));
}

// ── VS Code message handler ───────────────────────────────────────────────
window.addEventListener('message', (ev) => {
  const msg = ev.data as Record<string, unknown>;
  switch (msg.type as string) {

    case 'init': {
      characters    = (msg.characters    as CharacterMeta[]) ?? [];
      emotionUris   = (msg.emotionUris   as Record<string, EmotionUris>) ?? {};
      anthropicKey  = (msg.anthropicKey  as string) ?? '';
      elevenLabsKey = (msg.elevenLabsKey as string) ?? '';
      conversations = (msg.conversations as Conversation[]) ?? [];
      currentConvoId = (msg.currentId    as string) ?? null;
      activeProfileId = (msg.activeProfile as string) ?? (characters[0]?.id ?? 'aurora');

      applyProfile(activeProfileId);
      renderHistory();

      // Resume the active conversation (messages + last advice/emotion)
      const cv = conversations.find(c => c.id === currentConvoId);
      const titleEl = document.getElementById('session-title');
      if (titleEl && cv) { titleEl.textContent = cv.title; }

      currentMessages = cv?.messages ?? [];
      adviceList = currentMessages.filter(m => m.role === 'assistant').map(m => m.content);
      adviceIdx = adviceList.length > 0 ? adviceList.length - 1 : 0;
      updateAdviceNav();

      if (adviceList.length > 0) {
        setDialogue(adviceList[adviceIdx], true);
        const lastEmotion = [...currentMessages].reverse().find(m => m.role === 'assistant' && m.emotion);
        setEmotion(lastEmotion?.emotion ?? 'ready');
      } else {
        setDialogue('');
        setEmotion('ready');
      }

      // Start listening immediately (unmuted by default)
      startIdleWave();
      startListening();
      break;
    }

    case 'conversationCreated': {
      conversations  = (msg.conversations as Conversation[]) ?? [];
      currentConvoId = msg.id as string;
      currentMessages = [];
      adviceList = [];
      adviceIdx  = 0;
      updateAdviceNav();
      const titleEl = document.getElementById('session-title');
      if (titleEl) { titleEl.textContent = 'New session'; }
      setDialogue('');
      setEmotion('ready');
      renderHistory();
      toggleHistory(false);
      break;
    }

    case 'conversationsUpdated': {
      conversations  = (msg.conversations as Conversation[]) ?? [];
      currentConvoId = (msg.currentId as string) ?? currentConvoId;
      const cv = conversations.find(c => c.id === currentConvoId);
      const titleEl = document.getElementById('session-title');
      if (titleEl && cv) { titleEl.textContent = cv.title; }
      renderHistory();
      break;
    }

    case 'conversationLoaded': {
      currentConvoId  = msg.id as string;
      currentMessages = (msg.messages as Message[]) ?? [];
      adviceList = currentMessages.filter(m => m.role === 'assistant').map(m => m.content);
      adviceIdx  = adviceList.length > 0 ? adviceList.length - 1 : 0;
      updateAdviceNav();
      if (adviceList.length > 0) {
        setDialogue(adviceList[adviceIdx], true);
        const lastEmotion = [...currentMessages].reverse().find(m => m.role === 'assistant' && m.emotion);
        if (lastEmotion?.emotion) { setEmotion(lastEmotion.emotion); }
      } else {
        setDialogue('');
        setEmotion('ready');
      }
      const cv = conversations.find(c => c.id === currentConvoId);
      const titleEl = document.getElementById('session-title');
      if (titleEl && cv) { titleEl.textContent = cv.title; }
      renderHistory();
      break;
    }

    case 'renameResult': {
      const id    = msg.id    as string;
      const title = msg.title as string;
      if (id && title !== undefined) {
        vscode.postMessage({ type: 'renameConversation', id, title });
        const titleEl = document.getElementById('session-title');
        if (titleEl && id === currentConvoId) { titleEl.textContent = title; }
      }
      break;
    }

    case 'triggerNew':     vscode.postMessage({ type: 'newConversation' }); break;
    case 'triggerDelete':
      if (currentConvoId) { vscode.postMessage({ type: 'deleteConversation', id: currentConvoId }); }
      break;
    case 'triggerHistory': toggleHistory(); break;
    case 'triggerProfileMenu': buildVoiceDropdown(); toggleDropdown(); break;
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────
renderApp();
bindEvents();
startIdleWave();
