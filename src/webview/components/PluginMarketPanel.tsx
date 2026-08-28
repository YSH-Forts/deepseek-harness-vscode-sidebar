import { useMemo, useState } from 'react'
import type { PluginInfo } from '../../shared/protocol.ts'

type Category = 'All' | 'Agent' | 'Tools' | 'Workspace' | 'Models' | 'Sessions' | 'Integrations'

export function PluginMarketPanel({ plugins, onBack }: { plugins: PluginInfo[]; onBack(): void }): JSX.Element {
  const [query, setQuery] = useState(''), [category, setCategory] = useState<Category>('All'), [expanded, setExpanded] = useState<string | undefined>()
  const categories = useMemo(() => ['All', ...Array.from(new Set(plugins.map(plugin => categoryFor(plugin.id)))).sort()] as Category[], [plugins])
  const matching = plugins.filter(plugin => {
    const needle = query.trim().toLowerCase()
    return (category === 'All' || categoryFor(plugin.id) === category) && (needle === '' || plugin.id.toLowerCase().includes(needle) || labelFor(plugin.id).toLowerCase().includes(needle) || descriptionFor(plugin.id).toLowerCase().includes(needle))
  })
  const active = plugins.filter(plugin => plugin.phase === 'active').length
  return <main className="plugin-market-page">
    <header className="settings-header"><button className="icon-button" data-tooltip="Back to settings" aria-label="Back to settings" onClick={onBack}><BackIcon/></button><strong>Plugin marketplace</strong><span/></header>
    <section className="plugin-market-content">
      <div className="plugin-market-hero"><h2>Harness plugins</h2><p>Browse the Cordis capabilities bundled with this Mac runtime.</p><div><strong>{active} active</strong><span>{plugins.length} bundled plugins</span></div></div>
      <p className="plugin-market-note">This local catalog matches the Harness plugin inventory. External registry installation is intentionally unavailable in the packaged runtime until it has a signed download and dependency-loading path.</p>
      <label className="plugin-market-search"><SearchIcon/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search plugins" aria-label="Search plugins"/></label>
      <div className="plugin-market-filters">{categories.map(item => <button type="button" key={item} className={item === category ? 'selected' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div>
      <div className="plugin-market-count">{matching.length} plugins</div>
      <div className="plugin-market-grid">{matching.map(plugin => {
        const isOpen = expanded === plugin.id, activePlugin = plugin.phase === 'active'
        return <article className="plugin-market-card" data-open={isOpen} key={plugin.id}><button type="button" className="plugin-market-card-head" onClick={() => setExpanded(isOpen ? undefined : plugin.id)} aria-expanded={isOpen}><span className={`plugin-state ${plugin.phase}`}/><span><strong>{labelFor(plugin.id)}</strong><small>{descriptionFor(plugin.id)}</small></span><em>{activePlugin ? 'Active' : 'Bundled'}</em><ChevronIcon/></button>{isOpen && <div className="plugin-market-details"><dl><div><dt>Package</dt><dd>{plugin.id}</dd></div><div><dt>Category</dt><dd>{categoryFor(plugin.id)}</dd></div><div><dt>Runtime status</dt><dd>{plugin.phase}</dd></div></dl>{activePlugin ? <p>This capability is ready in the current runtime.</p> : <p>This capability is bundled and will activate when a runtime feature requires it.</p>}</div>}</article>
      })}</div>
      {matching.length === 0 && <div className="plugin-market-empty">No plugins match this search.</div>}
    </section>
  </main>
}

function labelFor(id: string): string { return id.replace(/^@deepseek-ai\//, '').replace(/^dsh-/, '').replaceAll('-', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }
function categoryFor(id: string): Exclude<Category, 'All'> {
  if (/(agent|goal|plan|workflow|subagent|skill|todo|hook|persona)/.test(id)) return 'Agent'
  if (/(tool|bash|terminal|shell|pwsh|web|lsp|mcp|browser|fetch)/.test(id)) return 'Tools'
  if (/(fs|workspace|attachment|directory|sandbox|storage|spill|context)/.test(id)) return 'Workspace'
  if (/(llm|model|token|retry)/.test(id)) return 'Models'
  if (/(session|schedule|telemetry|compaction|feedback)/.test(id)) return 'Sessions'
  return 'Integrations'
}
function descriptionFor(id: string): string {
  if (id.includes('web-search')) return 'Search the web with configured providers.'
  if (id.includes('mcp')) return 'Connect Model Context Protocol capabilities.'
  if (id.includes('skill')) return 'Discover and run workspace skills.'
  if (id.includes('subagent')) return 'Coordinate delegated agent work.'
  if (id.includes('terminal') || id.includes('bash')) return 'Run shell commands in the workspace.'
  if (id.includes('lsp')) return 'Use language-server code intelligence.'
  if (id.includes('session')) return 'Store, query, and export chat sessions.'
  if (id.includes('llm') || id.includes('model')) return 'Provide model selection and execution.'
  if (id.includes('tool')) return 'Add an agent tool capability.'
  return 'DeepSeek Harness runtime capability.'
}

function BackIcon(): JSX.Element { return <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden><path d="m14.5 5-7 7 7 7M8 12h9"/></svg> }
function SearchIcon(): JSX.Element { return <svg viewBox="0 0 24 24" aria-hidden><circle cx="10.8" cy="10.8" r="5.8"/><path d="m15.2 15.2 4 4"/></svg> }
function ChevronIcon(): JSX.Element { return <svg className="plugin-market-chevron" viewBox="0 0 24 24" aria-hidden><path d="m8 10 4 4 4-4"/></svg> }
