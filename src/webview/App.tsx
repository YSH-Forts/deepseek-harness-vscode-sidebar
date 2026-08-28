import { useEffect, useRef, useState } from 'react'
import deepseekLogo from '../../media/deepseek.svg'
import type { ExtensionToWebviewMessage, WebviewState, WebviewToExtensionMessage } from '../shared/protocol.ts'
import { Conversation } from './components/Conversation.tsx'
import { SettingsPanel } from './components/SettingsPanel.tsx'
import { TrajectoryPanel } from './components/TrajectoryPanel.tsx'
import { PluginMarketPanel } from './components/PluginMarketPanel.tsx'

declare function acquireVsCodeApi(): { postMessage(message: WebviewToExtensionMessage): void }
const vscode = acquireVsCodeApi()
const MODE_OPTIONS = [
  { value: 'standard', label: 'Standard', description: 'Full agent toolset' },
  { value: 'code', label: 'Code', description: 'Code-focused agent runtime' },
  { value: 'minimal', label: 'Minimal', description: 'Minimal shell and editor setup' },
  { value: 'creator', label: 'Creator', description: 'Cordis plugin authoring setup' },
]
const EMPTY: WebviewState = {
  runtime: { state: 'stopped' }, sessions: [], commands: [], events: [], historyHasMore: false, trajectoryEvents: [], plugins: [], attachedFiles: [],
  settings: { provider: 'deepseek-official', model: 'deepseek-v4-flash', endpoint: '', permissionMode: 'workspace-write', credential: { configured: false, writable: true }, loading: true }, gitChanges: [],
}

