import { describe, expect, it } from 'vitest'
import { HarnessEventMapper } from './HarnessEventMapper.ts'

describe('HarnessEventMapper', () => {
  const mapper = new HarnessEventMapper()

  it('maps assistant deltas without exposing the native event', () => {
    expect(mapper.map({ method: 'session.event', params: { sessionId: 's1', event: {
      type: 'assistant/chunk', seq: 4, data: { chunk: { type: 'text-delta', text: 'hello' } },
    } } })).toEqual({ type: 'assistant.chunk', sessionId: 's1', text: 'hello', reasoning: false, eventSeq: 4 })
  })

  it('maps tool completion by call id', () => {
    expect(mapper.mapSessionEvent('s1', { type: 'tool/result', seq: 7, data: {
      message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'done' }] },
    } })).toEqual({ type: 'tool.completed', sessionId: 's1', callId: 'call-1', result: 'done', failed: false, eventSeq: 7 })
  })

  it('maps answerable approvals', () => {
    expect(mapper.map({ method: 'approval.requested', params: { sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: 'outside sandbox' } })).toEqual({
      type: 'approval.requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: 'outside sandbox',
    })
  })
})
