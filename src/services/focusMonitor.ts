import * as vscode from 'vscode';

/**
 * Detects unproductive tab-switching: more than THRESHOLD switches within a rolling
 * WINDOW with no edits in between. Fires at most once per COOLDOWN. Any edit resets
 * the switch counter.
 */
export class FocusMonitor {
  private static readonly WINDOW = 15_000;       // rolling window (ms)
  private static readonly THRESHOLD = 5;          // "more than 5" switches
  private static readonly COOLDOWN = 5 * 60_000;  // min gap between interventions

  private switches: number[] = [];
  private lastIntervention = 0;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly onTrigger: () => void) {
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this._onSwitch()),
      vscode.workspace.onDidChangeTextDocument(() => this._onEdit()),
    );
  }

  private _onEdit(): void {
    this.switches = []; // a real edit means they're working — reset the counter
  }

  private _onSwitch(): void {
    const now = Date.now();
    this.switches.push(now);
    this.switches = this.switches.filter(t => now - t <= FocusMonitor.WINDOW);
    if (
      this.switches.length > FocusMonitor.THRESHOLD &&
      now - this.lastIntervention > FocusMonitor.COOLDOWN
    ) {
      this.lastIntervention = now;
      this.switches = [];
      this.onTrigger();
    }
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }
}
