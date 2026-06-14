import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Fires once if the user dwells on a `.env` file for DELAY ms without editing it or
 * switching away. Switching tabs or editing resets the window; the intervention only
 * fires once per uninterrupted viewing session.
 */
export class EnvMonitor {
  private static readonly DELAY = 30_000;

  private timer?: ReturnType<typeof setTimeout>;
  private firedForThisView = false;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly onTrigger: () => void) {
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this._arm(true)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const active = vscode.window.activeTextEditor;
        if (active && e.document === active.document) { this._arm(true); } // edit resets
      }),
    );
    this._arm(true);
  }

  private _isEnv(): boolean {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.isUntitled) { return false; }
    const name = path.basename(ed.document.fileName);
    return name === '.env' || name.endsWith('.env') || name.includes('.env.');
  }

  /** (Re)start the dwell timer. newView=true clears the "already fired" guard. */
  private _arm(newView: boolean): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (newView) { this.firedForThisView = false; }
    if (!this._isEnv()) { return; }
    this.timer = setTimeout(() => {
      if (this._isEnv() && !this.firedForThisView) {
        this.firedForThisView = true;
        this.onTrigger();
      }
    }, EnvMonitor.DELAY);
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); }
    this._disposables.forEach(d => d.dispose());
  }
}
