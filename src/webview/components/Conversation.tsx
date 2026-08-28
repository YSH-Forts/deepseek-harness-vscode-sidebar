import { useEffect, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { HarnessEvent, WebviewToExtensionMessage } from '../../shared/protocol.ts'
import deepseekLogo from '../../../media/deepseek.svg'

type Row =
  | { key: string; kind: 'user' | 'assistant' | 'reasoning'; text: string }
  | { key: string; kind: 'toolGroup'; tools: ToolStep[] }
  | { key: string; kind: 'approval'; event: Extract<HarnessEvent, { type: 'approval.requested' }>; resolved?: string }
  | { key: string; kind: 'plan'; event: Extract<HarnessEvent, { type: 'plan.updated' }> }
  | { key: string; kind: 'subagent'; event: Extract<HarnessEvent, { type: 'subagent.started' | 'subagent.finished' }> }
  | { key: string; kind: 'goal'; event: Extract<HarnessEvent, { type: 'goal.updated' }> }
  | { key: string; kind: 'error'; text: string }

type ToolStep = { key: string; callId: string; name: string; arguments: string; result?: string; failed?: boolean; completed: boolean; changed?: boolean; reviewed?: 'kept' | 'reverted' }

export function Conversation({ events, hasEarlierEvents, running, changedFiles, gitChanges, post, onEdit }: { events: HarnessEvent[]; hasEarlierEvents: boolean; running: boolean; changedFiles: Extract<HarnessEvent, { type: 'file.changed' }>[]; gitChanges: { path: string; status: string }[]; post(message: WebviewToExtensionMessage): void; onEdit(value: string): void }): JSX.Element {
  const scroll = useRef<HTMLElement>(null), wasNearBottom = useRef(true)
  const rows = useMemo(() => buildRows(events), [events])
  const changedPaths = new Set(changedFiles.map(change => change.path))
  const remainingGitChanges = gitChanges.filter(change => !changedPaths.has(change.path))
  const changeCount = changedPaths.size + remainingGitChanges.length
  useEffect(() => {
    if (wasNearBottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' })
  }, [rows])
  return <section ref={scroll} className="conversation" data-conversation-scroll onScroll={event => {
    const element = event.currentTarget
    wasNearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96
  }}>
    {rows.length === 0 && <div className="empty-state"><div className="empty-logo">◒</div><h2>What can I help you build?</h2><p>Ask about your code, attach context, or start with a task.</p></div>}
    <div className="conversation-column">
      {hasEarlierEvents && <button className="load-earlier" onClick={() => post({ type: 'loadEarlierHistory' })}>Load earlier messages</button>}
      {rows.map(row => <RowView key={row.key} row={row} post={post} onEdit={onEdit}/>)}
      {running && <div className="deep-diving"><i/><span>Deep diving…</span></div>}
      {changeCount > 0 && <details className="change-summary">
        <summary>{changeCount} file{changeCount === 1 ? '' : 's'} changed</summary>
        <div className="change-summary-items">
          {changedFiles.map(change => <button key={change.callId} onClick={() => post({ type: 'openDiff', callId: change.callId })} title={change.path}>Open {basename(change.path)} diff</button>)}
          {remainingGitChanges.map(change => <button key={change.path} onClick={() => post({ type: 'openGitFileDiff', path: change.path })} title={change.path}><b>{change.status}</b> {basename(change.path)}</button>)}
          {gitChanges.length > 0 && <button className="git-diff-link" onClick={() => post({ type: 'openGitDiff' })}>View Git diff</button>}
        </div>
      </details>}
    </div>
  </section>
}

function RowView({ row, post, onEdit }: { row: Row; post(message: WebviewToExtensionMessage): void; onEdit(value: string): void }): JSX.Element {
  if (row.kind === 'user') return <div className="user-message-wrap"><article className="user-message"><Markdown text={row.text} post={post}/></article><div className="message-actions"><CopyAction text={row.text}/><button className="copy-action" onClick={() => onEdit(row.text)}>Edit</button><button className="copy-action" onClick={() => post({ type: 'retryMessage', text: row.text })}>Retry</button></div></div>
  if (row.kind === 'assistant') return <article className="assistant-message"><Markdown text={row.text} post={post}/></article>
  if (row.kind === 'reasoning') return <details className="reasoning-row"><summary>Thought process</summary><div><Markdown text={row.text}/></div></details>
  if (row.kind === 'toolGroup') return <ToolGroup tools={row.tools} post={post}/>
  if (row.kind === 'approval') return <article className={`approval-card ${row.resolved !== undefined ? 'resolved' : ''}`}><div className="approval-title">Approval required</div><p>{row.event.reason ?? `DeepSeek wants to run ${row.event.toolName}`}</p>{row.resolved === undefined
    ? <div className="approval-actions"><button onClick={() => post({ type: 'approval', sessionId: row.event.sessionId, approvalId: row.event.approvalId, decision: 'rejected' })}>Reject</button><button className="primary" onClick={() => post({ type: 'approval', sessionId: row.event.sessionId, approvalId: row.event.approvalId, decision: 'allowed-once' })}>Allow once</button></div>
    : <small>Resolved: {row.resolved}</small>}</article>
  if (row.kind === 'plan') return <article className="plan-card"><strong>Plan</strong>{row.event.items.map((item, index) => <div key={index}><span>{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'}</span><p>{item.content}</p></div>)}</article>
  if (row.kind === 'subagent') return <article className="subagent-card"><strong>Subagent {row.event.type === 'subagent.started' ? 'started' : row.event.status === 'ok' ? 'completed' : 'failed'}</strong><small>{row.event.childSessionId}</small>{row.event.type === 'subagent.started' && <button className="diff-action danger" onClick={() => post({ type: 'cancelSubagent', sessionId: row.event.childSessionId })}>Stop subagent</button>}{row.event.type === 'subagent.finished' && row.event.message && <Markdown text={row.event.message}/>}</article>
  if (row.kind === 'goal') return <article className="goal-card"><strong>Goal · {row.event.phase}</strong><p>{row.event.objective}</p><small>{row.event.roundsStarted ?? 0}{row.event.maxGoalRounds ? ` / ${row.event.maxGoalRounds}` : ''} rounds{row.event.blockedReason ? ` · ${row.event.blockedReason}` : ''}</small>{row.event.phase !== 'complete' && <div className="goal-actions">{row.event.phase === 'active' && <button onClick={() => post({ type: 'sendMessage', text: '/goal pause' })}>Pause</button>}{(row.event.phase === 'paused' || row.event.phase === 'blocked') && <button onClick={() => post({ type: 'sendMessage', text: '/goal resume' })}>Resume</button>}<button onClick={() => post({ type: 'sendMessage', text: '/goal complete' })}>Complete</button><button onClick={() => post({ type: 'sendMessage', text: '/goal clear' })}>Clear</button></div>}</article>
  return <article className="inline-error">{row.text}</article>
}

function Markdown({ text, post }: { text: string; post?: (message: WebviewToExtensionMessage) => void }): JSX.Element {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: props => <a {...props} target="_blank" rel="noreferrer"/>,
    code: props => { const value = String(props.children ?? '').trim(); const fileLike = post !== undefined && /(?:[\\/]|^)[\w.-]+\.(?:ts|tsx|js|jsx|py|json|md|css|html|yml|yaml)$/.test(value); return <>{<code className={props.className}>{props.children}</code>}{fileLike && <button className="file-link" onClick={() => post?.({ type: 'openFile', path: value })}>Open</button>}</> },
  }}>{text}</ReactMarkdown>
}

function buildRows(events: HarnessEvent[]): Row[] {
  const rows: Row[] = [], tools = new Map<string, ToolStep>(), approvals = new Map<string, number>()
  let assistant = '', reasoning = '', serial = 0
  const flush = (): void => {
    if (reasoning !== '') rows.push({ key: `reasoning-${serial++}`, kind: 'reasoning', text: reasoning })
    if (assistant !== '') rows.push({ key: `assistant-${serial++}`, kind: 'assistant', text: assistant })
    assistant = ''; reasoning = ''
  }
  for (const event of events) {
    if (event.type === 'assistant.chunk') {
      if (event.reasoning) { if (assistant !== '') flush(); reasoning += event.text }
      else { if (reasoning !== '') flush(); assistant += event.text }
      continue
    }
    if (event.type === 'assistant.completed') {
      if (assistant === '' && event.text !== '') assistant = event.text
      flush(); continue
    }
    if (event.type === 'assistant.started' || event.type === 'status.changed' || event.type === 'session.started' || event.type === 'session.title') continue
    flush()
    if (event.type === 'user.message') rows.push({ key: `user-${event.eventSeq ?? serial++}`, kind: 'user', text: event.text })
    else if (event.type === 'tool.started') {
      const last = rows.at(-1)
      const group = last?.kind === 'toolGroup' ? last : { key: `tools-${serial++}`, kind: 'toolGroup' as const, tools: [] }
      if (last?.kind !== 'toolGroup') rows.push(group)
      const tool: ToolStep = { key: `tool-${event.callId}`, callId: event.callId, name: event.name, arguments: event.arguments, completed: false }
      group.tools.push(tool); tools.set(event.callId, tool)
    }
    else if (event.type === 'tool.completed') {
      const tool = tools.get(event.callId)
      if (tool !== undefined) { tool.completed = true; tool.result = event.result; tool.failed = event.failed }
      else rows.push({ key: `tools-${serial++}`, kind: 'toolGroup', tools: [{ key: `tool-result-${event.callId}`, callId: event.callId, name: 'Tool', arguments: '', completed: true, result: event.result, failed: event.failed }] })
    } else if (event.type === 'file.changed') {
      const tool = tools.get(event.callId)
      if (tool !== undefined) tool.changed = true
    } else if (event.type === 'file.reviewed') {
      const tool = tools.get(event.callId)
      if (tool !== undefined) tool.reviewed = event.decision
    } else if (event.type === 'approval.requested') { approvals.set(event.approvalId, rows.length); rows.push({ key: `approval-${event.approvalId}`, kind: 'approval', event }) }
    else if (event.type === 'approval.resolved') {
      const index = approvals.get(event.approvalId), current = index === undefined ? undefined : rows[index]
      if (index !== undefined && current?.kind === 'approval') rows[index] = { ...current, resolved: event.decision ?? 'completed' }
    } else if (event.type === 'plan.updated') rows.push({ key: `plan-${event.eventSeq ?? serial++}`, kind: 'plan', event })
    else if (event.type === 'subagent.started' || event.type === 'subagent.finished') rows.push({ key: `subagent-${event.childSessionId}-${serial++}`, kind: 'subagent', event })
    else if (event.type === 'goal.updated') rows.push({ key: `goal-${event.eventSeq ?? serial++}`, kind: 'goal', event })
    else if (event.type === 'error') rows.push({ key: `error-${serial++}`, kind: 'error', text: event.message })
  }
  flush(); return rows
}

function pretty(value: string): string { try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value } }
function basename(path: string): string { return path.split(/[\\/]/).at(-1) ?? path }
function friendlyTool(name: string): string { return name.replaceAll(/[_-]+/g, ' ').replace(/^./, value => value.toUpperCase()) }

function ToolGroup({ tools, post }: { tools: ToolStep[]; post(message: WebviewToExtensionMessage): void }): JSX.Element {
  const running = tools.some(tool => !tool.completed), failed = tools.some(tool => tool.failed)
  return <details className={`tool-group ${running ? 'running' : ''} ${failed ? 'failed' : ''}`} open={running}>
    <summary><HarnessMark/><strong>{toolSummary(tools)}</strong><span className="tool-group-chevron" aria-hidden>⌄</span></summary>
    <div className="tool-group-items">{tools.map(tool => <ToolDetails key={tool.key} tool={tool} post={post}/>)}</div>
  </details>
}

function ToolDetails({ tool, post }: { tool: ToolStep; post(message: WebviewToExtensionMessage): void }): JSX.Element {
  return <details className={`tool-row ${tool.failed ? 'failed' : ''} ${tool.completed ? 'completed' : ''}`} open={!tool.completed}>
    <summary title="View tool details"><span className={`tool-state ${tool.completed ? tool.failed ? 'failed' : 'done' : 'running'}`}>{tool.completed ? tool.failed ? '×' : <HarnessMark/> : ''}</span><strong>{toolLabel(tool)}</strong>{(!tool.completed || tool.failed) && <small>{tool.failed ? 'Failed' : 'Running'}</small>}</summary>
    {tool.arguments !== '' && <pre>{pretty(tool.arguments)}</pre>}{tool.result !== undefined && tool.result !== '' && <pre className="tool-result">{tool.result}</pre>}{tool.changed && <div className="diff-actions"><button className="diff-action" onClick={() => post({ type: 'openDiff', callId: tool.callId })}>Open diff</button>{tool.reviewed === undefined ? <><button className="diff-action" onClick={() => post({ type: 'keepDiff', callId: tool.callId })}>Keep</button><button className="diff-action danger" onClick={() => post({ type: 'revertDiff', callId: tool.callId })}>Revert</button></> : <small>Change {tool.reviewed}</small>}</div>}
  </details>
}

function toolSummary(tools: ToolStep[]): string {
  const labels = Array.from(new Set(tools.map(tool => /(?:write|edit|patch|apply)/i.test(tool.name) ? 'Edited a file' : /(?:bash|shell|terminal|command|exec)/i.test(tool.name) ? 'Ran commands' : /(?:read|cat)/i.test(tool.name) ? 'Read files' : /(?:web|browser|search|fetch)/i.test(tool.name) ? 'Browsed the web' : 'Used tools')))
  return labels.join(', ')
}

function toolLabel(tool: ToolStep): string {
  if (/(?:bash|shell|terminal|command|exec)/i.test(tool.name) && tool.arguments.trim() !== '') return `Ran ${tool.arguments.trim().replaceAll(/\s+/g, ' ').slice(0, 100)}`
  return friendlyTool(tool.name)
}

function HarnessMark(): JSX.Element { return <img className="harness-mark" src={deepseekLogo} alt=""/> }

function CopyAction({ text }: { text: string }): JSX.Element {
  return <button className="copy-action" title="Copy message" aria-label="Copy message" onClick={() => { void navigator.clipboard?.writeText(text) }}>Copy</button>
}
