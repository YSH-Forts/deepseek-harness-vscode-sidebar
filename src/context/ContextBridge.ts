import { execFile } from 'node:child_process'
import { relative } from 'node:path'
import * as vscode from 'vscode'
import type { AgentContext } from '../shared/protocol.ts'

const MAX_FILE_BYTES = 96 * 1024, MAX_DIFF_BYTES = 64 * 1024
export class ContextBridge {
  private readonly attachments = new Map<string, { path: string; text?: string }>()
  get attachedFiles(): string[] { return [...this.attachments.keys()] }
  addAttachment(path: string): void { this.attachments.set(path, { path }) }
  addSelection(editor: vscode.TextEditor): void {
    if (editor.selection.isEmpty) return
    const start = editor.selection.start.line + 1, end = editor.selection.end.line + 1
    const label = `${editor.document.uri.fsPath}:${start}-${end}`
    this.attachments.set(label, { path: label, text: editor.document.getText(editor.selection) })
  }
  removeAttachment(path: string): void { this.attachments.delete(path) }
  async chooseAttachments(): Promise<void> { for (const uri of await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false }) ?? []) this.addAttachment(uri.fsPath) }
  async capture(): Promise<AgentContext> {
    const folders = vscode.workspace.workspaceFolders ?? [], editor = vscode.window.activeTextEditor, root = folders[0]?.uri.fsPath
    const attachments = await Promise.all([...this.attachments.values()].map(async item => ({ path: item.path, text: item.text ?? await this.readFile(vscode.Uri.file(item.path)) })))
    return {
      ...(folders.length === 0 ? {} : { workspace: { name: vscode.workspace.name ?? 'workspace', roots: folders.map(folder => folder.uri.fsPath) } }),
      ...(editor === undefined ? {} : { activeFile: { path: editor.document.uri.fsPath, language: editor.document.languageId, line: editor.selection.active.line + 1, column: editor.selection.active.character + 1 },
        ...(editor.selection.isEmpty ? {} : { selection: { path: editor.document.uri.fsPath, startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1, text: editor.document.getText(editor.selection) } }) }),
      tabs: vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.label)),
      diagnostics: vscode.workspace.getConfiguration('deepseekHarness').get('context.includeDiagnostics', true) ? vscode.languages.getDiagnostics().flatMap(([uri, rows]) => rows.map(row => ({ path: root === undefined ? uri.fsPath : relative(root, uri.fsPath), line: row.range.start.line + 1, severity: vscode.DiagnosticSeverity[row.severity] ?? 'Unknown', message: row.message }))).slice(0, 100) : [],
      ...(root !== undefined && vscode.workspace.getConfiguration('deepseekHarness').get('context.includeGitDiff', true) ? { git: { diff: await this.gitDiff(root) } } : {}), attachments,
    }
  }
  private gitDiff(cwd: string): Promise<string> { return new Promise(resolve => execFile('git', ['diff', '--no-ext-diff', '--unified=3'], { cwd, maxBuffer: MAX_DIFF_BYTES * 2 }, (_error, stdout) => resolve(stdout.slice(0, MAX_DIFF_BYTES)))) }
  private async readFile(uri: vscode.Uri): Promise<string> { return new TextDecoder().decode((await vscode.workspace.fs.readFile(uri)).slice(0, MAX_FILE_BYTES)) }
}
