import type { HarnessEvent } from '../../shared/protocol.ts'

type Step = { key: string; kind: 'reasoning' | 'assistant' | 'tool' | 'plan' | 'approval' | 'goal' | 'error'; title: string; detail?: string; status?: 'running' | 'completed' | 'failed' }
type Turn = { key: string; prompt: string; context?: { workspace?: string; currentFile?: string }; steps: Step[] }

export function TrajectoryPanel({ events, rawEvents, title, onBack, onExport }: { events: HarnessEvent[]; rawEvents: Record<string, unknown>[]; title?: string; onBack(): void; onExport(): void }): JSX.Element {
  const raw = buildRawTrajectory(rawEvents), turns = raw.turns.length > 0 ? raw.turns : buildTurns(events)
  return <main className="trajectory-page">
    <header className="settings-header"><button className="icon-button" data-tooltip="Back to chat" aria-label="Back to chat" onClick={onBack}><BackIcon/></button><strong>Trajectory</strong><button className="trajectory-export" data-tooltip="Export session log" onClick={onExport}><DownloadIcon/><span>Export</span></button></header>
    <section className="trajectory-content">
      <div className="trajectory-heading"><h2>{title ?? 'Current chat'}</h2>{rawEvents.length === 0 ? <p>Loading full session log…</p> : <div className="trajectory-metrics"><span><ClockIcon/>Duration {formatDuration(raw.duration)}</span><span>Turns {raw.turns.length}</span><span>Calls {raw.calls}</span></div>}</div>
      {turns.length === 0 ? <div className="trajectory-empty">No trajectory has been recorded yet.</div> : <div className="trajectory-turns">{turns.map((turn, index) => <section className="trajectory-turn" key={turn.key}>
        <div className="trajectory-turn-head"><span>Turn {index + 1}</span><p>{turn.prompt}</p>{turn.context && <div className="trajectory-context">{turn.context.workspace && <small>Workspace: {turn.context.workspace}</small>}{turn.context.currentFile && <small>Current file: {turn.context.currentFile}</small>}</div>}</div>
        <div className="trajectory-steps">{turn.steps.length === 0 ? <small>Waiting for agent activity.</small> : turn.steps.map(step => <details className={`trajectory-step ${step.kind} ${step.status ?? ''}`} key={step.key}>
          <summary><span className="trajectory-dot"/><strong>{step.title}</strong>{step.status && <small>{step.status}</small>}</summary>
          {step.detail && <pre>{step.detail}</pre>}
        </details>)}</div>
      </section>)}</div>}
    </section>
  </main>
}

