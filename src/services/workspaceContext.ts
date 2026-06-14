import * as vscode from 'vscode';
import * as path from 'path';

export interface TabInfo {
  name: string;
  ext: string;
  language: string;
}

export interface WorkspaceSnapshot {
  activeFile: string | null;
  ext: string | null;
  language: string | null;
  untitled: boolean;
  dirty: boolean;
  isEnv: boolean;
  openTabs: TabInfo[];
}

const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript (TSX)', '.js': 'JavaScript', '.jsx': 'JavaScript (JSX)',
  '.py': 'Python', '.md': 'Markdown', '.json': 'JSON', '.env': 'Environment file',
  '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.c': 'C', '.cpp': 'C++', '.sh': 'Shell', '.yml': 'YAML', '.yaml': 'YAML',
  '.sql': 'SQL', '.rb': 'Ruby', '.php': 'PHP', '.txt': 'Plain text',
};

function extOf(name: string): string {
  if (name === '.env' || name.endsWith('.env') || name.includes('.env.')) { return '.env'; }
  return path.extname(name).toLowerCase();
}

function languageFor(ext: string, languageId?: string): string {
  if (EXT_LANG[ext]) { return EXT_LANG[ext]; }
  if (languageId && languageId !== 'plaintext') { return languageId; }
  return ext ? ext.slice(1).toUpperCase() : 'Plain text';
}

/** Tracks the developer's current editing context and emits a snapshot on change. */
export class WorkspaceContextService {
  private readonly _onChange = new vscode.EventEmitter<WorkspaceSnapshot>();
  readonly onChange = this._onChange.event;
  private _disposables: vscode.Disposable[] = [];
  private _lastSig = '';

  constructor() {
    // Dedupe: many of these events fire per keystroke, but the snapshot only changes
    // meaningfully on file/tab/dirty/save changes — only emit when it actually differs.
    const fire = (): void => {
      const snap = this.snapshot();
      const sig = `${snap.activeFile}|${snap.dirty}|${snap.untitled}|${snap.language}|${snap.openTabs.map(t => t.name).join(',')}`;
      if (sig === this._lastSig) { return; }
      this._lastSig = sig;
      this._onChange.fire(snap);
    };
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(fire),
      vscode.workspace.onDidOpenTextDocument(fire),
      vscode.workspace.onDidCloseTextDocument(fire),
      vscode.workspace.onDidSaveTextDocument(fire),
      vscode.workspace.onDidChangeTextDocument(fire),
      vscode.window.tabGroups.onDidChangeTabs(fire),
    );
  }

  snapshot(): WorkspaceSnapshot {
    const openTabs: TabInfo[] = [];
    const seen = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        const uri = input?.uri;
        if (!uri) { continue; }
        const name = path.basename(uri.fsPath || uri.path);
        if (seen.has(name)) { continue; }
        seen.add(name);
        const ext = extOf(name);
        openTabs.push({ name, ext, language: languageFor(ext) });
      }
    }

    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return { activeFile: null, ext: null, language: null, untitled: false, dirty: false, isEnv: false, openTabs };
    }
    const doc = ed.document;
    const name = doc.isUntitled ? 'Untitled' : path.basename(doc.fileName);
    const ext = doc.isUntitled ? '' : extOf(name);
    return {
      activeFile: name,
      ext: ext || null,
      language: languageFor(ext, doc.languageId),
      untitled: doc.isUntitled,
      dirty: doc.isDirty,
      isEnv: ext === '.env',
      openTabs,
    };
  }

  /** Compact one-line summary the LLM can read. */
  describe(): string {
    const s = this.snapshot();
    if (!s.activeFile) { return 'No file is currently open.'; }
    const parts: string[] = [
      `Active file: ${s.activeFile} (${s.language}${s.dirty ? ', unsaved changes' : ''}${s.untitled ? ', untitled' : ''}).`,
    ];
    if (s.openTabs.length) {
      parts.push(`Open tabs: ${s.openTabs.map(t => t.name).join(', ')}.`);
    }
    return parts.join(' ');
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onChange.dispose();
  }
}
