import * as vscode from 'vscode';
import { MergenPanel } from './panel.js';

export function activate(context: vscode.ExtensionContext): void {
  // Register the sidebar webview provider
  const provider = new MergenPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mergen.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('mergen.openPanel', () => {
      vscode.commands.executeCommand('mergen.panel.focus');
    }),
    vscode.commands.registerCommand('mergen.clearBuffer', () => {
      provider.clearBuffer();
    }),
    vscode.commands.registerCommand('mergen.refresh', () => {
      provider.refresh();
    }),
  );
}

export function deactivate(): void {
  // nothing — webview lifecycle is managed by VS Code
}
