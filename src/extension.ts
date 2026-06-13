import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConversationStore } from './conversationStore';

// ── Config loader ──────────────────────────────────────────────────────────
function loadConfig(extensionPath: string): Record<string, string> {
  const envPath = path.join(extensionPath, 'config', 'keys.env');
  const cfg: Record<string, string> = {};
  if (!fs.existsSync(envPath)) { return cfg; }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
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
    aurora: '#d4537e', kai: '#378add', sage: '#1d9e75'
  };
  const VOICE_MAP: Record<string, string> = {
    aurora: cfg['AURORA_VOICE_ID'] || '',
    kai: cfg['KAI_VOICE_ID'] || '',
    sage: cfg['SAGE_VOICE_ID'] || '',
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

// ── Webview Provider ───────────────────────────────────────────────────────
export class CompanionViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mommyasmr.companion';
  private _view?: vscode.WebviewView;
  private _store: ConversationStore;
  private _cfg: Record<string, string>;
  private _characters: CharacterMeta[];
  private _backendUrl: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._store = new ConversationStore(context);
    this._cfg = loadConfig(context.extensionPath);
    this._characters = loadCharacters(context.extensionPath, this._cfg);
    this._backendUrl = vscode.workspace.getConfiguration('mommyasmr').get<string>('backendUrl')
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

    // Post init state — send immediately and also on first visibility
    const activeProfile = this.context.globalState.get<string>('mommyasmr.activeProfile', this._characters[0]?.id || 'aurora');
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
    // Re-send on focus in case first message was dropped before JS loaded
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

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const contentType = response.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            throw new Error('Backend must return JSON.');
          }

          const data = await response.json() as {
            text?: string;
            emotion?: string;
            audioBase64?: string;
            audioMimeType?: string;
            audioUrl?: string;
          };

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
  <title>MommyASMR</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // Called from commands
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
  ];

  for (const [cmd, fn] of cmds) {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, fn));
  }
}

export function deactivate(): void {}
