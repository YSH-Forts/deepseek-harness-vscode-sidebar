import { describe, expect, it } from 'vitest'
import { HarnessEventMapper } from './HarnessEventMapper.ts'

describe('HarnessEventMapper — full event coverage', () => {
  const mapper = new HarnessEventMapper()

  describe('session.status notification', () => {
    it('maps idle and running statuses', () => {
      expect(mapper.map({ method: 'session.status', params: { sessionId: 's1', status: 'idle' } }))
        .toEqual({ type: 'status.changed', sessionId: 's1', status: 'idle' })
      expect(mapper.map({ method: 'session.status', params: { sessionId: 's1', status: 'running' } }))
        .toEqual({ type: 'status.changed', sessionId: 's1', status: 'running' })
    })

    it('ignores unknown statuses', () => {
      expect(mapper.map({ method: 'session.status', params: { sessionId: 's1', status: 'weird' } })).toBeUndefined()
    })

    it('ignores when sessionId is missing', () => {
      expect(mapper.map({ method: 'session.status', params: { status: 'idle' } })).toBeUndefined()
    })
  })

  describe('approval.requested notification', () => {
    it('maps full approval with callId and reason', () => {
      expect(mapper.map({ method: 'approval.requested', params: { sessionId: 's1', approvalId: 'a1', toolName: 'bash', callId: 'c1', reason: 'outside sandbox' } }))
        .toEqual({ type: 'approval.requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash', callId: 'c1', reason: 'outside sandbox' })
    })

    it('omits optional callId/reason when absent', () => {
      expect(mapper.map({ method: 'approval.requested', params: { sessionId: 's1', approvalId: 'a1', toolName: 'bash' } }))
        .toEqual({ type: 'approval.requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash' })
    })
  })

  describe('session.event — turn lifecycle', () => {
    it('maps turn/start to assistant.started', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'turn/start', seq: 1, data: { turn: 1 } }))
        .toEqual({ type: 'assistant.started', sessionId: 's1', turn: 1, step: 0 })
    })

    it('maps turn/end with error reason to error event', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'turn/end', seq: 99, data: { reason: { kind: 'error', error: { message: 'boom' } } } }))
        .toEqual({ type: 'error', sessionId: 's1', message: 'boom' })
    })

    it('maps turn/end with completed reason to undefined (no UI row)', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'turn/end', seq: 99, data: { reason: { kind: 'completed' } } })).toBeUndefined()
    })
  })

  describe('session.event — messages', () => {
    it('maps only the visible user text and hides structured IDE context', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] } }))
        .toEqual({ type: 'user.message', sessionId: 's1', text: 'hello', eventSeq: 2 })
    })

    it('maps durable approval and title events used during resume', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'approval/asked', seq: 3, data: { id: 'a1', toolName: 'bash', callId: 'c1' } }))
        .toEqual({ type: 'approval.requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash', callId: 'c1', eventSeq: 3 })
      expect(mapper.mapSessionEvent('s1', { type: 'approval/decided', seq: 4, data: { id: 'a1', outcome: 'rejected' } }))
        .toEqual({ type: 'approval.resolved', sessionId: 's1', approvalId: 'a1', decision: 'rejected', eventSeq: 4 })
      expect(mapper.mapSessionEvent('s1', { type: 'session/title', seq: 5, data: { title: 'A title' } }))
        .toEqual({ type: 'session.title', sessionId: 's1', title: 'A title', eventSeq: 5 })
    })

    it('maps assistant/message to assistant.completed', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'done' }] } } }))
        .toEqual({ type: 'assistant.completed', sessionId: 's1', text: 'done', eventSeq: 3 })
    })

    it('renders durable command results and errors in the conversation', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'command/done', seq: 4, data: { commandId: 'cmd-1', kind: 'success', text: 'Goal paused' } }))
        .toEqual({ type: 'assistant.completed', sessionId: 's1', text: 'Goal paused', eventSeq: 4 })
      expect(mapper.mapSessionEvent('s1', { type: 'command/done', seq: 5, data: { commandId: 'cmd-2', kind: 'error', text: 'Goal is unavailable' } }))
        .toEqual({ type: 'error', sessionId: 's1', message: 'Goal is unavailable', eventSeq: 5 })
    })
  })

  describe('session.event — assistant chunks', () => {
    it('maps text-delta to non-reasoning chunk', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'assistant/chunk', seq: 4, data: { chunk: { type: 'text-delta', text: 'hi' } } }))
        .toEqual({ type: 'assistant.chunk', sessionId: 's1', text: 'hi', reasoning: false, eventSeq: 4 })
    })

    it('maps reasoning-delta to reasoning chunk', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'assistant/chunk', seq: 5, data: { chunk: { type: 'reasoning-delta', text: 'thinking...' } } }))
        .toEqual({ type: 'assistant.chunk', sessionId: 's1', text: 'thinking...', reasoning: true, eventSeq: 5 })
    })

    it('ignores non-delta chunks (block-start/end)', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'assistant/chunk', seq: 6, data: { chunk: { type: 'block-start' } } })).toBeUndefined()
    })
  })

  describe('session.event — tools', () => {
    it('maps tool/call to tool.started', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'tool/call', seq: 7, data: { callId: 'c1', name: 'bash', arguments: 'ls' } }))
        .toEqual({ type: 'tool.started', sessionId: 's1', callId: 'c1', name: 'bash', arguments: 'ls', eventSeq: 7 })
    })

    it('maps tool/result to tool.completed (success)', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'tool/result', seq: 8, data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } }))
        .toEqual({ type: 'tool.completed', sessionId: 's1', callId: 'c1', result: 'ok', failed: false, eventSeq: 8 })
    })

    it('maps tool/result with error to failed tool.completed', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'tool/result', seq: 9, data: { error: 'nope', message: { source: { callId: 'c1' }, content: [] } } }))
        .toEqual({ type: 'tool.completed', sessionId: 's1', callId: 'c1', result: '', failed: true, eventSeq: 9 })
    })
  })

  describe('session.event — todo/plan', () => {
    it('maps todo/write to plan.updated with filtered items', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'todo/write', seq: 10, data: { todos: [
        { content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' },
      ] } })).toEqual({ type: 'plan.updated', sessionId: 's1', items: [
        { content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' },
      ], eventSeq: 10 })
    })

    it('filters out invalid todo items', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'todo/write', seq: 11, data: { todos: [{ content: 'x', status: 'bogus' }, { foo: 'bar' }] } }))
        .toEqual({ type: 'plan.updated', sessionId: 's1', items: [], eventSeq: 11 })
    })
  })

  describe('robustness', () => {
    it('returns undefined for unknown event types', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'unknown/thing', data: {} })).toBeUndefined()
    })

    it('returns undefined for malformed event (no data)', () => {
      expect(mapper.mapSessionEvent('s1', { type: 'assistant/chunk' })).toBeUndefined()
    })

    it('returns undefined for non-record event', () => {
      expect(mapper.mapSessionEvent('s1', null)).toBeUndefined()
      expect(mapper.mapSessionEvent('s1', 'string')).toBeUndefined()
    })
  })
})
