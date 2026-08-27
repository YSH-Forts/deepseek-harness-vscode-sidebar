import type { HarnessEvent, PlanItem } from '../shared/protocol.ts'
import type { HarnessNotification } from './HarnessClient.ts'
import { isRecord } from './HarnessClient.ts'

function textOf(value: unknown): string {
  return Array.isArray(value) ? value.map(block => isRecord(block) && (block.type === 'text' || block.type === 'reasoning') ? String(block.text ?? '') : '').join('') : ''
}

function firstTextOf(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const block = value.find(candidate => isRecord(candidate) && candidate.type === 'text' && typeof candidate.text === 'string')
  return isRecord(block) ? String(block.text ?? '') : ''
}

export class HarnessEventMapper {
  map(notification: HarnessNotification): HarnessEvent | undefined {
    const { params } = notification
    if (notification.method === 'subagent.started' && typeof params.parentSessionId === 'string' && typeof params.childSessionId === 'string') return { type: 'subagent.started', sessionId: params.parentSessionId, childSessionId: params.childSessionId }
    if (notification.method === 'subagent.finished' && typeof params.parentSessionId === 'string' && typeof params.childSessionId === 'string' && (params.status === 'ok' || params.status === 'error')) return { type: 'subagent.finished', sessionId: params.parentSessionId, childSessionId: params.childSessionId, status: params.status, ...(typeof params.stopReason === 'string' ? { stopReason: params.stopReason } : {}), ...(Array.isArray(params.lastAssistantMessage) ? { message: textOf(params.lastAssistantMessage) } : {}) }
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (notification.method === 'session.status' && sessionId !== undefined && (params.status === 'idle' || params.status === 'running')) return { type: 'status.changed', sessionId, status: params.status }
    if (notification.method === 'approval.requested' && sessionId !== undefined && typeof params.approvalId === 'string' && typeof params.toolName === 'string') return {
      type: 'approval.requested', sessionId, approvalId: params.approvalId, toolName: params.toolName,
      ...(typeof params.callId === 'string' ? { callId: params.callId } : {}), ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
    }
    if (notification.method === 'session.prompt-error' && sessionId !== undefined && typeof params.message === 'string') return { type: 'error', sessionId, message: params.message }
    return notification.method === 'session.event' && sessionId !== undefined ? this.mapSessionEvent(sessionId, params.event) : undefined
  }

  mapSessionEvent(sessionId: string, raw: unknown): HarnessEvent | undefined {
    if (!isRecord(raw) || !isRecord(raw.data) || typeof raw.type !== 'string') return undefined
    const data = raw.data; const seq = typeof raw.seq === 'number' ? { eventSeq: raw.seq } : {}
    switch (raw.type) {
      case 'turn/start': return { type: 'assistant.started', sessionId, turn: Number(data.turn), step: 0 }
      case 'user/message': return { type: 'user.message', sessionId, text: firstTextOf(data.content), ...seq }
      case 'assistant/chunk': {
        const chunk = isRecord(data.chunk) ? data.chunk : undefined
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') return { type: 'assistant.chunk', sessionId, text: chunk.text, reasoning: false, ...seq }
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') return { type: 'assistant.chunk', sessionId, text: chunk.text, reasoning: true, ...seq }
        if (chunk?.type === 'usage' && isRecord(chunk.usage) && typeof chunk.usage.inputTokens === 'number') return { type: 'context.usage', sessionId, inputTokens: chunk.usage.inputTokens, ...(typeof chunk.usage.outputTokens === 'number' ? { outputTokens: chunk.usage.outputTokens } : {}), ...seq }
        return undefined
      }
      case 'assistant/message': { const message = isRecord(data.message) ? data.message : undefined; return { type: 'assistant.completed', sessionId, text: textOf(message?.content), ...seq } }
      case 'command/done':
        if (data.kind === 'success' && typeof data.text === 'string') return { type: 'assistant.completed', sessionId, text: data.text, ...seq }
        if (data.kind === 'error' && typeof data.text === 'string') return { type: 'error', sessionId, message: data.text, ...seq }
        return undefined
      case 'tool/call': return typeof data.callId === 'string' && typeof data.name === 'string' ? { type: 'tool.started', sessionId, callId: data.callId, name: data.name, arguments: String(data.arguments ?? ''), ...seq } : undefined
      case 'tool/result': {
        const message = isRecord(data.message) ? data.message : undefined; const source = isRecord(message?.source) ? message.source : undefined
        return typeof source?.callId === 'string' ? { type: 'tool.completed', sessionId, callId: source.callId, result: textOf(message?.content), failed: data.error !== undefined, ...seq } : undefined
      }
      case 'todo/write': {
        const items: PlanItem[] = Array.isArray(data.todos) ? data.todos.flatMap(value => {
          if (!isRecord(value) || typeof value.content !== 'string' || !['pending', 'in_progress', 'completed'].includes(String(value.status))) return []
          return [{ content: value.content, status: value.status as PlanItem['status'] }]
        }) : []
        return { type: 'plan.updated', sessionId, items, ...seq }
      }
      case 'goal/change': {
        const goal = isRecord(data.goal) ? data.goal : undefined
        if (goal === undefined || typeof goal.objective !== 'string' || typeof goal.phase !== 'string') return undefined
        const blocked = isRecord(goal.blockedReason) ? String(goal.blockedReason.message ?? '') : undefined
        return { type: 'goal.updated', sessionId, objective: goal.objective, phase: goal.phase, ...(typeof data.roundsStarted === 'number' ? { roundsStarted: data.roundsStarted } : {}), ...(typeof goal.maxGoalRounds === 'number' ? { maxGoalRounds: goal.maxGoalRounds } : {}), ...(blocked === undefined ? {} : { blockedReason: blocked }), ...seq }
      }
      case 'approval/asked': return typeof data.id === 'string' && typeof data.toolName === 'string' ? {
        type: 'approval.requested', sessionId, approvalId: data.id, toolName: data.toolName,
        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}), ...seq,
      } : undefined
      case 'approval/decided': return typeof data.id === 'string' ? {
        type: 'approval.resolved', sessionId, approvalId: data.id,
        ...(typeof data.outcome === 'string' ? { decision: data.outcome } : {}), ...seq,
      } : undefined
      case 'session/title': return typeof data.title === 'string' ? { type: 'session.title', sessionId, title: data.title, ...seq } : undefined
      case 'turn/end': {
        const reason = isRecord(data.reason) ? data.reason : undefined; const error = isRecord(reason?.error) ? reason.error : undefined
        return reason?.kind === 'error' ? { type: 'error', sessionId, message: String(error?.message ?? 'Agent turn failed') } : undefined
      }
      default: return undefined
    }
  }
}
