/**
 * The Capabilities tab of the right sidebar: what the agent a conversation is bound to
 * actually declares, per session.
 *
 * The data path is MutiAgent's own RPC, session-scoped: `capabilities.for_session` resolves
 * the binding from the stored preferences and answers the bound agent with its inventory,
 * and `credentials.status` supplies the sign-in pill beside it. A wire session projection
 * was the other candidate carrier, and it is deliberately not used: a projection unit is a
 * pure synchronous fold of the committed session log whose state the persisted cache seeds
 * from `stateSchema` rows, while a binding lives in MutiAgent's preferences file and the
 * inventory in another agent's configuration — neither is in the log, the unit's `init`
 * cannot read either (it is synchronous), and a value served from a checkpoint row would
 * show a conversation bound to an agent it is not bound to. The tab therefore reads our own
 * service, which is the authority, and re-reads on the plugin's revision store.
 *
 * Emptiness is rendered per section: an empty list whose inventory note names that section
 * shows the note's reason, because "this agent cannot enumerate its built-ins" is a
 * different fact from "it declares none".
 *
 * @module @zorker/muti-agent-plugin/client/views/CapabilitiesPanel
 */

import * as React from 'react'
import type {
  CapabilityCommand,
  CapabilityInventory,
  CapabilityMcpServer,
  CapabilitySkill,
  CapabilityTool,
  CredentialRow,
  RpcClient,
  SessionCapabilityBinding,
} from '../api.ts'
import { meshRevisionStore } from '../api.ts'
import { authStatus, relativeTime } from '../format.ts'
import type { Translate } from '../locales.ts'
import { useAsync, useStore, useT } from '../store.ts'
import { ErrorNotice } from '../components/DataTable.tsx'
import { StatusPill } from '../components/StatusPill.tsx'
import { RefreshGlyph } from '../icons.tsx'

/** Rows rendered per section before the list is capped, with the cap said out loud. */
export const CAPABILITY_ROW_CAP = 100

/** Props the slot framework hands this body: the wire client and the conversation it belongs to. */
export interface CapabilitiesBodyProps {
  /** The wire client, injected at registration. */
  readonly api: RpcClient
  /** The session whose binding this tab describes, injected at registration. */
  readonly sessionId: string
  /**
   * Open one of the plugin's own main panels by id, injected at registration.
   *
   * A function rather than a service read: the client entry owns the context, and a
   * composition without the layout service simply omits it and the action disappears.
   */
  readonly openPanel?: (id: string) => void
}

/** What one read of this tab gathers. */
interface CapabilityRead {
  readonly binding: SessionCapabilityBinding
  /** The bound agent's credential row, absent for the reserved harness binding. */
  readonly credential?: CredentialRow
}

/** One rendered section row: a name, an optional description and its metadata tags. */
interface CapabilityRow {
  readonly key: string
  readonly name: string
  readonly description?: string
  readonly meta: readonly string[]
  /** Full path or endpoint, rendered in a monospace line when present. */
  readonly detail?: string
  /** A badge rendered beside the name, e.g. "loaded on demand". */
  readonly badge?: string
}

/**
 * The tab body.
 *
 * @param props - The injected wire client, session id and panel opener.
 * @returns The capability inventory, or the failure that stopped it.
 */
export function CapabilitiesBody(props: CapabilitiesBodyProps): React.ReactElement {
  const t = useT()
  const { api, sessionId, openPanel } = props
  const revision = useStore(meshRevisionStore)
  const read = useAsync<CapabilityRead>(
    async signal => {
      const binding = await api.capabilitiesForSession({ sessionId }, { signal })
      if (binding.agentId === 'harness') return { binding }
      const rows = await api.credentialsStatus({ agentId: binding.agentId }, { signal })
      const credential = rows[0]
      return credential === undefined ? { binding } : { binding, credential }
    },
    `${sessionId}:${revision}`,
  )

  return (
    <div className="ma-cap">
      <header className="ma-cap-head">
        {read.state.status === 'ready' ? (
          <BindingLine binding={read.state.value.binding} credential={read.state.value.credential} />
        ) : (
          <span className="ma-cap-agent-name">{t('capabilities.title')}</span>
        )}
        <span className="ma-cap-sub">{t('capabilities.subtitle')}</span>
        <div className="ma-cap-actions">
          <button
            type="button"
            className="ma-btn ma-btn--quiet"
            onClick={read.reload}
            disabled={read.state.status === 'loading'}
          >
            <RefreshGlyph size={14} />
            {t('capabilities.refresh')}
          </button>
          {openPanel === undefined ? null : (
            <button type="button" className="ma-btn ma-btn--quiet" onClick={() => { openPanel('mutiagent') }}>
              {t('capabilities.openAgents')}
            </button>
          )}
        </div>
      </header>
      <div className="ma-cap-body">
        {read.state.status === 'loading' ? <p className="ma-note">{t('common.loading')}</p> : null}
        {read.state.status === 'error' ? <ErrorNotice failure={read.state.error} /> : null}
        {read.state.status === 'ready' ? <InventoryBody read={read.state.value} /> : null}
      </div>
    </div>
  )
}

