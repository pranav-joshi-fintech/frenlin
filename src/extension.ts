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
    if (key && val && !val.startsWith('your-') && !val.startsWith('sk-ant-your')) {
      cfg[key] = val;
    }
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
  emotions: string[];   // emotion names that have image files
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
    vegeta: cfg['VEGETA_VOICE_ID'] || cfg['DEFAULT_ELEVENLABS_VOICE_ID'] || '',
    frieran: cfg['FRIERAN_VOICE_ID'] || '',
    zoey: cfg['ZOEY_VOICE_ID'] || '',
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
  return context.globalState.get<string>('vegetaasmr.activeProfile')
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
export class CompanionViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vegetaasmr.companion';
  private _view?: vscode.WebviewView;
  private _store: ConversationStore;
  private _cfg: Record<string, string>;
  private _characters: CharacterMeta[];
  private _backendUrl: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._store = new ConversationStore(context);
    this._cfg = loadConfig(context.extensionPath);
    this._characters = loadCharacters(context.extensionPath, this._cfg);
    this._backendUrl = vscode.workspace.getConfiguration('vegetaasmr').get<string>('backendUrl')
      || vscode.workspace.getConfiguration('mommyasmr').get<string>('backendUrl')
      || this._cfg['VEGETAASMR_BACKEND_URL']
      || this._cfg['MOMMYASMR_BACKEND_URL']
      || this._cfg['FLASK_BACKEND_URL']
      || 'http://127.0.0.1:5001/respond';
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

    const defaultProfile = this._characters.find(c => c.id === 'vegeta')?.id
      ?? this._characters[0]?.id
      ?? 'vegeta';
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
      for (const f of fs.readdirSync(emotionsDir)) {
        const ext = path.extname(f).toLowerCase();
        if (['.png', '.gif', '.jpg', '.jpeg', '.svg', '.webp'].includes(ext)) {
          const emotion = path.basename(f, ext);
          const uri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'characters', char.id, 'emotions', f)
          );
          result[char.id][emotion] = uri.toString();
        }
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
        if (!this._backendUrl) {
          webview.postMessage({ type: 'backendError', requestId, message: 'Backend URL is not configured.' });
          break;
        }
        try {
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

          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await response.json() as {
              text?: string;
              emotion?: string;
              audioBase64?: string;
              audioMimeType?: string;
              audioUrl?: string;
              error?: string;
            };

            if (!response.ok) {
              throw new Error(data.error || `HTTP ${response.status}`);
            }

            let audioBase64 = data.audioBase64 ?? '';
            let audioMimeType = data.audioMimeType ?? 'audio/mpeg';

            if (!audioBase64 && data.audioUrl) {
              const audioResponse = await fetch(data.audioUrl);
              if (audioResponse.ok) {
                audioMimeType = audioResponse.headers.get('content-type') || audioMimeType;
                const bytes = await audioResponse.arrayBuffer();
                audioBase64 = Buffer.from(bytes).toString('base64');
              }
            }

            webview.postMessage({
              type: 'backendResponse',
              requestId,
              text: data.text ?? '',
              emotion: data.emotion ?? 'supportive',
              audioBase64,
              audioMimeType,
            });
            break;
          }

          throw new Error(`HTTP ${response.status}`);
        } catch (error) {
          webview.postMessage({
            type: 'backendError',
            requestId,
            message: error instanceof Error ? error.message : 'Backend request failed.',
          });
        }
        break;
      }
      case 'setActiveProfile': {
        await this.context.globalState.update('vegetaasmr.activeProfile', msg.profile as string);
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
        const open = 'Open Microphone Settings';
        const choice = await vscode.window.showWarningMessage(
          'Voice capture runs through the Python backend (not the VS Code webview). ' +
          'Enable Microphone for Terminal or Cursor in System Settings, then restart the backend.',
          open
        );
        if (choice === open) {
          await openMicrophoneSettings();
        }
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
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'companion.css'));
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
             connect-src https: http://127.0.0.1:5001 http://127.0.0.1:5000 http://localhost:5001 http://localhost:5000;"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link rel="stylesheet" href="${styleUri}"/>
  <title>Vegeta ASMR</title>
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
    ['vegetaasmr.newConversation',    () => provider.trigger('triggerNew')],
    ['vegetaasmr.deleteConversation', () => provider.trigger('triggerDelete')],
    ['vegetaasmr.toggleHistory',      () => provider.trigger('triggerHistory')],
    ['vegetaasmr.switchProfile',      () => provider.trigger('triggerProfileMenu')],
    ['vegetaasmr.openPanel',          () => vscode.commands.executeCommand('workbench.view.extension.vegetaasmr-sidebar')],
    ['vegetaasmr.openMicSettings',    () => openMicrophoneSettings()],
  ];

  for (const [cmd, fn] of cmds) {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, fn));
  }
}

export function deactivate(): void {}
