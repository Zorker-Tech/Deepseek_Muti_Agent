/**
 * The Capabilities page: what one agent declares it can do.
 *
 * A panel row and a page of its own rather than only the right-sidebar tab, because a tab
 * *type* is not discoverable on its own — the right sidebar renders tabs that are already
 * open, so a type with no guide entry in view is invisible. This is the same row-plus-page
 * shape the Agents and Mesh panels use, so it is reachable the moment the plugin loads.
 *
 * It reads one agent at a time through `capabilities.get`, independent of any conversation:
 * "what can Codex do here" is a question about the machine, not about a session. The
 * session-bound view (which follows the conversation's bound agent) stays in the right
 * sidebar tab.
 *
 * @module @zorker/muti-agent-plugin/client/views/CapabilitiesPage
 */

import { useEffect, useState } from 'react'
import type { CapabilityInventory, ModelCatalogProvider, RpcClient } from '../api.ts'
import { t, subscribeLocale } from '../locales.ts'

/** Injected face: the wire client, supplied by the registration in `index.ts`. */
export interface CapabilitiesPageInjected {
  api: RpcClient
}

/** One agent as this page needs it. */
interface AgentOption {
  agentId: string
  displayName: string
  installed: boolean
}

/**
 * Render one labelled section, stating its own emptiness from the inventory's notes.
 *
 * @param props - Section title, the rows to render, and the note explaining an empty list.
 */
function Section(props: {
  title: string
  count: number
  note?: string | undefined
  children?: React.ReactNode | undefined
}): React.ReactElement {
  return (
    <section className="ma-caps-section">
      <h4 className="ma-caps-heading">
        {props.title}
        <span className="ma-caps-count">{String(props.count)}</span>
      </h4>
      {props.count === 0 ? (
        <p className="ma-note">{props.note ?? t('caps.none')}</p>
      ) : (
        <ul className="ma-caps-list">{props.children}</ul>
      )}
    </section>
  )
}

/** Find the note an inventory attaches to one category, if any. */
function noteFor(inventory: CapabilityInventory, field: string): string | undefined {
  return inventory.notes.find(note => note.field === field)?.reason
}

/**
 * The Capabilities page.
 *
 * @param props - The injected wire client.
 */