/**
 * The bound-agent line: which agent, how the binding was resolved, and its sign-in state.
 *
 * @param props - The resolved binding and its credential row.
 * @returns The line.
 */
function BindingLine(props: {
  readonly binding: SessionCapabilityBinding
  readonly credential: CredentialRow | undefined
}): React.ReactElement {
  const t = useT()
  const { binding, credential } = props
  const source =
    binding.source === 'session'
      ? t('capabilities.binding.session')
      : binding.source === 'preferred'
        ? t('capabilities.binding.preferred')
        : t('capabilities.binding.harness')
  return (
    <div className="ma-cap-agent">
      <span className="ma-cap-agent-name">{binding.agentId}</span>
      <span className="ma-cap-sub ma-muted">{source}</span>
      <span className="ma-spacer" />
      {credential === undefined ? null : <SignInPill credential={credential} />}
    </div>
  )
}

/**
 * @param props - The bound agent's credential row.
 * @returns The sign-in pill, titled with the agent's own explanation when it has one.
 */
function SignInPill(props: { readonly credential: CredentialRow }): React.ReactElement {
  const t = useT()
  const { credential } = props
  const state = credential.state
  const presentation = credential.installed
    ? authStatus(state.status, t)
    : { tone: 'idle' as const, label: t('composer.agent.notInstalled') }
  const title = credential.installed
    ? state.detail ?? state.account
    : credential.unmanageableReason
  return (
    <StatusPill
      tone={presentation.tone}
      label={`${t('capabilities.signIn')}: ${presentation.label}`}
      {...(title === undefined ? {} : { title })}
    />
  )
}

/**
 * The inventory sections, or the reason there is none.
 *
 * @param props - The resolved read.
 * @returns The sections.
 */
function InventoryBody(props: { readonly read: CapabilityRead }): React.ReactElement {
  const t = useT()
  const { binding } = props.read
  const inventory = binding.inventory
  if (inventory === undefined) {
    // The reserved harness binding: its own surfaces describe it, so the note is the whole
    // answer rather than an error.
    const note = binding.notes?.[0]?.reason ?? t('capabilities.binding.harnessNote')
    return <p className="ma-note">{note}</p>
  }
  return (
    <React.Fragment>
      <Section
        title={t('capabilities.tools')}
        count={t('capabilities.count.tools', { count: inventory.tools.length })}
        rows={toolRows(inventory, t)}
        note={emptyNote(inventory, 'tools')}
      />
      <Section
        title={t('capabilities.skills')}
        count={t('capabilities.count.skills', { count: inventory.skills.length })}
        rows={skillRows(inventory, t)}
        note={emptyNote(inventory, 'skills')}
      />
      <Section
        title={t('capabilities.mcp')}
        count={t('capabilities.count.mcp', { count: inventory.mcpServers.length })}
        rows={mcpRows(inventory, t)}
        note={emptyNote(inventory, 'mcpServers')}
      />
      <Section
        title={t('capabilities.commands')}
        count={t('capabilities.count.commands', { count: inventory.commands.length })}
        rows={commandRows(inventory, t)}
        note={emptyNote(inventory, 'commands')}
      />
      <Section
        title={t('capabilities.contextFiles')}
        count={t('capabilities.count.contextFiles', { count: inventory.contextFiles.length })}
        rows={contextRows(inventory)}
        note={emptyNote(inventory, 'contextFiles')}
      />
      <footer className="ma-cap-section">
        <span className="ma-cap-sub">
          {t('capabilities.observed', { time: relativeTime(inventory.observedAt, t) })}
          {' · '}
          {t('capabilities.sources', { count: inventory.sources.length })}
        </span>
        {inventory.notes.length === 0 ? null : (
          <div className="ma-cap-rows">
            <span className="ma-cap-section-title">{t('capabilities.notes')}</span>
            {inventory.notes.map((note, index) => (
              <p className="ma-note" key={`${note.field}:${String(index)}`}>
                {`[${note.field}] ${note.reason}`}
              </p>
            ))}
          </div>
        )}
      </footer>
    </React.Fragment>
  )
}

/**
 * One section: a heading with its count, then rows or a reason for having none.
 *
 * @param props - Heading, count, rows and the section's own empty text.
 * @returns The section.
 */
