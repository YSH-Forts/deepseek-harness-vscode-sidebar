import type { HarnessAdapter } from '../harness/HarnessAdapter.ts'
export class ApprovalManager {
  constructor(private readonly adapter: () => HarnessAdapter | undefined) {}
  async respond(sessionId: string, approvalId: string, decision: 'allowed-once' | 'rejected'): Promise<void> {
    const adapter = this.adapter(); if (adapter === undefined) throw new Error('Runtime is not ready')
    await adapter.respondApproval(sessionId, approvalId, decision)
  }
}
