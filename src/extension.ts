import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConversationStore } from './conversationStore';

function parseEnvFile(filePath: string): Record<string, string> {
  const cfg: Record<string, string> = {};
  if (!fs.existsSync(filePath)) { return cfg; }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }
    const eq = trimmed.indexOf('=');
    if (eq === -1) { continue; }
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val) { cfg[key] = val; }
  }
  return cfg;
}

// ── Config loader ──────────────────────────────────────────────────────────
function loadConfig(extensionPath: string): Record<string, string> {
  const candidates = [
    path.join(extensionPath, 'config', 'keys.env'),
    path.join(extensionPath, 'backend', '.env'),
  ];
  const cfg: Record<string, string> = {};
  for (const envPath of candidates) {
    Object.assign(cfg, parseEnvFile(envPath));
  }
  return cfg;
}

// ── Character loader ───────────────────────────────────────────────────────
interface CharacterMeta {
  id: string;
  name: string;
  prompt: string;
  emotions: string[];
  accentColor: string;
  voiceId: string;
}

function loadCharacters(extensionPath: string, cfg: Record<string, string>): CharacterMeta[] {
  const charsDir = path.join(extensionPath, 'characters');
  if (!fs.existsSync(charsDir)) { return []; }

  const ACCENT_MAP: Record<string, string> = {
    vegeta: '#1565c0',
    frieran: '#7c6a9a',
    zoey: '#378add',
  };
  const VOICE_MAP: Record<string, string> = {
    vegeta:  cfg['VEGETA_VOICE_ID']  || cfg['DEFAULT_ELEVENLABS_VOICE_ID'] || '',
    frieran: cfg['FRIERAN_VOICE_ID'] || '',
    zoey:    cfg['ZOEY_VOICE_ID']    || '',
  };

  return fs.readdirSync(charsDir)
    .filter((d: string) => fs.statSync(path.join(charsDir, d)).isDirectory())
    .map((id: string) => {
      const promptFile = path.join(charsDir, id, 'prompt.txt');
      const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
      const emotionsDir = path.join(charsDir, id, 'emotions');
      const emotions: string[] = [];
      if (fs.existsSync(emotionsDir)) {
        fs.readdirSync(emotionsDir).forEach((f: string) => {
          const ext = path.extname(f).toLowerCase();
          if (['.png', '.gif', '.jpg', '.jpeg', '.svg', '.webp'].includes(ext)) {
            emotions.push(path.basename(f, ext));
          }
        });
      }
      const name = id.charAt(0).toUpperCase() + id.slice(1);
      return {
        id, name, prompt, emotions,
        accentColor: ACCENT_MAP[id] || '#888888',
        voiceId: VOICE_MAP[id] || '',
      };
    });
}

function getActiveProfile(context: vscode.ExtensionContext, fallback: string): string {
  return context.globalState.get<string>('mommyasmr.activeProfile')
    ?? context.globalState.get<string>('mommyasmr.activeProfile')
    ?? fallback;
}

async function openMicrophoneSettings(): Promise<void> {
  const { exec } = await import('child_process');
  if (process.platform === 'darwin') {
    exec('open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone"');
  } else if (process.platform === 'win32') {
    exec('start ms-settings:privacy-microphone');
  }
}

