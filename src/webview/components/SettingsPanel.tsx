import { useEffect, useState } from 'react'
import type { PluginInfo, SettingsState, WebviewToExtensionMessage } from '../../shared/protocol.ts'

const MODEL_OPTIONS = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Fast default model' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Higher-capability model' },
  { value: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision Exp', description: 'Experimental vision model' },
]

export function SettingsPanel({ state, plugins, onBack, post }: { state: SettingsState; plugins: PluginInfo[]; onBack(): void; post(message: WebviewToExtensionMessage): void }): JSX.Element {
  const [model, setModel] = useState(state.model), [endpoint, setEndpoint] = useState(state.endpoint), [permissionMode, setPermissionMode] = useState(state.permissionMode)
  const [apiKey, setApiKey] = useState(''), [saving, setSaving] = useState(false)
  useEffect(() => { setModel(state.model); setEndpoint(state.endpoint); setPermissionMode(state.permissionMode); if (!state.loading) setSaving(false) }, [state])
  const save = (): void => {
    setSaving(true)
    post({ type: 'saveSettings', provider: 'deepseek-official', model, endpoint, permissionMode, ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }) })
    setApiKey('')
  }
  const selectedModel = MODEL_OPTIONS.some(option => option.value === model) ? model : '__custom__'
  return <main className="settings-page">
    <header className="settings-header"><button className="icon-button" data-tooltip="Back" aria-label="Back" onClick={onBack}><svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="m14.5 5-7 7 7 7M8 12h9"/></svg></button><strong>Settings</strong><span/></header>
    <section className="settings-content">
      <div className="settings-heading"><h2>Models</h2><p>Configure the provider used by new and resumed sessions.</p></div>
      <div className="settings-card">
        <div className="provider-title"><div className="provider-logo">D</div><div><strong>DeepSeek</strong><small>deepseek-official</small></div><span className={state.credential.configured ? 'configured' : 'missing'}>{state.loading ? 'Checking…' : state.credential.configured ? 'Configured' : 'API key required'}</span></div>
        <label>Provider<input value="DeepSeek Official" readOnly aria-readonly="true"/></label>
        <label>Model<select value={selectedModel} onChange={event => { if (event.target.value !== '__custom__') setModel(event.target.value) }}>{MODEL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="__custom__">Custom model ID…</option></select></label>
        {selectedModel === '__custom__' && <label>Custom model ID<input value={model} onChange={event => setModel(event.target.value)} placeholder="your-model-id" spellCheck={false}/></label>}
        {selectedModel !== '__custom__' && <p className="settings-note">{MODEL_OPTIONS.find(option => option.value === selectedModel)?.description}</p>}
        <label>API Endpoint<input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://api.deepseek.com" spellCheck={false}/></label>
        <label>Permission<select value={permissionMode} onChange={event => setPermissionMode(event.target.value as typeof permissionMode)}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option></select></label>
        <label>API Key<input type="password" value={apiKey} disabled={!state.credential.writable} placeholder={state.credential.configured ? '••••••••••••  (leave blank to keep)' : 'sk-…'} autoComplete="off" onChange={event => setApiKey(event.target.value)}/></label>
        {!state.credential.writable && <p className="settings-note">The key comes from the Extension Host environment and is read-only.</p>}
        <div className="settings-footer">{state.credential.configured && state.credential.writable
          ? <button className="danger-link" disabled={saving} onClick={() => { setSaving(true); post({ type: 'removeApiKey' }) }}>Remove key</button>
          : <span/>}<button className="primary-button" disabled={saving || model.trim() === ''} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button></div>
      </div>
      <p className="security-note">The key is stored by DeepSeek Harness in <code>~/.dsh/.credentials.yaml</code> with owner-only permissions. It is never added to chat history.</p>
      <div className="plugins-heading"><h2>Cordis plugins</h2><p>DeepSeek Harness capabilities are supplied by active Cordis plugins.</p></div>
      <div className="plugins-card">{plugins.length === 0 ? <p className="settings-note">Loading installed plugins…</p> : <><div className="plugin-summary"><strong>{plugins.filter(plugin => plugin.phase === 'active').length} active</strong><span>{plugins.length} installed</span></div><div className="plugin-list">{plugins.map(plugin => <div className="plugin-row" key={plugin.id}><span className={`plugin-state ${plugin.phase}`}/><div><strong>{pluginLabel(plugin.id)}</strong><small>{plugin.id}</small></div><em>{plugin.phase}</em></div>)}</div></>}</div>
    </section>
  </main>
}

function pluginLabel(id: string): string { return id.replace(/^@deepseek-ai\//, '').replace(/^dsh-/, '').replaceAll('-', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }
