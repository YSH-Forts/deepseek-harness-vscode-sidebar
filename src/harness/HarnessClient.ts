import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

export interface HarnessNotification { method: string; params: Record<string, unknown> }
interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }

export class HarnessClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private lines: Interface | undefined
  private serial = 0
  private closed = false
  private stderr = ''
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<(notification: HarnessNotification) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private terminalError: Error | undefined

  constructor(private readonly launch: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; onStderr?: (line: string) => void; promptTimeoutMs?: number }) {}

  start(): void {
    if (this.child !== undefined) return
    if (this.closed) throw new Error('Harness client is closed')
    const child = spawn(this.launch.command, this.launch.args, { cwd: this.launch.cwd, env: this.launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-64_000); for (const line of chunk.split('\n')) if (line.trim() !== '') this.launch.onStderr?.(line) })
    child.once('error', error => this.fail(new Error(`Runtime failed to start: ${error.message}`)))
    child.once('exit', code => this.fail(new Error(`Runtime exited with code ${String(code)}${this.stderr === '' ? '' : `\n${this.stderr}`}`)))
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', line => this.receive(line))
  }

  async initialize(params: { cwd: string; provider: string; model: string }): Promise<{ serverInfo: { name: string; version: string } }> {
    const result = await this.request('initialize', params, 45_000)
    if (!isRecord(result) || !isRecord(result.serverInfo) || typeof result.serverInfo.version !== 'string' || typeof result.serverInfo.name !== 'string') throw new Error('Runtime returned an invalid initialize response')
    return { serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version } }
  }

  async prompt(sessionId: string, contentBlocks: Record<string, unknown>[]): Promise<void> {
    // Prompt admission can briefly wait for a recovering or busy runtime. This
    // acknowledges queueing only; model output continues through notifications.
    await this.request('session/prompt', { sessionId, contentBlocks }, this.launch.promptTimeoutMs ?? 45_000)
  }

  async history(sessionId: string): Promise<Record<string, unknown>[]> {
    const result = await this.request('session/history', { sessionId }, 30_000)
    if (!isRecord(result) || !Array.isArray(result.events)) throw new Error('Runtime returned invalid session history')
    return result.events.filter(isRecord)
  }

  async listSessions(): Promise<Record<string, unknown>[]> {
    const result = await this.request('session/list', {}, 30_000)
    if (!isRecord(result) || !Array.isArray(result.items)) throw new Error('Runtime returned an invalid session list')
    return result.items.filter(isRecord)
  }

  async sessionStatus(sessionId: string): Promise<'idle' | 'running'> {
    const result = await this.request('session/status', { sessionId })
    if (!isRecord(result) || (result.status !== 'idle' && result.status !== 'running')) throw new Error('Runtime returned an invalid session status')
    return result.status
  }

  async listCommands(): Promise<Record<string, unknown>[]> {
    const result = await this.request('commands/list', {})
    if (!isRecord(result) || !Array.isArray(result.items)) throw new Error('Runtime returned an invalid command list')
    return result.items.filter(isRecord)
  }

  async listPlugins(): Promise<Record<string, unknown>[]> {
    const result = await this.request('plugins/list', {})
    if (!isRecord(result) || !Array.isArray(result.items)) throw new Error('Runtime returned an invalid plugin list')
    return result.items.filter(isRecord)
  }

  async forkSession(sessionId: string): Promise<string> {
    const result = await this.request('session/fork', { sessionId })
    if (!isRecord(result) || typeof result.sessionId !== 'string') throw new Error('Runtime returned an invalid fork result')
    return result.sessionId
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.request('session/delete', { sessionId })
    if (!isRecord(result) || typeof result.accepted !== 'boolean') throw new Error('Runtime returned an invalid delete result')
    return result.accepted
  }

  async listChanges(sessionId: string): Promise<Record<string, unknown>[]> {
    const result = await this.request('session/changes', { sessionId })
    if (!isRecord(result) || !Array.isArray(result.items)) throw new Error('Runtime returned an invalid change list')
    return result.items.filter(isRecord)
  }

  async reviewChange(callId: string, decision: 'kept' | 'reverted'): Promise<boolean> {
    const result = await this.request('session/change-review', { callId, decision })
    if (!isRecord(result) || typeof result.accepted !== 'boolean') throw new Error('Runtime returned an invalid change review result')
    return result.accepted
  }

  async listApprovals(sessionId: string): Promise<Record<string, unknown>[]> {
    const result = await this.request('approval/list', { sessionId })
    if (!isRecord(result) || !Array.isArray(result.items)) throw new Error('Runtime returned an invalid approval list')
    return result.items.filter(isRecord)
  }

  async credentialStatus(): Promise<{ configured: boolean; writable: boolean; source?: string }> {
    return this.parseCredential(await this.request('credentials/describe', {}))
  }

  async setCredential(value: string): Promise<{ configured: boolean; writable: boolean; source?: string }> {
    return this.parseCredential(await this.request('credentials/set', { value }))
  }

  async unsetCredential(): Promise<{ configured: boolean; writable: boolean; source?: string }> {
    return this.parseCredential(await this.request('credentials/unset', {}))
  }

  cancel(sessionId: string): Promise<boolean> { return this.mutation('session/cancel', { sessionId }) }
  steer(sessionId: string, contentBlocks: Record<string, unknown>[]): Promise<boolean> { return this.mutation('session/steer', { sessionId, contentBlocks }) }
  respondApproval(sessionId: string, approvalId: string, decision: string): Promise<boolean> { return this.mutation('approval/respond', { sessionId, approvalId, decision }) }

  subscribe(listener: (notification: HarnessNotification) => void): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  onClose(listener: (error: Error) => void): { dispose(): void } {
    this.closeListeners.add(listener)
    if (this.terminalError !== undefined) listener(this.terminalError)
    return { dispose: () => { this.closeListeners.delete(listener) } }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { await this.request('shutdown', {}, 1_000) } catch { /* process exit is authoritative */ }
    this.lines?.close()
    if (this.child !== undefined && this.child.exitCode === null) this.child.kill('SIGTERM')
    this.fail(new Error('Harness client closed'))
  }

  private request(method: string, params: object, timeoutMs = 15_000): Promise<unknown> {
    this.start()
    const child = this.child
    if (child === undefined || child.exitCode !== null) return Promise.reject(new Error('Harness runtime is not running'))
    const id = this.serial++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (error !== null && error !== undefined) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }

  private async mutation(method: string, params: object): Promise<boolean> {
    const result = await this.request(method, params)
    if (!isRecord(result) || typeof result.accepted !== 'boolean') throw new Error(`${method} returned an invalid result`)
    return result.accepted
  }

  private parseCredential(value: unknown): { configured: boolean; writable: boolean; source?: string } {
    if (!isRecord(value) || typeof value.configured !== 'boolean' || typeof value.writable !== 'boolean') throw new Error('Runtime returned an invalid credential status')
    return { configured: value.configured, writable: value.writable, ...(typeof value.source === 'string' ? { source: value.source } : {}) }
  }

  private receive(line: string): void {
    let frame: unknown
    try { frame = JSON.parse(line) } catch { this.fail(new Error(`Runtime wrote non-JSON data to stdout: ${line}`)); return }
    if (!isRecord(frame)) return
    if (typeof frame.method === 'string') {
      const notification = { method: frame.method, params: isRecord(frame.params) ? frame.params : {} }
      for (const listener of this.listeners) listener(notification)
      return
    }
    if (typeof frame.id !== 'number') return
    const pending = this.pending.get(frame.id)
    if (pending === undefined) return
    this.pending.delete(frame.id); clearTimeout(pending.timer)
    const error = isRecord(frame.error) ? frame.error : undefined
    if (error !== undefined) pending.reject(new Error(String(error.message ?? 'JSON-RPC error')))
    else pending.resolve(frame.result)
  }

  private fail(error: Error): void {
    if (this.terminalError === undefined) {
      this.terminalError = error
      for (const listener of this.closeListeners) listener(error)
    }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
