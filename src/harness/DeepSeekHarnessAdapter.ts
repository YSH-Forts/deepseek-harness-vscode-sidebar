import { randomUUID } from 'node:crypto'
import type { Disposable } from 'vscode'
import type { AgentContext, CredentialStatus, HarnessCommand, HarnessEvent, PluginInfo, SessionSummary } from '../shared/protocol.ts'
import type { HarnessAdapter, HistoryPage, RuntimeStatus } from './HarnessAdapter.ts'
import { HarnessClient, isRecord, type HarnessNotification } from './HarnessClient.ts'
import { HarnessEventMapper } from './HarnessEventMapper.ts'

export class DeepSeekHarnessAdapter implements HarnessAdapter {
  private client: HarnessClient | undefined
  private status: RuntimeStatus = { state: 'stopped' }
  private readonly handlers = new Map<string, Set<(event: HarnessEvent) => void>>()
  private notificationSubscription: Disposable | undefined
  private closeSubscription: Disposable | undefined
  private readonly mapper = new HarnessEventMapper()

  constructor(private readonly launch: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; provider: string; model: string; onStderr?: (line: string) => void; onStatus?: (status: RuntimeStatus) => void }) {}
  getStatus(): RuntimeStatus { return this.status }
  private setStatus(status: RuntimeStatus): void { this.status = status; this.launch.onStatus?.(status) }
  async start(): Promise<void> {
    if (this.status.state === 'ready') return
    this.setStatus({ state: 'starting' })
    const client = new HarnessClient(this.launch)
    try {
      client.start()
      const initialized = await client.initialize({ cwd: this.launch.cwd, provider: this.launch.provider, model: this.launch.model })
      if (initialized.serverInfo.name !== 'deepseek-harness-sdk-runtime') {
        throw new Error(`Incompatible DeepSeek Harness runtime: ${initialized.serverInfo.name}/${initialized.serverInfo.version}`)
      }
      this.client = client; this.setStatus({ state: 'ready', version: initialized.serverInfo.version })
      this.notificationSubscription = client.subscribe(notification => this.dispatch(notification))
      this.closeSubscription = client.onClose(error => {
        if (this.client !== client) return
        this.setStatus({ state: 'error', message: error.message })
        for (const [sessionId, handlers] of this.handlers) for (const handler of handlers) handler({ type: 'error', sessionId, message: error.message })
      })
    } catch (error) {
      await client.close(); this.setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) }); throw error
    }
  }
  async stop(): Promise<void> { this.notificationSubscription?.dispose(); this.closeSubscription?.dispose(); const client = this.client; this.client = undefined; await client?.close(); this.setStatus({ state: 'stopped' }) }
  async createSession(): Promise<{ id: string }> { return this.resumeSession(`vscode-${randomUUID().replaceAll('-', '')}`) }
  async resumeSession(sessionId: string): Promise<{ id: string }> { await this.required().history(sessionId, { limit: 1 }); return { id: sessionId } }
  async listSessions(): Promise<SessionSummary[]> {
    return (await this.required().listSessions()).flatMap(item => typeof item.id === 'string' && typeof item.title === 'string' && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number'
      ? [{ id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, ...(typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {}) }]
      : [])
  }
  async listCommands(): Promise<HarnessCommand[]> {
    return (await this.required().listCommands()).flatMap(item => typeof item.name === 'string' && typeof item.description === 'string'
      ? [{ name: item.name, description: item.description, ...(isRecord(item.input) && typeof item.input.hint === 'string' ? { inputHint: item.input.hint } : {}) }]
      : [])
  }
  async listPlugins(): Promise<PluginInfo[]> {
    return (await this.required().listPlugins()).flatMap(item => typeof item.entryId === 'string' && typeof item.enabled === 'boolean' && typeof item.fiberPhase === 'string'
      ? [{ id: item.entryId, enabled: item.enabled, phase: item.fiberPhase }]
      : [])
  }
  async pendingApprovals(sessionId: string): Promise<HarnessEvent[]> {
    return (await this.required().listApprovals(sessionId)).flatMap(params => {
      const mapped = this.mapper.map({ method: 'approval.requested', params })
      return mapped === undefined ? [] : [mapped]
    })
  }
  sessionStatus(sessionId: string): Promise<'idle' | 'running'> { return this.required().sessionStatus(sessionId) }
  forkSession(sessionId: string): Promise<string> { return this.required().forkSession(sessionId) }
  deleteSession(sessionId: string): Promise<boolean> { return this.required().deleteSession(sessionId) }
  listChanges(sessionId: string): Promise<Record<string, unknown>[]> { return this.required().listChanges(sessionId) }
  reviewChange(callId: string, decision: 'kept' | 'reverted'): Promise<boolean> { return this.required().reviewChange(callId, decision) }
  async history(sessionId: string, options: { limit?: number; before?: number } = {}): Promise<HistoryPage> {
    const page = await this.required().history(sessionId, options)
    return { events: page.events.flatMap(event => { const mapped = this.mapper.mapSessionEvent(sessionId, event); return mapped === undefined ? [] : [mapped] }), hasMore: page.hasMore, ...(page.firstSeq === undefined ? {} : { firstSeq: page.firstSeq }) }
  }
  async rawHistory(sessionId: string): Promise<Record<string, unknown>[]> { return (await this.required().history(sessionId)).events }
  async sendMessage(sessionId: string, message: string, context: AgentContext): Promise<void> { await this.required().prompt(sessionId, formatContent(message, context)) }
  async cancel(sessionId: string): Promise<void> { if (!await this.required().cancel(sessionId)) throw new Error(`Unknown session: ${sessionId}`) }
  async steer(sessionId: string, instruction: string): Promise<void> { if (!await this.required().steer(sessionId, [{ type: 'text', text: instruction }])) throw new Error(`Unknown session: ${sessionId}`) }
  async respondApproval(sessionId: string, approvalId: string, decision: 'allowed-once' | 'rejected'): Promise<void> { if (!await this.required().respondApproval(sessionId, approvalId, decision)) throw new Error('The approval is no longer pending') }
  credentialStatus(): Promise<CredentialStatus> { return this.required().credentialStatus() }
  setCredential(value: string): Promise<CredentialStatus> { return this.required().setCredential(value) }
  unsetCredential(): Promise<CredentialStatus> { return this.required().unsetCredential() }
  subscribe(sessionId: string, handler: (event: HarnessEvent) => void): Disposable {
    const handlers = this.handlers.get(sessionId) ?? new Set(); handlers.add(handler); this.handlers.set(sessionId, handlers)
    return { dispose: () => { handlers.delete(handler); if (handlers.size === 0) this.handlers.delete(sessionId) } }
  }
  private required(): HarnessClient { if (this.client === undefined || this.status.state !== 'ready') throw new Error('DeepSeek Harness runtime is not ready'); return this.client }
  private dispatch(notification: HarnessNotification): void {
    const event = this.mapper.map(notification); if (event === undefined || event.sessionId === undefined) return
    for (const handler of this.handlers.get(event.sessionId) ?? []) handler(event)
  }
}