export function App(): JSX.Element {
  const [state, setState] = useState(EMPTY)
  const [text, setText] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [trajectoryOpen, setTrajectoryOpen] = useState(false), [pluginMarketOpen, setPluginMarketOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false), [goalEditorOpen, setGoalEditorOpen] = useState(false), [goalText, setGoalText] = useState('')
  const [queuedMessage, setQueuedMessage] = useState<string | undefined>()
  const [queueMenuOpen, setQueueMenuOpen] = useState(false), [queueingEnabled, setQueueingEnabled] = useState(true)
  const [composerModel, setComposerModel] = useState(EMPTY.settings.model)
  const [agentMode, setAgentMode] = useState('standard')
  const composer = useRef<HTMLTextAreaElement>(null), addMenu = useRef<HTMLDivElement>(null), queueMenu = useRef<HTMLDivElement>(null), queueDispatching = useRef(false)

  useEffect(() => {
    const receive = (message: MessageEvent<ExtensionToWebviewMessage>): void => {
      const data = message.data
      if (data.type === 'state') setState(data.state)
      else if (data.type === 'event') setState(current => ({ ...current, events: [...current.events, data.event] }))
      else setState(current => ({ ...current, runtime: data.runtime }))
    }
    window.addEventListener('message', receive)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', receive)
  }, [])

  useEffect(() => { setComposerModel(state.settings.model) }, [state.settings.model])

  useEffect(() => {
    if (!addMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!addMenu.current?.contains(event.target as Node)) { setAddMenuOpen(false); setGoalEditorOpen(false) }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [addMenuOpen])

  useEffect(() => {
    if (!queueMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!queueMenu.current?.contains(event.target as Node)) setQueueMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [queueMenuOpen])

  const running = [...state.events].reverse().find(event => event.type === 'status.changed')?.type === 'status.changed'
    && [...state.events].reverse().find(event => event.type === 'status.changed')?.status === 'running'
  const canSend = state.runtime.state !== 'error' && (state.settings.loading || state.settings.credential.configured)
  const changedFiles = Array.from(new Map(state.events.filter((event): event is Extract<typeof event, { type: 'file.changed' }> => event.type === 'file.changed').map(event => [event.path, event])).values())
  const latestUsage = [...state.events].reverse().find((event): event is Extract<typeof event, { type: 'context.usage' }> => event.type === 'context.usage')
  const contextTokens = latestUsage?.inputTokens ?? 0, contextLimit = 1_000_000, contextPercent = Math.min(100, contextTokens / contextLimit * 100)
  const selectedMode = MODE_OPTIONS.find(mode => mode.value === agentMode) ?? { value: 'standard', label: 'Standard', description: 'Full agent toolset' }
  useEffect(() => {
    if (running) { queueDispatching.current = false; return }
    if (queuedMessage === undefined || !canSend || queueDispatching.current) return
    queueDispatching.current = true
    setQueuedMessage(undefined)
    vscode.postMessage({ type: 'sendMessage', text: queuedMessage })
  }, [running, queuedMessage, canSend])
  const submit = (): void => {
    const value = text.trim()
    if (value === '' || !canSend) return
    if (running && queueingEnabled) {
      setQueuedMessage(value)
      setText('')
      return
    }
    vscode.postMessage({ type: 'sendMessage', text: value, mode: agentMode })
    setText('')
    composer.current?.focus()
  }
  if (pluginMarketOpen) return <PluginMarketPanel plugins={state.plugins} onBack={() => setPluginMarketOpen(false)}/>
  if (settingsOpen) {
    return <SettingsPanel state={state.settings} plugins={state.plugins} onBack={() => setSettingsOpen(false)} post={message => vscode.postMessage(message)}/>
  }
  if (trajectoryOpen) return <TrajectoryPanel events={state.events} rawEvents={state.trajectoryEvents} title={state.sessions.find(session => session.id === state.activeSessionId)?.title} onBack={() => setTrajectoryOpen(false)} onExport={() => vscode.postMessage({ type: 'exportSession' })}/>

  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><img className="fish-mark" src={deepseekLogo} alt="DeepSeek"/><span>DeepSeek</span><i className={`status-dot ${state.runtime.state}`} title={state.runtime.message ?? state.runtime.state}/></div>
      <div className="header-actions">
        <button className="icon-button" data-tooltip="New chat" aria-label="New chat" onClick={() => { setHistoryOpen(false); vscode.postMessage({ type: 'newSession' }) }}><ToolbarIcon kind="new"/></button>
        <button className="icon-button" data-tooltip="Chat history" aria-label="Chat history" aria-expanded={historyOpen} onClick={() => setHistoryOpen(open => !open)}><ToolbarIcon kind="history"/></button>
        <button className="icon-button" data-tooltip="View trajectory" aria-label="View trajectory" disabled={!state.activeSessionId} onClick={() => { setHistoryOpen(false); setTrajectoryOpen(true); vscode.postMessage({ type: 'loadTrajectory' }) }}><ToolbarIcon kind="trajectory"/></button>
        <button className="icon-button" data-tooltip="Plugin marketplace" aria-label="Plugin marketplace" onClick={() => { setHistoryOpen(false); setSettingsOpen(false); setPluginMarketOpen(true); vscode.postMessage({ type: 'loadPlugins' }) }}><ToolbarIcon kind="plugins"/></button>
        <button className="icon-button" data-tooltip="Settings" aria-label="Settings" onClick={() => { setPluginMarketOpen(false); setSettingsOpen(true); vscode.postMessage({ type: 'refreshSettings' }); vscode.postMessage({ type: 'loadPlugins' }) }}><ToolbarIcon kind="settings"/></button>
      </div>
    </header>

    {historyOpen && <section className="history-panel" aria-label="Chat history"><div className="history-panel-header"><strong>Chat history</strong></div><div className="session-list">{state.sessions.length === 0
      ? <small>No chats yet.</small>
      : state.sessions.map(session => <button key={session.id} className={`session-item ${session.id === state.activeSessionId ? 'active' : ''}`} onClick={() => { setHistoryOpen(false); vscode.postMessage({ type: 'selectSession', sessionId: session.id }) }}>{session.parentSessionId && <span className="fork-mark" title="Forked session" aria-label="Forked session">⑂</span>}{session.title}</button>)}</div></section>}

    {state.runtime.state === 'error' && <div className="banner error-banner"><span>{state.runtime.message ?? 'Runtime unavailable'}</span><button onClick={() => vscode.postMessage({ type: 'restartRuntime' })}>Restart</button></div>}
    {!state.settings.loading && !state.settings.credential.configured && <button className="banner credential-banner" onClick={() => setSettingsOpen(true)}><span>Configure DeepSeek API Key</span><b>Open settings →</b></button>}

    <Conversation events={state.events} hasEarlierEvents={state.historyHasMore} running={running} changedFiles={changedFiles} gitChanges={state.gitChanges} post={message => vscode.postMessage(message)} onEdit={value => { setText(value); composer.current?.focus() }}/>

    <div className="composer-wrap">
      {state.attachedFiles.length > 0 && <div className="attachment-rail">{state.attachedFiles.map(path => <button key={path} title={path} onClick={() => vscode.postMessage({ type: 'removeAttachment', path })}>📎 {basename(path)} <span>×</span></button>)}</div>}
      {queuedMessage !== undefined && <div className="queued-message"><span className="queue-mark"><QueueIcon/></span><p title={queuedMessage}>{queuedMessage}</p><button className="queue-steer" data-tooltip="Send as steering instruction" onClick={() => { vscode.postMessage({ type: 'steerMessage', text: queuedMessage }); setQueuedMessage(undefined) }}><SteerIcon/>Steer</button><button className="queue-action" data-tooltip="Remove queued message" aria-label="Remove queued message" onClick={() => setQueuedMessage(undefined)}><TrashIcon/></button><div className="queue-overflow" ref={queueMenu}><button className="queue-action" data-tooltip="More queue options" aria-label="More queue options" aria-expanded={queueMenuOpen} onClick={() => setQueueMenuOpen(open => !open)}><MoreIcon/></button>{queueMenuOpen && <div className="queue-menu" role="menu"><button role="menuitem" onClick={() => { setText(queuedMessage); setQueuedMessage(undefined); setQueueMenuOpen(false); composer.current?.focus() }}><EditIcon/>Edit message</button><button role="menuitem" onClick={() => { setQueueingEnabled(false); setQueueMenuOpen(false) }}><QueueIcon/>Turn off queueing</button></div>}</div></div>}
      <div className="composer">
        <textarea ref={composer} value={text} placeholder="Ask DeepSeek…" rows={2} onChange={event => setText(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!event.repeat) submit() }
        }}/>
        {!state.settings.loading && !state.settings.credential.configured && <button className="composer-key-warning" onClick={() => setSettingsOpen(true)}>Configure an API key in Settings to send messages.</button>}
        <div className="composer-actions">
          <div className="add-menu-wrap" ref={addMenu}>
            <button className="add-button" data-tooltip="Add context or mode" aria-label="Add" aria-expanded={addMenuOpen} onClick={() => { setAddMenuOpen(open => !open); setGoalEditorOpen(false) }}><AddIcon/></button>
            {addMenuOpen && <div className="add-menu" role="menu">
              {!goalEditorOpen ? <>
                <button role="menuitem" onClick={() => { vscode.postMessage({ type: 'attachFiles' }); setAddMenuOpen(false) }}><PaperclipIcon/><span><strong>Files and folders</strong><small>Add files as context</small></span></button>
                <button role="menuitem" onClick={() => { vscode.postMessage({ type: 'sendMessage', text: '/plan' }); setAddMenuOpen(false) }}><PlanIcon/><span><strong>Plan mode</strong><small>Turn plan mode on</small></span></button>
                <button role="menuitem" onClick={() => setGoalEditorOpen(true)}><GoalIcon/><span><strong>Goal</strong><small>Set a goal to keep pursuing</small></span></button>
              </> : <form className="goal-editor" onSubmit={event => { event.preventDefault(); const objective = goalText.trim(); if (objective === '') return; vscode.postMessage({ type: 'sendMessage', text: `/goal ${objective}` }); setGoalText(''); setGoalEditorOpen(false); setAddMenuOpen(false) }}><strong>Set goal</strong><input value={goalText} onChange={event => setGoalText(event.target.value)} placeholder="What should DeepSeek keep pursuing?" autoFocus/><div><button type="button" onClick={() => setGoalEditorOpen(false)}>Back</button><button type="submit">Set goal</button></div></form>}
            </div>}
          </div>
          <select className="composer-mode-select" value={agentMode} aria-label="Select agent mode" data-tooltip={`${selectedMode.label} · ${selectedMode.description}`} onChange={event => setAgentMode(event.target.value)}>{MODE_OPTIONS.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select>
          <span/>
          <select className="composer-model-select" value={composerModel} aria-label="Select model" data-tooltip="Select model" onChange={event => { const model = event.target.value; setComposerModel(model); vscode.postMessage({ type: 'saveSettings', provider: state.settings.provider, model, endpoint: state.settings.endpoint, permissionMode: state.settings.permissionMode }) }}>
            <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
            <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
            <option value="deepseek-v4-flash-vision-exp">DeepSeek V4 Flash Vision Exp</option>
            {!['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'].includes(composerModel) && <option value={composerModel}>{composerModel}</option>}
          </select>
          <button className="context-meter" data-tooltip={`${contextPercent.toFixed(1)}% · ${formatTokenCount(contextTokens)} / 1.0M context used`} aria-label="Context usage" type="button"><ContextRing percent={contextPercent}/></button>
          <button className={`send-button ${running ? 'stop-send-button' : ''}`} aria-label={running ? 'Stop current response' : 'Send message'} title={running ? 'Stop current response' : canSend ? 'Send message' : 'Configure a DeepSeek API key in Settings first'} disabled={!running && (text.trim() === '' || !canSend)} onClick={() => { if (running) vscode.postMessage({ type: 'cancel' }); else submit() }}>{running ? <StopIcon/> : <SendIcon/>}</button>
        </div>
      </div>
    </div>
  </main>
}

function basename(path: string): string { return path.split(/[\\/]/).at(-1) ?? path }
function formatTokenCount(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K` : String(value) }

function ToolbarIcon({ kind }: { kind: 'new' | 'history' | 'trajectory' | 'plugins' | 'settings' }): JSX.Element {
  if (kind === 'new') return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14"/></svg>
  if (kind === 'history') return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M4 12a8 8 0 1 0 2.35-5.66L4 8.7M4 4v4.7h4.7M12 8v4l2.8 1.8"/></svg>
  if (kind === 'trajectory') return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M5 5v14M5 7h5l2 4h7M10 19h4l2-4h3"/><circle cx="10" cy="7" r="1.5"/><circle cx="12" cy="11" r="1.5"/><circle cx="14" cy="19" r="1.5"/></svg>
  if (kind === 'plugins') return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M8.5 4v4M15.5 4v4M7 8h10a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2v3H9v-3H7a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z"/><path d="M9 12h.01M15 12h.01"/></svg>
  return <svg className="toolbar-icon settings-icon" viewBox="0 0 24 24" aria-hidden><path d="M9.75 3.55h4.5l.6 2.1c.46.2.89.45 1.28.76l2.1-.58 2.25 3.9-1.55 1.53c.05.47.05.95 0 1.42l1.55 1.53-2.25 3.9-2.1-.58c-.39.31-.82.56-1.28.76l-.6 2.1h-4.5l-.6-2.1c-.46-.2-.89-.45-1.28-.76l-2.1.58-2.25-3.9 1.55-1.53a6 6 0 0 1 0-1.42L3.77 9.73l2.25-3.9 2.1.58c.39-.31.82-.56 1.28-.76l.35-2.1Z"/><circle cx="12" cy="12" r="3"/></svg>
}

function ContextRing({ percent }: { percent: number }): JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden><circle className="context-ring-track" cx="12" cy="12" r="9"/><circle className="context-ring-value" cx="12" cy="12" r="9" pathLength="100" style={{ strokeDasharray: '100', strokeDashoffset: String(100 - percent) }}/></svg>
}

function AddIcon(): JSX.Element { return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14"/></svg> }
function PaperclipIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><path d="m8 12 6.4-6.4a3 3 0 1 1 4.2 4.2l-8.5 8.5a5 5 0 1 1-7.1-7.1l8-8"/></svg> }
function PlanIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><path d="M9 18h6M10 22h4M8.5 14.5A6.5 6.5 0 1 1 15.5 14.5c-1.1.8-1.5 1.4-1.5 2.5h-4c0-1.1-.4-1.7-1.5-2.5Z"/></svg> }
function GoalIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="m15 9 5-5"/></svg> }
function SendIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 19V5m0 0L6.5 10.5M12 5l5.5 5.5"/></svg> }
function StopIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><rect x="7" y="7" width="10" height="10" rx="1"/></svg> }

function SessionMetaIcon({ kind }: { kind: 'preset' | 'agents' | 'download' }): JSX.Element {
  if (kind === 'preset') return <svg className="session-meta-icon" viewBox="0 0 20 20" aria-hidden><circle cx="10" cy="5" r="2.3"/><path d="M5.2 16v-1.2a4.8 4.8 0 0 1 9.6 0V16M3.5 8.2 5 9.7l-1.5 1.5M16.5 8.2 15 9.7l1.5 1.5"/></svg>
  if (kind === 'agents') return <svg className="session-meta-icon" viewBox="0 0 20 20" aria-hidden><circle cx="10" cy="5.5" r="2.2"/><path d="M5.5 16v-1.1a4.5 4.5 0 0 1 9 0V16M3.2 7.2a2 2 0 0 0 0 3.7M16.8 7.2a2 2 0 0 1 0 3.7"/></svg>
  return <svg className="session-meta-icon" viewBox="0 0 20 20" aria-hidden><path d="M10 3v9M6.7 9.5 10 12.8l3.3-3.3M4 15.5v1h12v-1"/></svg>
}

function QueueIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><path d="M5 6h8M5 12h14M5 18h10M16 5v6m-3-3h6"/></svg> }
function SteerIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><path d="M4 6v5h10M4 6l3 3M4 6l3-3M14 11l3 3-3 3M17 14H7"/></svg> }
function TrashIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2m-8 0 1 12h8l1-12"/></svg> }
function MoreIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg> }
function EditIcon(): JSX.Element { return <svg className="queue-icon" viewBox="0 0 24 24" aria-hidden><path d="m5 16.5-.8 3.3 3.3-.8L18 8.5 15.5 6 5 16.5Zm9.5-10.5 2.5 2.5"/></svg> }
