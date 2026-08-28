import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { ApprovalManager } from '../approvals/ApprovalManager.ts'
import { ContextBridge } from '../context/ContextBridge.ts'
import type { HarnessAdapter } from '../harness/HarnessAdapter.ts'
import { HarnessRuntimeManager } from '../runtime/HarnessRuntimeManager.ts'
import type { HarnessCommand, HarnessEvent, PluginInfo, SessionSummary, SettingsState, WebviewState, WebviewToExtensionMessage } from '../shared/protocol.ts'

const SESSION_KEY = 'deepseekHarness.sessions.v2'
const FILE_CHANGE_KEY = 'deepseekHarness.fileChanges.v1'
const MAX_PRESENTATION_EVENTS = 5_000
// Keep first paint light. Older events remain available through “Load earlier
// messages”, so a large, long-lived session does not hold up opening the view.
const INITIAL_HISTORY_EVENTS = 120
const execFileAsync = promisify(execFile)
interface PersistedFileChange { callId: string; sessionId: string; path: string; beforeFile?: string; afterFile?: string; decision?: 'kept' | 'reverted' }

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined
  private readonly contextBridge = new ContextBridge()
  private readonly approvals: ApprovalManager
  private sessions: SessionSummary[]
  private commands: HarnessCommand[] = []
  private plugins: PluginInfo[] = []
  private activeSessionId: string | undefined
  private events: HarnessEvent[] = []
  private historyHasMore = false
  private historyBefore: number | undefined
  private subscription: vscode.Disposable | undefined
  private activationGeneration = 0
  private settings: SettingsState
  private gitChanges: { path: string; status: string }[] = []
  private trajectoryEvents: Record<string, unknown>[] = []
  private readonly fileSnapshots = new Map<string, { path: string; before?: string; after?: string; sessionId: string; decision?: 'kept' | 'reverted' }>()
  private persistedChanges: PersistedFileChange[]

  constructor(private readonly context: vscode.ExtensionContext, private readonly runtime: HarnessRuntimeManager) {
    this.sessions = context.globalState.get<SessionSummary[]>(SESSION_KEY, [])
    this.persistedChanges = context.globalState.get<PersistedFileChange[]>(FILE_CHANGE_KEY, [])
    this.activeSessionId = this.sessions[0]?.id
    const config = vscode.workspace.getConfiguration('deepseekHarness')
    this.settings = {
      provider: config.get('provider', 'deepseek-official'), model: config.get('model', 'deepseek-v4-flash'), endpoint: config.get('endpoint', ''), permissionMode: config.get('permissionMode', 'workspace-write'),
      credential: { configured: false, writable: true }, loading: true,
    }
    this.approvals = new ApprovalManager(() => runtime.adapter)
    context.subscriptions.push(runtime.onDidChangeStatus(() => { void this.postState() }))
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => { void this.handle(message) }, undefined, this.context.subscriptions)
    void this.activateStoredSession().catch(error => this.report(error))
  }

  async newSession(): Promise<void> {
    const adapter = await this.runtime.start(), session = await adapter.createSession(), now = Date.now()
    const summary = { id: session.id, title: 'New session', createdAt: now, updatedAt: now }
    this.sessions = [summary, ...this.sessions.filter(item => item.id !== session.id)]
    this.activeSessionId = session.id
    this.events = [{ type: 'session.started', sessionId: session.id }]
    this.subscribe(adapter, session.id)
    await this.persist(); await this.postState()
  }

  async restartRuntime(): Promise<void> { await this.runtime.restart(); await this.activateStoredSession() }

  private async forkSession(): Promise<void> {
    if (this.activeSessionId === undefined) return
    const id = await (await this.runtime.start()).forkSession(this.activeSessionId), now = Date.now()
    this.sessions = [{ id, title: 'Fork of current session', createdAt: now, updatedAt: now, parentSessionId: this.activeSessionId }, ...this.sessions]
    this.activeSessionId = id
    await this.activateStoredSession()
  }

  private async exportSession(): Promise<void> {
    if (this.activeSessionId === undefined) return
    const uri = await vscode.window.showSaveDialog({ saveLabel: 'Export Harness session', filters: { JSON: ['json'] }, defaultUri: vscode.Uri.file(`harness-${this.activeSessionId}.json`) })
    if (uri === undefined) return
    const history = await (await this.runtime.start()).history(this.activeSessionId)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ sessionId: this.activeSessionId, events: history }, null, 2), 'utf8'))
  }

  private async deleteSession(): Promise<void> {
    if (this.activeSessionId === undefined) return
    const sessionId = this.activeSessionId
    const session = this.sessions.find(item => item.id === sessionId)
    const confirmed = await vscode.window.showWarningMessage(`Delete session “${session?.title ?? sessionId}”? It will be moved to runtime trash.`, { modal: true }, 'Delete')
    if (confirmed !== 'Delete') return
    if (!await (await this.runtime.start()).deleteSession(sessionId)) throw new Error('Session could not be deleted')
    this.sessions = this.sessions.filter(item => item.id !== sessionId)
    this.activeSessionId = this.sessions[0]?.id
    await this.activateStoredSession()
  }

  async addSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (editor !== undefined) this.contextBridge.addSelection(editor)
    await this.postState(); this.view?.show(true)
  }

  dispose(): void { this.subscription?.dispose() }

  private async handle(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready': await this.postState(); return
        case 'newSession': await this.newSession(); return
        case 'forkSession': await this.forkSession(); return
        case 'exportSession': await this.exportSession(); return
        case 'deleteSession': await this.deleteSession(); return
        case 'restartRuntime': await this.restartRuntime(); return
        case 'loadTrajectory': await this.loadTrajectory(); return
        case 'loadEarlierHistory': await this.loadEarlierHistory(); return
        case 'loadPlugins': await this.loadPlugins(); return
        case 'attachFiles': await this.contextBridge.chooseAttachments(); await this.postState(); return
        case 'removeAttachment': this.contextBridge.removeAttachment(message.path); await this.postState(); return
        case 'selectSession': await this.selectSession(message.sessionId); return
        case 'renameSession': await this.renameSession(message.sessionId); return
        case 'cancel': if (this.activeSessionId !== undefined) await (await this.runtime.start()).cancel(this.activeSessionId); return
        case 'cancelSubagent': await (await this.runtime.start()).cancel(message.sessionId); return
        case 'approval': await this.approvals.respond(message.sessionId, message.approvalId, message.decision); return
        case 'sendMessage': await this.sendMessage(message.text, message.mode); return
        case 'retryMessage': await this.sendMessage(message.text); return
        case 'steerMessage': await this.steerMessage(message.text); return
        case 'openFile': await this.openFile(message.path, message.line); return
        case 'openDiff': await this.openDiff(message.callId); return
        case 'openGitDiff': await this.openGitDiff(); return
        case 'openGitFileDiff': await this.openGitFileDiff(message.path); return
        case 'keepDiff': await this.reviewDiff(message.callId, 'kept'); return
        case 'revertDiff': await this.reviewDiff(message.callId, 'reverted'); return
        case 'refreshSettings': await this.refreshSettings(); return
        case 'saveSettings': await this.saveSettings(message); return
        case 'removeApiKey': await this.removeApiKey(); return
      }
    } catch (error) { this.report(error) }
  }

  private async sendMessage(text: string, mode?: string): Promise<void> {
    if (text.trim() === '') return
    if (this.activeSessionId === undefined) await this.newSession()
    const id = this.activeSessionId
    if (id === undefined) return
    const session = this.sessions.find(item => item.id === id)
    if (session !== undefined) {
      session.updatedAt = Date.now()
      if (session.title === 'New session') session.title = text.replaceAll(/\s+/g, ' ').slice(0, 80)
      this.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    await this.persist(); await this.postState()
    const context = await this.contextBridge.capture()
    if (mode !== undefined) context.mode = mode
    await (await this.runtime.start()).sendMessage(id, text, context)
  }

  private async loadPlugins(): Promise<void> {
    this.plugins = await (await this.runtime.start()).listPlugins()
    await this.postState()
  }

  private async selectSession(id: string): Promise<void> {
    if (!this.sessions.some(session => session.id === id)) return
    this.activeSessionId = id
    await this.activateStoredSession()
  }

  private async loadTrajectory(): Promise<void> {
    if (this.activeSessionId === undefined) return
    this.trajectoryEvents = await (await this.runtime.start()).rawHistory(this.activeSessionId)
    await this.postState()
  }

  private async loadEarlierHistory(): Promise<void> {
    const id = this.activeSessionId
    if (id === undefined || !this.historyHasMore || this.historyBefore === undefined) return
    const page = await (await this.runtime.start()).history(id, { limit: INITIAL_HISTORY_EVENTS, before: this.historyBefore })
    this.events = [...page.events, ...this.events]
    this.historyHasMore = page.hasMore
    this.historyBefore = page.firstSeq
    await this.postState()
  }

  private async renameSession(id: string): Promise<void> {
    const session = this.sessions.find(item => item.id === id)
    if (session === undefined) return
    const title = await vscode.window.showInputBox({ title: 'Rename session', value: session.title, prompt: 'Enter a short session title' })
    if (title === undefined || title.trim() === '') return
    session.title = title.trim().slice(0, 120)
    await this.persist(); await this.postState()
  }

  private async steerMessage(text: string): Promise<void> {
    if (text.trim() === '' || this.activeSessionId === undefined) return
    await (await this.runtime.start()).steer(this.activeSessionId, text.trim())
  }

  private async openFile(filePath: string, line?: number): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const resolvedPath = path.isAbsolute(filePath) || workspaceRoot === undefined ? filePath : path.join(workspaceRoot, filePath)
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath))
    const editor = await vscode.window.showTextDocument(document, { preview: true })
    if (line !== undefined && line > 0) {
      const position = new vscode.Position(Math.min(line - 1, Math.max(0, document.lineCount - 1)), 0)
      editor.selection = new vscode.Selection(position, position)
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
    }
  }

  private async openDiff(callId: string): Promise<void> {
    const change = this.fileSnapshots.get(callId)
    if (change === undefined || change.after === undefined) throw new Error('Diff is no longer available')
    const root = this.context.storageUri ?? vscode.Uri.file(path.join(this.context.extensionPath, '.dsh-diffs'))
    await vscode.workspace.fs.createDirectory(root)
    const safe = callId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    const beforeUri = vscode.Uri.joinPath(root, `${safe}.before`), afterUri = vscode.Uri.joinPath(root, `${safe}.after`)
    await vscode.workspace.fs.writeFile(beforeUri, Buffer.from(change.before ?? '', 'utf8'))
    await vscode.workspace.fs.writeFile(afterUri, Buffer.from(change.after, 'utf8'))
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `${path.basename(change.path)} (DeepSeek change)`)
  }

  private async openGitDiff(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) throw new Error('Open a workspace before viewing Git diff')
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], { cwd, maxBuffer: 4 * 1024 * 1024 })
    const document = await vscode.workspace.openTextDocument({ content: stdout === '' ? 'Working tree is clean.\n' : stdout, language: 'diff' })
    await vscode.window.showTextDocument(document, { preview: true })
  }

  private async openGitFileDiff(filePath: string): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) throw new Error('Open a workspace before viewing Git diff')
    const relative = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--', relative], { cwd, maxBuffer: 4 * 1024 * 1024 })
    const document = await vscode.workspace.openTextDocument({ content: stdout === '' ? `No Git diff for ${relative}.\n` : stdout, language: 'diff' })
    await vscode.window.showTextDocument(document, { preview: true })
  }

  private async reviewDiff(callId: string, decision: 'kept' | 'reverted'): Promise<void> {
    const change = this.fileSnapshots.get(callId)
    if (change === undefined || change.after === undefined) throw new Error('Diff is no longer available')
    try { await (await this.runtime.start()).reviewChange(callId, decision) } catch { /* older runtime: use the extension snapshot below */ }
    if (decision === 'reverted') {
      if (change.before === undefined) await vscode.workspace.fs.delete(vscode.Uri.file(change.path), { useTrash: false })
      else await vscode.workspace.fs.writeFile(vscode.Uri.file(change.path), Buffer.from(change.before, 'utf8'))
    }
    change.decision = decision
    await this.persistFileChange(callId)
    const sessionId = this.activeSessionId
    if (sessionId !== undefined) this.append({ type: 'file.reviewed', sessionId, callId, path: change.path, decision })
  }

  private async activateStoredSession(): Promise<void> {
    const generation = ++this.activationGeneration
    if (this.view === undefined) return
    this.trajectoryEvents = []
    this.historyHasMore = false
    this.historyBefore = undefined
    // Render the shell as soon as the WebView is ready, then run credential and
    // session hydration concurrently. Credential metadata must not make the
    // initial chat surface wait behind a cold runtime or a large session list.
    await this.postState()
    const adapter = await this.runtime.start()
    const settingsTask = this.refreshSettings(adapter)
    // The active id is persisted locally. In the normal case it lets the
    // first history page travel while the runtime scans its complete session
    // index, rather than making those two RPCs serial.
    const preferredId = this.activeSessionId
    const preferredDataTask = preferredId === undefined ? undefined : Promise.all([
      adapter.history(preferredId, { limit: INITIAL_HISTORY_EVENTS }),
      adapter.pendingApprovals(preferredId),
      adapter.sessionStatus(preferredId),
    ])
    const sessions = await adapter.listSessions()
    if (generation !== this.activationGeneration) return
    const localTitles = new Map(this.sessions.map(item => [item.id, item.title]))
    this.sessions = sessions.map(item => ({ ...item, ...(localTitles.get(item.id) === undefined || localTitles.get(item.id) === 'New session' ? {} : { title: localTitles.get(item.id) }) }))
    if (this.activeSessionId === undefined || !sessions.some(item => item.id === this.activeSessionId)) this.activeSessionId = sessions[0]?.id
    const id = this.activeSessionId
    if (id === undefined) {
      this.events = []
      await settingsTask; await this.persist(); await this.postState(); return
    }
    const [historyPage, pending, status] = id === preferredId && preferredDataTask !== undefined
      ? await preferredDataTask
      : await Promise.all([adapter.history(id, { limit: INITIAL_HISTORY_EVENTS }), adapter.pendingApprovals(id), adapter.sessionStatus(id)])
    if (generation !== this.activationGeneration) return
    const history = historyPage.events
    this.historyHasMore = historyPage.hasMore
    this.historyBefore = historyPage.firstSeq
    const resolved = new Set(history.flatMap(event => event.type === 'approval.resolved' ? [event.approvalId] : []))
    const known = new Set(history.flatMap(event => event.type === 'approval.requested' ? [event.approvalId] : []))
    this.events = [...history, ...pending.filter(event => event.type === 'approval.requested' && !known.has(event.approvalId) && !resolved.has(event.approvalId)), { type: 'status.changed', sessionId: id, status }]
    this.subscribe(adapter, id)
    await settingsTask; await this.persist(); await this.postState()
    void this.hydrateChangesAfterFirstPaint(id, generation)
    void this.refreshGitChanges()
  }

  private async hydrateChangesAfterFirstPaint(sessionId: string, generation: number): Promise<void> {
    await this.hydrateFileChanges(sessionId)
    if (generation !== this.activationGeneration || sessionId !== this.activeSessionId) return
    const changes = this.persistedChanges.filter(change => change.sessionId === sessionId && this.fileSnapshots.has(change.callId))
    if (changes.length === 0) return
    this.events = [...this.events, ...changes.flatMap(change => [{ type: 'file.changed' as const, sessionId, callId: change.callId, path: change.path }, ...(change.decision === undefined ? [] : [{ type: 'file.reviewed' as const, sessionId, callId: change.callId, path: change.path, decision: change.decision }])])]
    await this.postState()
  }

  private subscribe(adapter: HarnessAdapter, id: string): void {
    this.subscription?.dispose()
    this.subscription = adapter.subscribe(id, event => this.append(event))
  }

  private append(event: HarnessEvent): void {
    if (event.sessionId !== undefined && event.sessionId !== this.activeSessionId) return
    if (event.type === 'session.title') {
      const session = this.sessions.find(item => item.id === event.sessionId)
      if (session !== undefined) session.title = event.title
      void this.persist(); void this.postState(); return
    }
    if (event.type === 'tool.started') void this.captureFileBefore(event)
    if (event.type === 'tool.completed') void this.captureFileAfter(event)
    this.events.push(event)
    if (this.events.length > MAX_PRESENTATION_EVENTS) this.events.splice(0, this.events.length - MAX_PRESENTATION_EVENTS)
    void this.view?.webview.postMessage({ type: 'event', event })
  }

  private async captureFileBefore(event: Extract<HarnessEvent, { type: 'tool.started' }>): Promise<void> {
    const target = filePathFromArguments(event.arguments)
    if (target === undefined || !isInsideWorkspace(target)) return
    try { this.fileSnapshots.set(event.callId, { path: target, sessionId: event.sessionId, before: await fs.readFile(target, 'utf8') }) }
    catch { this.fileSnapshots.set(event.callId, { path: target, sessionId: event.sessionId }) }
    await this.persistFileChange(event.callId)
  }

  private async captureFileAfter(event: Extract<HarnessEvent, { type: 'tool.completed' }>): Promise<void> {
    const current = this.fileSnapshots.get(event.callId)
    if (current === undefined) return
    try {
      current.after = await fs.readFile(current.path, 'utf8')
      await this.persistFileChange(event.callId)
      if (current.before !== current.after) this.append({ type: 'file.changed', sessionId: event.sessionId, callId: event.callId, path: current.path })
    } catch { /* created/deleted files are handled in a later pass */ }
  }

  private async persistFileChange(callId: string): Promise<void> {
    const change = this.fileSnapshots.get(callId)
    if (change === undefined) return
    const root = vscode.Uri.joinPath(this.context.globalStorageUri, 'file-changes')
    await vscode.workspace.fs.createDirectory(root)
    const safe = callId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    const beforeFile = change.before === undefined ? undefined : vscode.Uri.joinPath(root, `${safe}.before`).fsPath
    const afterFile = change.after === undefined ? undefined : vscode.Uri.joinPath(root, `${safe}.after`).fsPath
    if (beforeFile !== undefined) await fs.writeFile(beforeFile, change.before ?? '', 'utf8')
    if (afterFile !== undefined) await fs.writeFile(afterFile, change.after ?? '', 'utf8')
    const entry: PersistedFileChange = { callId, sessionId: change.sessionId, path: change.path, ...(beforeFile === undefined ? {} : { beforeFile }), ...(afterFile === undefined ? {} : { afterFile }), ...(change.decision === undefined ? {} : { decision: change.decision }) }
    this.persistedChanges = [...this.persistedChanges.filter(item => item.callId !== callId), entry]
    await this.context.globalState.update(FILE_CHANGE_KEY, this.persistedChanges)
  }

  private async hydrateFileChanges(sessionId: string): Promise<void> {
    for (const item of this.persistedChanges.filter(change => change.sessionId === sessionId)) {
      try {
        const before = item.beforeFile === undefined ? undefined : await fs.readFile(item.beforeFile, 'utf8')
        const after = item.afterFile === undefined ? undefined : await fs.readFile(item.afterFile, 'utf8')
        this.fileSnapshots.set(item.callId, { path: item.path, sessionId, before, after, ...(item.decision === undefined ? {} : { decision: item.decision }) })
      } catch { /* stale snapshots are ignored */ }
    }
  }

  private async refreshSettings(adapter?: HarnessAdapter): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseekHarness')
    this.settings = { ...this.settings, provider: config.get('provider', 'deepseek-official'), model: config.get('model', 'deepseek-v4-flash'), endpoint: config.get('endpoint', ''), permissionMode: config.get('permissionMode', 'workspace-write'), loading: true }
    await this.postState()
    const runtimeAdapter = adapter ?? await this.runtime.start()
    this.settings = { ...this.settings, credential: await runtimeAdapter.credentialStatus(), loading: false }
    await this.postState()
  }

  private async saveSettings(message: Extract<WebviewToExtensionMessage, { type: 'saveSettings' }>): Promise<void> {
    const provider = message.provider.trim(), model = message.model.trim()
    if (provider === '' || model === '') throw new Error('Provider and model are required')
    if (provider !== 'deepseek-official') throw new Error('The bundled runtime currently supports DeepSeek Official only')
    const config = vscode.workspace.getConfiguration('deepseekHarness')
    const endpoint = message.endpoint.trim(), permissionMode = message.permissionMode
    if (endpoint !== '') {
      let parsed: URL
      try { parsed = new URL(endpoint) } catch { throw new Error('API endpoint must be a valid http(s) URL') }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('API endpoint must use http or https')
    }
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(permissionMode)) throw new Error('Invalid permission mode')
    const changedRuntime = provider !== config.get('provider', 'deepseek-official') || model !== config.get('model', 'deepseek-v4-flash') || endpoint !== config.get('endpoint', '') || permissionMode !== config.get('permissionMode', 'workspace-write')
    await Promise.all([config.update('provider', provider, vscode.ConfigurationTarget.Global), config.update('model', model, vscode.ConfigurationTarget.Global), config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global), config.update('permissionMode', permissionMode, vscode.ConfigurationTarget.Global)])
    const adapter = await this.runtime.start()
    const changedCredential = message.apiKey !== undefined && message.apiKey.trim() !== ''
    if (changedCredential) await adapter.setCredential(message.apiKey ?? '')
    if (changedRuntime || changedCredential) await this.runtime.restart()
    await this.activateStoredSession()
  }

  private async removeApiKey(): Promise<void> {
    const adapter = await this.runtime.start()
    await adapter.unsetCredential(); await this.runtime.restart(); await this.activateStoredSession()
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    void vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`)
    this.append({ type: 'error', ...(this.activeSessionId === undefined ? {} : { sessionId: this.activeSessionId }), message })
    void this.postState()
  }

  private persist(): Thenable<void> { return this.context.globalState.update(SESSION_KEY, this.sessions) }

  private postState(): Thenable<boolean> | undefined {
    const state: WebviewState = {
      runtime: this.runtime.getStatus(), sessions: this.sessions, commands: this.commands, plugins: this.plugins,
      ...(this.activeSessionId === undefined ? {} : { activeSessionId: this.activeSessionId }),
      events: this.events, historyHasMore: this.historyHasMore, trajectoryEvents: this.trajectoryEvents, attachedFiles: this.contextBridge.attachedFiles, settings: this.settings, gitChanges: this.gitChanges,
    }
    return this.view?.webview.postMessage({ type: 'state', state })
  }

  private async refreshGitChanges(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd === undefined) return
    try {
      const { stdout } = await execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd, maxBuffer: 2 * 1024 * 1024 })
      this.gitChanges = stdout.split('\n').filter(Boolean).flatMap(line => {
        const status = line.slice(0, 2).trim() || '?', file = line.slice(3).trim()
        return file === '' ? [] : [{ path: path.isAbsolute(file) ? file : path.join(cwd, file), status }]
      })
      await this.postState()
    } catch { this.gitChanges = [] }
  }

  private html(webview: vscode.Webview): string {
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', 'index.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', 'index.css'))
    const nonce = randomBytes(16).toString('base64')
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`
  }
}

function filePathFromArguments(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      const candidate = record.path ?? record.file_path ?? record.filePath
      return typeof candidate === 'string' ? path.resolve(candidate) : undefined
    }
  } catch { /* non-JSON tool arguments */ }
  return undefined
}

function isInsideWorkspace(target: string): boolean {
  const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => path.resolve(folder.uri.fsPath))
  return roots.some(root => target === root || target.startsWith(`${root}${path.sep}`))
}
