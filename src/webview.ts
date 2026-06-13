// ── MOMMY ASMR webview — complete frontend ────────────────────────────────
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
let activeProfileId  = 'vegeta';
let conversations: Conversation[]         = [];
let currentConvoId: string|null           = null;
let currentMessages: Message[]            = [];
let adviceList: string[]                  = [];
let adviceIdx                             = 0;
let backendUrl                            = '';
let elevenLabsKey                         = '';
let historyOpen                           = false;
let isRecording                           = false;   // push-to-talk active
let isProcessing                          = false;
let typewriterTimer: ReturnType<typeof setInterval>|null = null;
let activeRequestId                        = '';
let ccEnabled                              = true;   // captions on by default
let quotesList: string[]                   = [];
let quoteIdx                               = 0;
let quoteTimer: ReturnType<typeof setInterval>|null = null;

// audio
let audioCtx: AudioContext|null           = null;
let analyser: AnalyserNode|null           = null;
let mediaStream: MediaStream|null         = null;
let mediaRecorder: MediaRecorder|null     = null;
let audioChunks: Blob[]                   = [];
let waveRaf: number|null                  = null;
let wavePhase                             = 0;

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
  <div class="shell">
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

      <!-- ── 1. Convo bar ───────────────────────────────────────────── -->
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

      <!-- ── 2. Voice bar ───────────────────────────────────────────── -->
      <div class="status-row">
        <span id="emotion-tag" class="emotion-tag accent-text">// ready</span>
        <button id="btn-voice" class="voice-btn accent-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          <span id="voice-label">Voice</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>

      <div id="voice-dropdown" class="voice-dropdown hidden"></div>

      <!-- ── 3. Portrait + soundwave (same row) ─────────────────────── -->
      <div class="stage-row">
        <div class="portrait-cell">
          <div id="avatar-frame" class="pixel-frame">
            <div class="pixel-frame-inner">
              <img id="avatar-img" class="portrait-img" src="" alt="expression" draggable="false"/>
              <div id="avatar-placeholder" class="portrait-placeholder">
                <div class="placeholder-icon">✦</div>
              </div>
            </div>
          </div>
        </div>
        <div class="wave-cell">
          <canvas id="waveform" class="waveform"></canvas>
        </div>
      </div>

      <!-- ── 4. CC toggle + Netflix-style subtitles ─────────────────── -->
      <div class="cc-row">
        <button id="btn-cc" class="cc-btn on" title="Toggle captions" aria-pressed="true">
          <span class="cc-glyph">CC</span>
        </button>
        <div class="advice-row">
          <button id="btn-prev" class="adv-btn" title="Previous">‹</button>
          <span id="adv-counter" class="adv-counter mono dim">—</span>
          <button id="btn-next" class="adv-btn" title="Next">›</button>
        </div>
      </div>

      <div id="subtitle-box" class="subtitle-box">
        <span id="dialogue-speaker" class="subtitle-speaker hidden"></span>
        <div id="dialogue" class="subtitle-text"></div>
      </div>

      <!-- ── 5. Mic + composer ──────────────────────────────────────── -->
      <div class="control-row">
        <button id="btn-mute" class="mute-btn" title="Toggle microphone">
          <svg id="ico-unmuted" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
          <svg id="ico-muted" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden">
            <line x1="1" y1="1" x2="23" y2="23"/>
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
          <div id="mute-ripple" class="mute-ripple"></div>
        </button>
        <textarea id="composer-input" class="composer-input" rows="2" placeholder="Type a message if the mic is being stubborn..."></textarea>
        <button id="composer-send" class="composer-send" title="Send message">Send</button>
      </div>

      <!-- ── 6. Inline quote (not boxed — part of the main flow) ─────── -->
      <div class="quote-inline">
        <span class="quote-mark">&ldquo;</span>
        <span id="quote-text" class="quote-text">Take your time. Enjoy coding :)</span>
        <button id="quote-cycle" class="quote-cycle" title="Another quote">↻</button>
      </div>

    </div><!-- /main -->
  </div>
  `;
}

function sendComposerMessage(): void {
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  const text = input?.value.trim() ?? '';
  if (!text) { return; }
  if (input) { input.value = ''; }
  void handleUserSpeech(text);
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
  // swap per-character frame palette
  const frame = document.getElementById('avatar-frame');
  if (frame) {
    frame.classList.remove('char-zoey', 'char-frieran', 'char-vegeta', 'char-default');
    const knownChars = ['zoey','frieran','vegeta'];
    frame.classList.add(knownChars.includes(c.id) ? `char-${c.id}` : 'char-default');
    frame.style.setProperty('--char-color', c.accentColor);
  }
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

  // CSS animation per emotion — angry/surprised get the "oomph" treatment
  if (frame) {
    frame.classList.remove('anim-bounce','anim-pulse','anim-angry','anim-surprised');
    // restart trick: force reflow so re-adding the same class replays the animation
    void (frame as HTMLElement).offsetWidth;
    if (emotion === 'angry')         { frame.classList.add('anim-angry'); }
    else if (emotion === 'surprised'){ frame.classList.add('anim-surprised'); }
    else if (emotion === 'happy')    { frame.classList.add('anim-bounce'); }
    else if (emotion === 'supportive'){ frame.classList.add('anim-pulse'); }
  }
}

// ── CC + quotes ───────────────────────────────────────────────────────────
function setCC(on: boolean): void {
  ccEnabled = on;
  const btn = document.getElementById('btn-cc');
  const box = document.getElementById('subtitle-box');
  if (btn) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (box) { box.classList.toggle('off', !on); }
}

function showQuote(idx: number): void {
  if (!quotesList.length) { return; }
  quoteIdx = ((idx % quotesList.length) + quotesList.length) % quotesList.length;
  const el2 = document.getElementById('quote-text');
  if (el2) {
    el2.classList.remove('quote-fade-in');
    void (el2 as HTMLElement).offsetWidth;
    el2.textContent = quotesList[quoteIdx];
    el2.classList.add('quote-fade-in');
  }
}

function startQuoteRotation(): void {
  if (quoteTimer) { clearInterval(quoteTimer); }
  if (quotesList.length <= 1) { return; }
  quoteTimer = setInterval(() => showQuote(quoteIdx + 1), 12000);
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
// speaker: 'user' shows "You", 'char' shows the active character's name,
// 'system' (default) hides the label entirely.
function setSpeaker(kind: 'user' | 'char' | 'system'): void {
  const sp = document.getElementById('dialogue-speaker');
  if (!sp) { return; }
  if (kind === 'system') { sp.textContent = ''; sp.classList.add('hidden'); return; }
  sp.classList.remove('hidden', 'speaker-user', 'speaker-char');
  if (kind === 'user') {
    sp.textContent = 'You';
    sp.classList.add('speaker-user');
  } else {
    sp.textContent = activeChar()?.name ?? 'Companion';
    sp.classList.add('speaker-char');
  }
}

function setDialogue(text: string, instant?: boolean, speaker: 'user' | 'char' | 'system' = 'system'): void {
  if (typewriterTimer !== null) { clearInterval(typewriterTimer); typewriterTimer = null; }
  setSpeaker(text ? speaker : 'system');
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
  setDialogue(adviceList[adviceIdx], false, 'char');
  updateAdviceNav();
}

// ── Waveform ──────────────────────────────────────────────────────────────
function syncCanvasSize(cv: HTMLCanvasElement): void {
  const w = cv.offsetWidth  || 240;
  const h = cv.offsetHeight || 56;
  if (cv.width !== w)  { cv.width  = w; }
  if (cv.height !== h) { cv.height = h; }
}

function getCharColor(): string {
  const frame = document.getElementById('avatar-frame');
  if (frame) {
    const v = getComputedStyle(frame).getPropertyValue('--char-color').trim();
    if (v) { return v; }
  }
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
}

function startIdleWave(): void {
  const cv  = document.getElementById('waveform') as HTMLCanvasElement|null;
  if (!cv) { return; }
  const ctx2 = cv.getContext('2d');
  if (!ctx2) { return; }
  syncCanvasSize(cv);

  function drawIdle(): void {
    if (analyser) { return; } // live wave takes over
    syncCanvasSize(cv!);
    const w = cv!.width, h = cv!.height;
    ctx2!.clearRect(0, 0, w, h);
    const color = getCharColor();
    ctx2!.strokeStyle = color;
    ctx2!.lineWidth = 1.8;
    ctx2!.lineCap = 'round';
    wavePhase += 0.025;
    const baseAmp = Math.max(6, h * 0.12);
    ctx2!.beginPath();
    for (let x = 0; x <= w; x++) {
      const amp = baseAmp + Math.sin(x * 0.018 + wavePhase * 0.7) * (baseAmp * 0.4);
      const y = h / 2 + Math.sin(x * 0.045 + wavePhase) * amp + Math.sin(x * 0.09 + wavePhase * 1.6) * (baseAmp * 0.35);
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
  syncCanvasSize(cv);
  const buf = new Uint8Array(analyser.frequencyBinCount);

  function drawLive(): void {
    if (!analyser) { startIdleWave(); return; }
    syncCanvasSize(cv!);
    analyser.getByteTimeDomainData(buf);
    const w = cv!.width, h = cv!.height;
    ctx2!.clearRect(0, 0, w, h);
    const color = getCharColor();
    ctx2!.strokeStyle = color;
    ctx2!.lineWidth = 2;
    ctx2!.lineCap = 'round';
    ctx2!.shadowColor = color;
    ctx2!.shadowBlur = 6;
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

// ── Mic / push-to-talk (MediaRecorder) ───────────────────────────────────
function applyRecordingUI(rec: boolean): void {
  const btn = document.getElementById('btn-mute');
  const rip = document.getElementById('mute-ripple');
  const ico1 = document.getElementById('ico-unmuted');
  const ico2 = document.getElementById('ico-muted');
  if (btn)  { btn.classList.toggle('recording', rec); btn.classList.toggle('muted', false); }
  if (rip)  { rip.classList.toggle('hidden', !rec); }
  if (ico1) { ico1.classList.toggle('hidden', false); }
  if (ico2) { ico2.classList.toggle('hidden', true); }
}

async function startRecording(): Promise<void> {
  if (isRecording || isProcessing) { return; }
  let stream: MediaStream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('mediaDevices API is unavailable in this webview', 'NotSupportedError');
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn('[mommyasmr] getUserMedia failed:', detail);
    vscode.postMessage({ type: 'openMicHelp', detail });
    setDialogue(`Mic unavailable (${detail}). You can type your message instead.`, true);
    setEmotion('sad');
    return;
  }
  mediaStream = stream;
  audioCtx  = new AudioContext();
  analyser  = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  startLiveWave();

  audioChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) { audioChunks.push(e.data); } };
  mediaRecorder.onstop = () => { void onAudioRecorded(); };
  mediaRecorder.start(100);
  isRecording = true;
  applyRecordingUI(true);
}

function stopRecording(): void {
  if (!isRecording) { return; }
  isRecording = false;
  applyRecordingUI(false);
  try { mediaRecorder?.stop(); } catch { /* */ }
  mediaRecorder = null;
  try { mediaStream?.getTracks().forEach(t => t.stop()); } catch { /* */ }
  mediaStream = null;
  if (audioCtx) { try { audioCtx.close(); } catch { /* */ } audioCtx = null; }
  analyser = null;
  startIdleWave();
}

async function onAudioRecorded(): Promise<void> {
  if (!audioChunks.length) { return; }
  const blob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
  audioChunks = [];
  const arrayBuf = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuf);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) { binary += String.fromCharCode(uint8[i]); }
  const audioBase64 = btoa(binary);
  const editorCtx = await requestEditorContext();
  const char = characters.find(c => c.id === activeProfileId);
  vscode.postMessage({
    type: 'sendAudio',
    audioBase64,
    mimeType: blob.type,
    profileId: activeProfileId,
    characterPrompt: char?.prompt ?? '',
    voiceId: char?.voiceId ?? '',
    characterName: char?.name ?? '',
    conversationId: currentConvoId,
    editorContext: editorCtx,
    history: currentMessages.slice(-10).map(m => ({ role: m.role, content: m.content })),
  });
  isProcessing = true;
  const composerInput = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (composerInput) { composerInput.disabled = true; }
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

function makeRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getBackendEndpoint(): string {
  return backendUrl || 'http://127.0.0.1:5001/respond';
}

function getBackendBaseUrl(): string {
  const endpoint = getBackendEndpoint();
  return endpoint.replace(/\/respond\/?$/, '');
}

function reportError(message: string): void {
  setDialogue(message, true);
  setEmotion('sad');
  vscode.postMessage({ type: 'showError', text: message });
}

function playAudioBase64(audioBase64: string, mimeType: string): void {
  if (!audioBase64) { return; }
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType || 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch(() => { /* autoplay can be blocked */ });
  audio.onended = () => URL.revokeObjectURL(url);
}

// ── AI call ───────────────────────────────────────────────────────────────
async function handleUserSpeech(text: string): Promise<void> {
  if (isProcessing || !text) { return; }
  isProcessing = true;
  setEmotion('thinking');
  setDialogue(text, true, 'user');
  if (currentConvoId) {
    vscode.postMessage({ type: 'saveMessage', conversationId: currentConvoId, role: 'user', content: text });
  }
  currentMessages.push({ id: '', role: 'user', content: text, timestamp: Date.now() });

  const editorCtx = await requestEditorContext();
  const history = currentMessages.slice(-10).map(m => ({ role: m.role, content: m.content, emotion: m.emotion }));
  const requestId = makeRequestId();
  activeRequestId = requestId;

  // Route through extension host — Anthropic + ElevenLabs called server-side
  vscode.postMessage({
    type: 'sendTranscript',
    requestId,
    transcript: text,
    profileId: activeProfileId,
    conversationId: currentConvoId,
    editorContext: editorCtx,
    history,
    characterPrompt: activeChar()?.prompt ?? '',
    voiceId: activeChar()?.voiceId ?? '',
    characterName: activeChar()?.name ?? '',
  });
  // Response arrives via window.addEventListener('message') → 'backendResponse' / 'backendError'
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
  el('btn-mute').addEventListener('click', () => { if (isRecording) { stopRecording(); } else { void startRecording(); } });
  el('btn-prev').addEventListener('click', () => showAdvice(adviceIdx - 1));
  el('btn-next').addEventListener('click', () => showAdvice(adviceIdx + 1));
  el('composer-send').addEventListener('click', () => sendComposerMessage());
  el('composer-input').addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      sendComposerMessage();
    }
  });
  el('btn-cc').addEventListener('click', () => setCC(!ccEnabled));
  el('quote-cycle').addEventListener('click', () => showQuote(quoteIdx + 1));
}

// ── VS Code message handler ───────────────────────────────────────────────
window.addEventListener('message', (ev) => {
  const msg = ev.data as Record<string, unknown>;
  switch (msg.type as string) {

    case 'init': {
      characters    = (msg.characters    as CharacterMeta[]) ?? [];
      emotionUris   = (msg.emotionUris   as Record<string, EmotionUris>) ?? {};
      backendUrl    = (msg.backendUrl    as string) ?? '';
      elevenLabsKey = (msg.elevenLabsKey as string) ?? '';
      conversations = (msg.conversations as Conversation[]) ?? [];
      currentConvoId = (msg.currentId    as string) ?? null;
      activeProfileId = (msg.activeProfile as string) ?? (characters[0]?.id ?? 'vegeta');

      applyProfile(activeProfileId);
      renderHistory();
      setCC(true);
      if (quotesList.length) {
        showQuote(Math.floor(Math.random() * quotesList.length));
        startQuoteRotation();
      }

      // Resume the active conversation (messages + last advice/emotion)
      const cv = conversations.find(c => c.id === currentConvoId);
      const titleEl = document.getElementById('session-title');
      if (titleEl && cv) { titleEl.textContent = cv.title; }

      currentMessages = cv?.messages ?? [];
      adviceList = currentMessages.filter(m => m.role === 'assistant').map(m => m.content);
      adviceIdx = adviceList.length > 0 ? adviceList.length - 1 : 0;
      updateAdviceNav();

      if (adviceList.length > 0) {
        setDialogue(adviceList[adviceIdx], true, 'char');
        const lastEmotion = [...currentMessages].reverse().find(m => m.role === 'assistant' && m.emotion);
        setEmotion(lastEmotion?.emotion ?? 'ready');
      } else {
        setDialogue('Click the mic button below to start talking.');
        setEmotion('ready');
      }

      startIdleWave();
      applyRecordingUI(false);
      break;
    }

    case 'backendResponse': {
      if (activeRequestId && (msg.requestId as string) !== activeRequestId) { break; }
      const clean = String(msg.text ?? '').trim();
      const emotion = String(msg.emotion ?? 'supportive');

      setEmotion(emotion);
      setDialogue(clean, !clean, 'char');
      if (clean) {
        adviceList.push(clean);
        adviceIdx = adviceList.length - 1;
        updateAdviceNav();
      }

      currentMessages.push({ id: '', role: 'assistant', content: clean, emotion, timestamp: Date.now() });
      if (currentConvoId) {
        vscode.postMessage({ type: 'saveMessage', conversationId: currentConvoId, role: 'assistant', content: clean, emotion });
      }

      const audioBase64 = String(msg.audioBase64 ?? '');
      const audioMimeType = String(msg.audioMimeType ?? 'audio/mpeg');
      const audioError = String(msg.audioError ?? '');
      if (audioBase64) {
        playAudioBase64(audioBase64, audioMimeType);
      } else if (audioError) {
        // Voice synthesis failed server-side — surface it instead of failing silently.
        console.warn('[mommyasmr] voice synthesis failed:', audioError);
        vscode.postMessage({ type: 'showError', text: `Voice unavailable: ${audioError}` });
      }

      const composerInput = document.getElementById('composer-input') as HTMLTextAreaElement | null;
      if (composerInput) { composerInput.disabled = false; }

      isProcessing = false;
      activeRequestId = '';
      break;
    }

    case 'backendError': {
      if (activeRequestId && (msg.requestId as string) !== activeRequestId) { break; }
      setDialogue(String(msg.message ?? 'Backend request failed.'), true);
      setEmotion('sad');
      const composerInput = document.getElementById('composer-input') as HTMLTextAreaElement | null;
      if (composerInput) { composerInput.disabled = false; }
      isProcessing = false;
      activeRequestId = '';
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
        setDialogue(adviceList[adviceIdx], true, 'char');
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
applyRecordingUI(false);
