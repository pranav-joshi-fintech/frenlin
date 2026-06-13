import * as vscode from 'vscode';
import { ConversationStore } from './conversationStore';

export class CompanionPanel {
  public static currentPanel: CompanionPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext, store: ConversationStore): CompanionPanel {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    if (CompanionPanel.currentPanel) {
      CompanionPanel.currentPanel._panel.reveal(column);
      return CompanionPanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      'vegetaasmr',
      'Vegeta ASMR',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.joinPath(extensionUri, 'out'),
        ],
      }
    );
    CompanionPanel.currentPanel = new CompanionPanel(panel, extensionUri, context, store);
    return CompanionPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConversationStore
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  reveal() {
    this._panel.reveal();
  }

  dispose() {
    CompanionPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) { x.dispose(); }
    }
  }
}
