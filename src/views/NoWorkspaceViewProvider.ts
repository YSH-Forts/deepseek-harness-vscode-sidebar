import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'

/** A non-error onboarding surface shown when VS Code has no opened folder. */
export class NoWorkspaceViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage(message => {
      if (message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'openWorkspace') {
        void vscode.commands.executeCommand('vscode.openFolder')
      }
    }, undefined, this.context.subscriptions)
  }

  private html(webview: vscode.Webview): string {
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'assets', 'index.css'))
    const nonce = randomBytes(16).toString('base64')
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><main class="app-shell"><section class="empty-state"><div class="empty-logo">◒</div><h2>Open a folder to start</h2><p>DeepSeek Harness uses the current VS Code workspace for files, terminal commands, and chat context.</p><button class="primary-button" id="open-folder">Open Folder</button></section></main><script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.getElementById('open-folder').addEventListener('click', () => vscode.postMessage({ type: 'openWorkspace' }));</script></body></html>`
  }
}
