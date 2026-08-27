import * as vscode from 'vscode'
import { HarnessRuntimeManager } from './runtime/HarnessRuntimeManager.ts'
import { ChatViewProvider } from './views/ChatViewProvider.ts'
import { NoWorkspaceViewProvider } from './views/NoWorkspaceViewProvider.ts'
let runtime: HarnessRuntimeManager | undefined
export function activate(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (root === undefined) {
    const provider = new NoWorkspaceViewProvider(context)
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('deepseekHarness.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }))
    return
  }
  runtime = new HarnessRuntimeManager(context, root); const provider = new ChatViewProvider(context, runtime)
  void runtime.start().catch(() => { /* Runtime manager publishes the contained failure to the view. */ })
  context.subscriptions.push(runtime, provider, vscode.window.registerWebviewViewProvider('deepseekHarness.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('deepseekHarness.newSession', () => provider.newSession()), vscode.commands.registerCommand('deepseekHarness.restartRuntime', () => provider.restartRuntime()), vscode.commands.registerCommand('deepseekHarness.addSelection', () => provider.addSelection()))
}
export async function deactivate(): Promise<void> { await runtime?.stop(); runtime = undefined }