function formatContent(message: string, context: AgentContext): Record<string, unknown>[] {
  const sections: string[] = []
  if (context.mode !== undefined) sections.push(`Execution Mode: ${modeInstruction(context.mode)}`)
  if (context.workspace !== undefined) sections.push(`Workspace:\n${context.workspace.roots.join('\n')}`)
  if (context.activeFile !== undefined) sections.push(`Current File: ${context.activeFile.path}\nLanguage: ${context.activeFile.language}\nCursor: ${context.activeFile.line}:${context.activeFile.column}`)
  if (context.selection !== undefined) sections.push(`Selection: ${context.selection.path}:${context.selection.startLine}-${context.selection.endLine}\n\n${context.selection.text}`)
  if (context.tabs.length > 0) sections.push(`Open Tabs:\n${context.tabs.join('\n')}`)
  if (context.diagnostics.length > 0) sections.push(`Diagnostics:\n${context.diagnostics.map(item => `${item.path}:${item.line} [${item.severity}] ${item.message}`).join('\n')}`)
  if (context.git?.diff !== undefined && context.git.diff !== '') sections.push(`Git Diff:\n${context.git.diff}`)
  for (const attachment of context.attachments) sections.push(`Attached File: ${attachment.path}\n\n${attachment.text}`)
  return [
    { type: 'text', text: message },
    ...(sections.length === 0 ? [] : [{ type: 'text', text: `<ide_context>\n${sections.join('\n\n---\n\n')}\n</ide_context>` }]),
  ]
}

function modeInstruction(mode: string): string {
  if (mode === 'plan') return 'Plan mode. First explain a concise, actionable plan; do not make changes or call tools until the user explicitly asks you to execute it.'
  if (mode === 'code') return 'Code mode. Prioritize code generation and use code to orchestrate task steps.'
  if (mode === 'minimal') return 'Minimal mode. Prefer a small, direct workflow using only essential shell and file operations.'
  if (mode === 'creator') return 'Creator mode. Focus on inspecting the current runtime and designing, testing, or composing Cordis plugins.'
  return 'Standard mode. Use the full DeepSeek Harness toolset as appropriate.'
}