function buildTurns(events: HarnessEvent[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined
  const ensureTurn = (): Turn => current ??= { key: 'initial', prompt: 'Session activity', steps: [] }
  const appendText = (kind: 'reasoning' | 'assistant', text: string, key: string): void => {
    const steps = ensureTurn().steps, last = steps.at(-1)
    if (last?.kind === kind) { last.detail = `${last.detail ?? ''}${text}`; return }
    steps.push({ key, kind, title: kind === 'reasoning' ? 'Reasoning' : 'Assistant response', detail: text, status: 'completed' })
  }
  const tools = new Map<string, Step>()
  for (const event of events) {
    if (event.type === 'user.message') { const message = splitPrompt(event.text); current = { key: `turn-${event.eventSeq ?? turns.length}`, prompt: message.prompt || 'User message', context: message.context, steps: [] }; turns.push(current); continue }
    if (event.type === 'assistant.chunk') { appendText(event.reasoning ? 'reasoning' : 'assistant', event.text, `message-${event.eventSeq ?? Math.random()}`); continue }
    if (event.type === 'assistant.completed') { if (event.text !== '') appendText('assistant', event.text, `assistant-${event.eventSeq ?? Math.random()}`); continue }
    if (event.type === 'tool.started') {
      const step: Step = { key: `tool-${event.callId}`, kind: 'tool', title: event.name, detail: event.arguments, status: 'running' }
      tools.set(event.callId, step); ensureTurn().steps.push(step); continue
    }
    if (event.type === 'tool.completed') { const step = tools.get(event.callId); if (step) { step.detail = [step.detail, event.result].filter(Boolean).join('\n\n'); step.status = event.failed ? 'failed' : 'completed' }; continue }
    if (event.type === 'plan.updated') { ensureTurn().steps.push({ key: `plan-${event.eventSeq ?? Math.random()}`, kind: 'plan', title: 'Plan updated', detail: event.items.map(item => `${item.status}: ${item.content}`).join('\n'), status: 'completed' }); continue }
    if (event.type === 'approval.requested') { ensureTurn().steps.push({ key: `approval-${event.approvalId}`, kind: 'approval', title: 'Approval requested', detail: event.reason ?? event.toolName, status: 'running' }); continue }
    if (event.type === 'approval.resolved') { ensureTurn().steps.push({ key: `approval-result-${event.approvalId}`, kind: 'approval', title: 'Approval resolved', detail: event.decision, status: 'completed' }); continue }
    if (event.type === 'goal.updated') { ensureTurn().steps.push({ key: `goal-${event.eventSeq ?? Math.random()}`, kind: 'goal', title: `Goal · ${event.phase}`, detail: event.objective, status: event.phase === 'blocked' ? 'failed' : 'completed' }); continue }
    if (event.type === 'error') ensureTurn().steps.push({ key: `error-${Math.random()}`, kind: 'error', title: 'Error', detail: event.message, status: 'failed' })
  }
  return turns
}

function buildRawTrajectory(events: Record<string, unknown>[]): { turns: Turn[]; calls: number; duration: number } {
  const turns: Turn[] = [], byNumber = new Map<number, Turn>()
  let current: Turn | undefined, calls = 0, firstTime: number | undefined, lastTime: number | undefined
  const getTurn = (number: number | undefined): Turn => {
    if (number !== undefined && byNumber.has(number)) return byNumber.get(number) as Turn
    const turn: Turn = { key: `raw-turn-${number ?? turns.length}`, prompt: number === undefined ? 'Session initialization' : `Turn ${number}`, steps: [] }
    turns.push(turn); if (number !== undefined) byNumber.set(number, turn); current = turn; return turn
  }
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : 'event', data = record(event.data), time = typeof event.time === 'number' ? event.time : undefined
    if (time !== undefined) { firstTime ??= time; lastTime = time }
    const turnNumber = typeof data.turn === 'number' ? data.turn : undefined
    if (type === 'turn/start') { getTurn(turnNumber); continue }
    const turn = current ?? getTurn(turnNumber)
    if (type === 'request/header') { turn.steps.push({ key: `header-${event.seq ?? Math.random()}`, kind: 'plan', title: 'System prompt', detail: 'Initial system prompt', status: 'completed' }); continue }
    if (type === 'user/message') { const message = splitPrompt(textFrom(data.content)); turn.prompt = message.prompt || 'User message'; turn.context = message.context; continue }
    if (type === 'assistant/message') { turn.steps.push({ key: `assistant-${event.seq ?? Math.random()}`, kind: 'assistant', title: 'Assistant response', detail: textFrom(record(data.message).content), status: 'completed' }); continue }
    if (type === 'tool/call') { calls++; turn.steps.push({ key: `call-${event.seq ?? Math.random()}`, kind: 'tool', title: `Tool · ${String(data.name ?? 'call')}`, detail: textOrJson(data.arguments), status: 'running' }); continue }
    if (type === 'tool/result') { turn.steps.push({ key: `result-${event.seq ?? Math.random()}`, kind: 'tool', title: 'Tool result', detail: textFrom(record(data.message).content) || textOrJson(data), status: data.error === undefined ? 'completed' : 'failed' }); continue }
    if (type === 'step/start') { turn.steps.push({ key: `step-${event.seq ?? Math.random()}`, kind: 'reasoning', title: `Model step ${String(data.step ?? '')}`.trim(), status: 'running' }); continue }
    if (type === 'step/end') {
      const stepNumber = String(data.step ?? '')
      const active = [...turn.steps].reverse().find(step => step.kind === 'reasoning' && step.status === 'running' && (stepNumber === '' || step.title.endsWith(stepNumber)))
      if (active) { active.status = 'completed'; active.detail = textOrJson(data.output ?? data.result) || undefined }
      continue
    }
    if (type === 'turn/end') {
      for (const step of turn.steps) if (step.status === 'running') step.status = 'completed'
      turn.steps.push({ key: `end-${event.seq ?? Math.random()}`, kind: 'goal', title: 'Turn completed', detail: textOrJson(data.reason), status: 'completed' }); continue
    }
    if (type === 'assistant/chunk' || type === 'session/title') continue
    if (type.includes('error')) turn.steps.push({ key: `event-${event.seq ?? Math.random()}`, kind: 'error', title: type, detail: textOrJson(data), status: 'failed' })
  }
  // Initialization records often contain only the full system prompt. They are
  // useful in the downloadable log, but add noise to the visual trajectory.
  const visibleTurns = turns.filter(turn => turn.prompt !== 'Session initialization' || turn.steps.some(step => step.kind !== 'plan'))
  return { turns: visibleTurns, calls, duration: firstTime === undefined || lastTime === undefined ? 0 : Math.max(0, lastTime - firstTime) }
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function textFrom(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : ''
  return value.map(item => { const block = record(item); return typeof block.text === 'string' ? block.text : '' }).join('')
}
function splitPrompt(value: string): { prompt: string; context?: { workspace?: string; currentFile?: string } } {
  const match = value.match(/<ide_context>([\s\S]*?)(?:<\/ide_context>|$)/i)
  const prompt = value.replace(/<ide_context>[\s\S]*?(?:<\/ide_context>|$)/i, '').replace(/\s+/g, ' ').trim()
  if (match === null) return { prompt: prompt.length > 180 ? `${prompt.slice(0, 177)}…` : prompt }
  const context = (match[1] ?? '').replace(/\s+/g, ' ')
  const workspace = context.match(/Workspace:\s*(.*?)(?=\s*---\s*Current File:|$)/i)?.[1]?.trim()
  const currentFile = context.match(/Current File:\s*(.*?)(?=\s*---\s*(?:Language|Cursor|Open Tabs):|$)/i)?.[1]?.trim()
  return { prompt: prompt.length > 180 ? `${prompt.slice(0, 177)}…` : prompt, context: workspace === undefined && currentFile === undefined ? undefined : { workspace, currentFile } }
}
function textOrJson(value: unknown): string { if (typeof value === 'string') return value; if (Array.isArray(value)) { const text = textFrom(value); if (text !== '') return text } try { return JSON.stringify(value, null, 2) } catch { return String(value ?? '') } }
function formatDuration(milliseconds: number): string { if (milliseconds < 1_000) return milliseconds === 0 ? 'Duration unavailable' : '< 1s'; const seconds = Math.round(milliseconds / 1_000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s` }

function BackIcon(): JSX.Element { return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="m14.5 5-7 7 7 7M8 12h9"/></svg> }
function DownloadIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 4v10m-4-4 4 4 4-4M5 19h14"/></svg> }
function ClockIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg> }
