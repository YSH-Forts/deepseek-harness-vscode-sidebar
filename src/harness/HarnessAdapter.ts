import type { Disposable } from 'vscode'
import type { AgentContext, CredentialStatus, HarnessCommand, HarnessEvent, PluginInfo, RuntimeState, SessionSummary } from '../shared/protocol.ts'
export interface RuntimeStatus { state: RuntimeState; message?: string; version?: string }
export interface HistoryPage { events: HarnessEvent[]; hasMore: boolean; firstSeq?: number }
export interface HarnessAdapter {
  start(): Promise<void>; stop(): Promise<void>; getStatus(): RuntimeStatus
  createSession(): Promise<{ id: string }>; resumeSession(sessionId: string): Promise<{ id: string }>
  listSessions(): Promise<SessionSummary[]>; listCommands(): Promise<HarnessCommand[]>; listPlugins(): Promise<PluginInfo[]>; sessionStatus(sessionId: string): Promise<'idle' | 'running'>; pendingApprovals(sessionId: string): Promise<HarnessEvent[]>
  forkSession(sessionId: string): Promise<string>
  deleteSession(sessionId: string): Promise<boolean>
  listChanges(sessionId: string): Promise<Record<string, unknown>[]>; reviewChange(callId: string, decision: 'kept' | 'reverted'): Promise<boolean>
  history(sessionId: string, options?: { limit?: number; before?: number }): Promise<HistoryPage>; rawHistory(sessionId: string): Promise<Record<string, unknown>[]>; sendMessage(sessionId: string, message: string, context: AgentContext): Promise<void>
  cancel(sessionId: string): Promise<void>; steer(sessionId: string, instruction: string): Promise<void>
  respondApproval(sessionId: string, approvalId: string, decision: 'allowed-once' | 'rejected'): Promise<void>
  credentialStatus(): Promise<CredentialStatus>; setCredential(value: string): Promise<CredentialStatus>; unsetCredential(): Promise<CredentialStatus>
  subscribe(sessionId: string, handler: (event: HarnessEvent) => void): Disposable
}