function Section(props: {
  readonly title: string
  readonly count: string
  readonly rows: readonly CapabilityRow[]
  readonly note: string | undefined
}): React.ReactElement {
  const t = useT()
  const { title, count, rows, note } = props
  const shown = rows.slice(0, CAPABILITY_ROW_CAP)
  return (
    <section className="ma-cap-section">
      <div className="ma-cap-section-head">
        <h3 className="ma-cap-section-title">{title}</h3>
        <span className="ma-spacer" />
        <span className="ma-cap-sub">{count}</span>
      </div>
      {rows.length === 0 ? (
        <p className="ma-note">{note ?? t('capabilities.empty')}</p>
      ) : (
        <div className="ma-cap-rows">
          {shown.map(row => (
            <div className="ma-cap-row" key={row.key}>
              <div className="ma-cap-row-head">
                <span className="ma-cap-name">{row.name}</span>
                {row.badge === undefined ? null : <span className="ma-cap-tag">{row.badge}</span>}
              </div>
              {row.description === undefined ? null : <span className="ma-cap-desc">{row.description}</span>}
              {row.detail === undefined ? null : <span className="ma-cap-path ma-muted">{row.detail}</span>}
              {row.meta.length === 0 ? null : (
                <span className="ma-cap-meta">
                  {row.meta.map((entry, index) => (
                    <span className="ma-cap-tag" key={`${row.key}:${String(index)}`}>
                      {entry}
                    </span>
                  ))}
                </span>
              )}
            </div>
          ))}
          {rows.length > shown.length ? (
            <span className="ma-cap-sub">
              {t('capabilities.capped', { shown: shown.length, total: rows.length })}
            </span>
          ) : null}
        </div>
      )}
    </section>
  )
}

/** The inventory note naming one section, when it has one. */
function emptyNote(inventory: CapabilityInventory, field: string): string | undefined {
  return inventory.notes.find(note => note.field === field)?.reason
}

/** The localized label of a declaration source, falling back for a value this build does not know. */
function sourceLabel(source: string, t: Translate): string {
  const key = `capabilities.source.${source}` as Parameters<Translate>[0]
  const label = t(key)
  return label === key ? t('capabilities.source.other') : label
}

/**
 * @param inventory - The read inventory.
 * @param t - Translator.
 * @returns One row per declared tool.
 */
function toolRows(inventory: CapabilityInventory, t: Translate): readonly CapabilityRow[] {
  return inventory.tools.map((tool: CapabilityTool) => ({
    key: `tool:${tool.name}`,
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.path === undefined ? {} : { detail: tool.path }),
    ...(tool.discoverable === true ? { badge: t('capabilities.discoverable') } : {}),
    meta: [
      sourceLabel(tool.source, t),
      `${t('capabilities.column.approval')}: ${tool.approval ?? t('capabilities.approval.none')}`,
    ],
  }))
}

/**
 * @param inventory - The read inventory.
 * @param t - Translator.
 * @returns One row per discovered skill.
 */
function skillRows(inventory: CapabilityInventory, t: Translate): readonly CapabilityRow[] {
  return inventory.skills.map((skill: CapabilitySkill) => ({
    key: `skill:${skill.name}`,
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    ...(skill.path === undefined ? {} : { detail: skill.path }),
    meta: [
      sourceLabel(skill.source, t),
      `${t('capabilities.column.userInvocable')}: ${skill.userInvocable === true ? t('common.yes') : t('common.no')}`,
    ],
  }))
}

/**
 * @param inventory - The read inventory.
 * @param t - Translator.
 * @returns One row per configured MCP server.
 */
function mcpRows(inventory: CapabilityInventory, t: Translate): readonly CapabilityRow[] {
  return inventory.mcpServers.map((server: CapabilityMcpServer) => ({
    key: `mcp:${server.name}`,
    name: server.name,
    ...(server.url === undefined && server.command === undefined
      ? {}
      : { detail: server.url ?? server.command }),
    meta: [
      `${t('capabilities.column.transport')}: ${server.transport}`,
      `${t('capabilities.column.enabled')}: ${server.enabled ? t('common.yes') : t('common.no')}`,
      sourceLabel(server.source, t),
    ],
  }))
}

/**
 * @param inventory - The read inventory.
 * @param t - Translator.
 * @returns One row per user-facing command.
 */
function commandRows(inventory: CapabilityInventory, t: Translate): readonly CapabilityRow[] {
  return inventory.commands.map((command: CapabilityCommand) => ({
    key: `command:${command.name}`,
    name: `/${command.name}`,
    ...(command.description === undefined ? {} : { description: command.description }),
    meta: [sourceLabel(command.source, t)],
  }))
}

/**
 * @param inventory - The read inventory.
 * @returns One row per context-file path. Paths only: the file's text is never read here.
 */
function contextRows(inventory: CapabilityInventory): readonly CapabilityRow[] {
  return inventory.contextFiles.map(path => ({
    key: `context:${path}`,
    name: path,
    meta: [],
  }))
}