// ── Webview Provider ───────────────────────────────────────────────────────
function loadQuotes(extensionPath: string): string[] {
  const quotesPath = path.join(extensionPath, 'quotes.txt');
  if (!fs.existsSync(quotesPath)) { return []; }
  return fs.readFileSync(quotesPath, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

export class CompanionViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mommyasmr.companion';
  private _view?: vscode.WebviewView;
  private _store: ConversationStore;
  private _cfg: Record<string, string>;
  private _characters: CharacterMeta[];
  private _backendUrl: string;
  private _quotes: string[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this._store = new ConversationStore(context);
    this._cfg = loadConfig(context.extensionPath);
    this._characters = loadCharacters(context.extensionPath, this._cfg);
    this._quotes = loadQuotes(context.extensionPath);
    const port = this._cfg['PORT'] || '5001';
    this._backendUrl = vscode.workspace.getConfiguration('mommyasmr').get<string>('backendUrl')
      || vscode.workspace.getConfiguration('mommyasmr').get<string>('backendUrl')
      || this._cfg['VEGETAASMR_BACKEND_URL']
      || this._cfg['MOMMYASMR_BACKEND_URL']
      || this._cfg['FLASK_BACKEND_URL']
      || `http://127.0.0.1:${port}/respond`;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'out'),
        vscode.Uri.joinPath(this.context.extensionUri, 'characters'),
      ],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => this._onMessage(msg, webviewView.webview),
      undefined,
      this.context.subscriptions
    );

    const defaultProfile = this._characters.find(c => c.id === 'frieran')?.id
      ?? this._characters[0]?.id
      ?? 'frieran';
    const activeProfile = getActiveProfile(this.context, defaultProfile);
    const initPayload = {
      type: 'init',
      characters: this._characters,
      activeProfile,
      conversations: this._store.getAllConversations(),
      currentId: this._store.getCurrentId(),
      backendUrl: this._backendUrl,
      elevenLabsKey: this._cfg['ELEVENLABS_API_KEY'] || '',
      emotionUris: this._buildEmotionUris(webviewView.webview),
      quotes: this._quotes,
    };
    void webviewView.webview.postMessage(initPayload);
    this.context.subscriptions.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) { void webviewView.webview.postMessage(initPayload); }
      })
    );
  }

  private _buildEmotionUris(webview: vscode.Webview): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};
    const charsDir = path.join(this.context.extensionPath, 'characters');
    for (const char of this._characters) {
      result[char.id] = {};
      const emotionsDir = path.join(charsDir, char.id, 'emotions');
      if (!fs.existsSync(emotionsDir)) { continue; }
      // Prefer raster art (PNG) over SVG when both exist for the same emotion.
      const FORMAT_RANK: Record<string, number> = {
        '.png': 4, '.webp': 3, '.gif': 3, '.jpg': 2, '.jpeg': 2, '.svg': 1,
      };
      const bestRank: Record<string, number> = {};
      for (const f of fs.readdirSync(emotionsDir)) {
        const ext = path.extname(f).toLowerCase();
        const rank = FORMAT_RANK[ext];
        if (rank === undefined) { continue; }
        const emotion = path.basename(f, ext);
        if (bestRank[emotion] !== undefined && bestRank[emotion] >= rank) { continue; }
        bestRank[emotion] = rank;
        const uri = webview.asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, 'characters', char.id, 'emotions', f)
        );
        result[char.id][emotion] = uri.toString();
      }
    }
    return result;
  }

  private async _onMessage(msg: Record<string, unknown>, webview: vscode.Webview): Promise<void> {
    switch (msg.type as string) {
      case 'newConversation': {
        const id = this._store.createConversation();
        webview.postMessage({ type: 'conversationCreated', id, conversations: this._store.getAllConversations() });
        break;
      }
      case 'deleteConversation': {
        this._store.deleteConversation(msg.id as string);
        webview.postMessage({ type: 'conversationsUpdated', conversations: this._store.getAllConversations(), currentId: this._store.getCurrentId() });
        break;
      }
      case 'renameConversation': {
        this._store.renameConversation(msg.id as string, msg.title as string);
        webview.postMessage({ type: 'conversationsUpdated', conversations: this._store.getAllConversations(), currentId: this._store.getCurrentId() });
        break;
      }
      case 'selectConversation': {
        this._store.setCurrentId(msg.id as string);
        const messages = this._store.getMessages(msg.id as string);
        webview.postMessage({ type: 'conversationLoaded', id: msg.id, messages });
        break;
      }
      case 'saveMessage': {
        this._store.addMessage(msg.conversationId as string, msg.role as 'user' | 'assistant', msg.content as string, msg.emotion as string | undefined);
        webview.postMessage({ type: 'conversationsUpdated', conversations: this._store.getAllConversations(), currentId: this._store.getCurrentId() });
        break;
      }
      case 'sendTranscript': {
        const requestId = String(msg.requestId ?? '');
        const transcript = String(msg.transcript ?? '').trim();
        const profileId = String(msg.profileId ?? '');
        const character = this._characters.find((entry) => entry.id === profileId);
        if (!transcript) {
          webview.postMessage({ type: 'backendError', requestId, message: 'Empty transcript.' });
          break;
        }
        try {
          // Extension host proxies to Flask — avoids CORS issues from the webview sandbox
          const response = await fetch(this._backendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              transcript,
              profileId,
              characterPrompt: character?.prompt ?? '',
              voiceId: character?.voiceId ?? '',
              characterName: character?.name ?? '',
              conversationId: String(msg.conversationId ?? ''),
              editorContext: msg.editorContext ?? {},
              history: msg.history ?? [],
            }),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Backend ${response.status}: ${errText.slice(0, 300)}`);
          }

          const data = await response.json() as {
            text?: string;
            emotion?: string;
            audioBase64?: string;
            audioMimeType?: string;
            audioError?: string;
          };

          webview.postMessage({
            type: 'backendResponse',
            requestId,
            text: data.text ?? '',
            emotion: data.emotion ?? 'supportive',
            audioBase64: data.audioBase64 ?? '',
            audioMimeType: data.audioMimeType ?? 'audio/mpeg',
            audioError: data.audioError ?? '',
          });
        } catch (error) {
          webview.postMessage({
            type: 'backendError',
            requestId,
            message: error instanceof Error ? error.message : 'Backend request failed.',
          });
        }
        break;
      }
      case 'sendAudio': {
        const requestId = String(msg.requestId ?? '');
        const profileId = String(msg.profileId ?? '');
        const character = this._characters.find((entry) => entry.id === profileId);
        try {
          const response = await fetch(this._backendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioBase64: msg.audioBase64 ?? '',
              mimeType: msg.mimeType ?? 'audio/webm',
              profileId,
              characterPrompt: character?.prompt ?? '',
              voiceId: character?.voiceId ?? '',
              characterName: character?.name ?? '',
              conversationId: String(msg.conversationId ?? ''),
              editorContext: msg.editorContext ?? {},
              history: msg.history ?? [],
            }),
          });
          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Backend ${response.status}: ${errText.slice(0, 300)}`);
          }
          const data = await response.json() as {
            text?: string; emotion?: string;
            audioBase64?: string; audioMimeType?: string; transcript?: string;
            audioError?: string;
          };
          webview.postMessage({
            type: 'backendResponse',
            requestId,
            text: data.text ?? '',
            emotion: data.emotion ?? 'supportive',
            audioBase64: data.audioBase64 ?? '',
            audioMimeType: data.audioMimeType ?? 'audio/mpeg',
            transcript: data.transcript ?? '',
            audioError: data.audioError ?? '',
          });
        } catch (error) {
          webview.postMessage({
            type: 'backendError',
            requestId,
            message: error instanceof Error ? error.message : 'Backend audio request failed.',
          });
        }
        break;
      }
      case 'startBackendListen': {
        // Robust mic path: record + transcribe on the Python backend (ffmpeg), bypassing
        // the unreliable webview getUserMedia permission layer entirely.
        const requestId = String(msg.requestId ?? '');
        const duration = Number(msg.duration ?? 7);
        const base = this._backendUrl.replace(/\/respond\/?$/, '');
        try {
          const res = await fetch(`${base}/listen`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duration }),
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Backend ${res.status}: ${errText.slice(0, 300)}`);
          }
          const data = await res.json() as { transcript?: string; error?: string };
          if (data.error) { throw new Error(data.error); }
          webview.postMessage({ type: 'sttResult', requestId, transcript: data.transcript ?? '' });
        } catch (error) {
          webview.postMessage({
            type: 'sttError',
            requestId,
            message: error instanceof Error ? error.message : 'Microphone capture failed.',
          });
        }
        break;
      }
      case 'stopBackendListen': {
        // Mic button pressed mid-recording — tell the backend to finish capturing now.
        const base = this._backendUrl.replace(/\/respond\/?$/, '');
        try {
          await fetch(`${base}/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
        } catch { /* best effort */ }
        break;
      }
      case 'setActiveProfile': {
        await this.context.globalState.update('mommyasmr.activeProfile', msg.profile as string);
        break;
      }
      case 'getEditorContext': {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const sel = editor.selection;
          const selectedText = editor.document.getText(sel);
          const language = editor.document.languageId;
          const fileName = path.basename(editor.document.fileName);
          webview.postMessage({ type: 'editorContext', selectedText, language, fileName });
        } else {
          webview.postMessage({ type: 'editorContext', selectedText: '', language: '', fileName: '' });
        }
        break;
      }
      case 'showError': {
        vscode.window.showErrorMessage(msg.text as string);
        break;
      }
      case 'showInfo': {
        vscode.window.showInformationMessage(msg.text as string);
        break;
      }
      case 'openMicHelp': {
        const detail = String(msg.detail ?? '').trim();
        const open = 'Open Microphone Settings';
        const base = process.platform === 'win32'
          ? 'Could not access the microphone. In Windows Settings → Privacy & security → Microphone, make sure both "Microphone access" and "Let desktop apps access your microphone" are ON (the second toggle is what blocks VS Code), then reload the window.'
          : 'Could not access the microphone. Enable Microphone access for VS Code in System Settings → Privacy & Security → Microphone, then reload the window.';
        const choice = await vscode.window.showWarningMessage(
          detail ? `${base}\n\n(${detail})` : base,
          open
        );
        if (choice === open) { await openMicrophoneSettings(); }
        break;
      }
      case 'promptRename': {
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename this session',
          value: msg.current as string,
          placeHolder: 'Session name…',
        });
        if (newName !== undefined) {
          webview.postMessage({ type: 'renameResult', id: msg.id, title: newName });
        }
        break;
      }
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'companion.css'));
    const nonce = Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${webview.cspSource} data: blob:;
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';
             media-src ${webview.cspSource} blob:;
             connect-src 'none';"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link rel="stylesheet" href="${styleUri}"/>
  <title>MOMMY ASMR</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public trigger(type: string, payload?: Record<string, unknown>): void {
    this._view?.webview.postMessage({ type, ...payload });
  }
}

// ── Activate ───────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
  const provider = new CompanionViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CompanionViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const cmds: [string, () => void][] = [
    ['mommyasmr.newConversation',    () => provider.trigger('triggerNew')],
    ['mommyasmr.deleteConversation', () => provider.trigger('triggerDelete')],
    ['mommyasmr.toggleHistory',      () => provider.trigger('triggerHistory')],
    ['mommyasmr.switchProfile',      () => provider.trigger('triggerProfileMenu')],
    ['mommyasmr.openPanel',          () => vscode.commands.executeCommand('workbench.view.extension.mommyasmr-sidebar')],
    ['mommyasmr.openMicSettings',    () => openMicrophoneSettings()],
  ];

  for (const [cmd, fn] of cmds) {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, fn));
  }
}

export function deactivate(): void {}