export function CapabilitiesPage({ api }: CapabilitiesPageInjected): React.ReactElement {
  const [agents, setAgents] = useState<readonly AgentOption[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [inventory, setInventory] = useState<CapabilityInventory | undefined>(undefined)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [revision, setRevision] = useState(0)
  const [localeRevision, setLocaleRevision] = useState(0)

  useEffect(() => subscribeLocale(() => { setLocaleRevision(value => value + 1) }), [])
  // Referenced so the subscription's purpose is explicit: a language switch re-renders.
  void localeRevision

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const diagnostics = await api.agentsDiagnostics({ signal: controller.signal })
        const options = diagnostics.agents.map(entry => ({
          agentId: entry.agentId,
          displayName: entry.displayName,
          installed: entry.installed,
        }))
        setAgents(options)
        setSelected(current => current ?? options[0]?.agentId)
      } catch (cause) {
        setState('error')
        setFailure(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { controller.abort() }
  }, [api])

  useEffect(() => {
    if (selected === undefined) return
    const controller = new AbortController()
    setState('loading')
    void (async () => {
      try {
        const read = await api.capabilitiesGet({ agentId: selected }, { signal: controller.signal })
        setInventory(read)
        setFailure(undefined)
        setState('ready')
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause))
        setState('error')
      }
    })()
    return () => { controller.abort() }
  }, [api, selected, revision])

  const providers: readonly ModelCatalogProvider[] = []

  return (
    <div className="ma-caps-page">
      <header className="ma-caps-header">
        <h3 className="ma-caps-title">{t('caps.panel')}</h3>
        <label className="ma-caps-picker">
          <span className="ma-muted">{t('caps.agent')}</span>
          <select
            value={selected ?? ''}
            onChange={event => { setSelected(event.target.value) }}
            aria-label={t('caps.agent')}
          >
            {agents.map(agent => (
              <option key={agent.agentId} value={agent.agentId}>
                {agent.displayName}
                {agent.installed ? '' : ` (${t('composer.agent.notInstalled')})`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="ma-btn" onClick={() => { setRevision(value => value + 1) }}>
          {t('common.refresh')}
        </button>
      </header>

      {state === 'loading' ? <p className="ma-note">{t('common.loading')}</p> : null}
      {state === 'error' ? (
        <p className="ma-note ma-note--error">{t('common.errorLabel')}: {failure ?? t('common.unknown')}</p>
      ) : null}

      {state === 'ready' && inventory !== undefined ? (
        <>
          <p className="ma-note">
            {t('caps.readFrom', { list: inventory.sources.filter(source => source.present).map(source => source.path).join(', ') || t('common.none') })}
          </p>
          <Section title={t('caps.tools')} count={inventory.tools.length} {...(noteFor(inventory, 'tools') === undefined ? {} : { note: noteFor(inventory, 'tools') })}>
            {inventory.tools.map(tool => (
              <li key={tool.name} className="ma-caps-row">
                <code className="ma-mono">{tool.name}</code>
                <span className="ma-caps-tag">{tool.source}</span>
                {tool.approval === undefined ? null : <span className="ma-caps-tag">{tool.approval}</span>}
                {tool.description === undefined ? null : <span className="ma-caps-desc">{tool.description}</span>}
              </li>
            ))}
          </Section>
          <Section title={t('caps.skills')} count={inventory.skills.length} {...(noteFor(inventory, 'skills') === undefined ? {} : { note: noteFor(inventory, 'skills') })}>
            {inventory.skills.map(skill => (
              <li key={`${skill.source}:${skill.name}`} className="ma-caps-row">
                <span className="ma-caps-name">{skill.name}</span>
                <span className="ma-caps-tag">{skill.source}</span>
                {skill.userInvocable === false ? <span className="ma-caps-tag">{t('caps.modelOnly')}</span> : null}
                {skill.description === undefined ? null : <span className="ma-caps-desc">{skill.description}</span>}
              </li>
            ))}
          </Section>
          <Section title={t('caps.mcp')} count={inventory.mcpServers.length} {...(noteFor(inventory, 'mcpServers') === undefined ? {} : { note: noteFor(inventory, 'mcpServers') })}>
            {inventory.mcpServers.map(server => (
              <li key={server.name} className="ma-caps-row">
                <span className="ma-caps-name">{server.name}</span>
                <span className="ma-caps-tag">{server.transport}</span>
                {server.enabled ? null : <span className="ma-caps-tag">{t('caps.disabled')}</span>}
                <span className="ma-caps-desc ma-mono">{server.command ?? server.url ?? ''}</span>
              </li>
            ))}
          </Section>
          <Section title={t('caps.commands')} count={inventory.commands.length} {...(noteFor(inventory, 'commands') === undefined ? {} : { note: noteFor(inventory, 'commands') })}>
            {inventory.commands.map(command => (
              <li key={command.name} className="ma-caps-row">
                <code className="ma-mono">/{command.name}</code>
                <span className="ma-caps-tag">{command.source}</span>
                {command.description === undefined ? null : <span className="ma-caps-desc">{command.description}</span>}
              </li>
            ))}
          </Section>
          <Section title={t('caps.context')} count={inventory.contextFiles.length} {...(noteFor(inventory, 'contextFiles') === undefined ? {} : { note: noteFor(inventory, 'contextFiles') })}>
            {inventory.contextFiles.map(path => (
              <li key={path} className="ma-caps-row">
                <span className="ma-caps-desc ma-mono">{path}</span>
              </li>
            ))}
          </Section>
          {providers.length === 0 ? null : <ul className="ma-caps-list" />}
        </>
      ) : null}
    </div>
  )
}
