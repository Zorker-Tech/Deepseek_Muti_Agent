/**
 * The agent switcher in the composer tool row.
 *
 * Three rules shape it, and each comes from how a conversation actually works:
 *
 * 1. **The harness's own agent is the default.** A composer sits in one conversation, and
 *    most conversations belong to the harness agent; delegating is the exception. The first
 *    entry is therefore the harness itself, and it is what an untouched conversation shows.
 * 2. **The choice is per conversation.** It is stored against the session id, so one
 *    conversation can go to Codex while another stays on the harness agent.
 * 3. **The choice binds once made and cannot be changed.** A transcript, its git worktree and
 *    its shared todos accumulate around one agent, so re-pointing a conversation already
 *    under way would mix two contexts and put two agents in one working tree. The host
 *    refuses the change (`session/agent-locked`); this control becomes read-only, so the rule
 *    is visible rather than only enforced.
 *
 * The control reuses the harness's own `Menu` primitive — the same one the access-mode
 * switcher uses — and copies that trigger's metrics and tokens, so the tool row reads as one
 * set of controls. It sits in `conversation.input.right`, which the composer renders
 * immediately after the access-mode switcher and before the model selector; the model
 * selector itself is left to the harness, which owns that seat.
 *
 * @module @zorker/muti-agent-plugin/client/views/AgentSelect
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Menu, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelCatalog, RpcClient } from '../api.ts'
import { t, subscribeLocale } from '../locales.ts'

/** The reserved id meaning "the harness's own agent answers"; mirrors the host's constant. */
const HARNESS_AGENT = 'harness'

/** One agent as the switcher needs it. */
interface AgentChoice {
  agentId: string
  displayName: string
  installed: boolean
  /** Sign-in state, as the credential surface reported it. */
  auth: string
  /** The model the agent's own configuration selects, when it names one. */
  defaultModel?: string
  /** The configuration file that answer came from, when one was read. */
  source?: string
}

/** The state dot a status maps onto. */
function dotFor(choice: AgentChoice): 'done' | 'warning' | 'error' | 'idle' {
  if (!choice.installed) return 'idle'
  if (choice.auth === 'authenticated') return 'done'
  if (choice.auth === 'expired' || choice.auth === 'misconfigured') return 'warning'
  if (choice.auth === 'unauthenticated') return 'error'
  return 'idle'
}

/** The short status word shown beside an agent's name in the menu. */
function statusLabel(choice: AgentChoice): string {
  if (!choice.installed) return t('composer.agent.notInstalled')
  if (choice.auth === 'authenticated') return t('composer.agent.signedIn')
  if (choice.auth === 'expired') return t('composer.agent.expired')
  if (choice.auth === 'unauthenticated') return t('composer.agent.signedOut')
  return t('composer.agent.unknown')
}

/** Injected face: the wire client plus the conversation this control belongs to. */
export interface AgentSelectInjected {
  api: RpcClient
  /** Harness session id; the choice is stored against it. */
  sessionId: string
}

/**
 * The agent switcher.
 *
 * @param props - The injected wire client and session id.
 */
export function AgentSelect({ api, sessionId }: AgentSelectInjected) {
  const [choices, setChoices] = useState<readonly AgentChoice[]>([])
  const [bound, setBound] = useState<string | undefined>(undefined)
  const [settled, setSettled] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [localeRevision, setLocaleRevision] = useState(0)

  useEffect(() => subscribeLocale(() => { setLocaleRevision(value => value + 1) }), [])
  // Referenced so the subscription's purpose is explicit: a language switch re-renders this
  // control, which is why its status words and accessible names follow the language.
  void localeRevision

  /**
   * Read the agents, their sign-in state, and the model each one's configuration selects.
   *
   * @param signal - Cancellation, so a closed menu does not keep requests alive.
   */
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const options = signal === undefined ? {} : { signal }
    try {
      const [diagnostics, credentials, store, catalogs] = await Promise.all([
        api.agentsDiagnostics(options),
        api.credentialsList(options),
        api.preferencesGet(options),
        // The catalogs make the menu show where an agent's model comes from. A failure here
        // costs the hint, not the switcher, so it degrades to no model line.
        api.modelsList({}, options).catch(() => [] as readonly ModelCatalog[]),
      ])
      const authByAgent = new Map(credentials.map(row => [row.agentId, row.state.status as string]))
      const catalogByAgent = new Map(catalogs.map(catalog => [catalog.agentId, catalog]))
      setChoices(diagnostics.agents.map(entry => {
        const catalog = catalogByAgent.get(entry.agentId)
        const source = catalog?.sources.find(candidate => candidate.present)
        return {
          agentId: entry.agentId,
          displayName: entry.displayName,
          installed: entry.installed,
          auth: authByAgent.get(entry.agentId) ?? 'unknown',
          ...(catalog?.defaultModel === undefined ? {} : { defaultModel: catalog.defaultModel }),
          ...(source === undefined ? {} : { source: source.path }),
        }
      }))
      // The session's own binding wins; an untouched conversation falls back to the operator's
      // default, and with neither it is the harness agent's conversation.
      setBound(store.agentBySession?.[sessionId] ?? store.preferredAgent ?? HARNESS_AGENT)
      // Settled means the conversation has begun, which is what makes the binding fixed.
      setSettled(store.startedSessions.includes(sessionId))
      setFailure(undefined)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load])

  const current = useMemo(() => choices.find(choice => choice.agentId === bound), [choices, bound])
  const currentName = bound === undefined || bound === HARNESS_AGENT
    ? t('composer.agent.harness')
    : current?.displayName ?? bound

  /**
   * Whether the conversation's agent may still be chosen.
   *
   * Editable until the conversation begins, fixed afterwards: the transcript, the worktree
   * and the shared todos accumulate around one agent from the first turn, so a switch after
   * that would mix two contexts. The host refuses either way; this is the control agreeing
   * with the rule rather than offering an action that fails.
   */
  const locked = settled

  const items: MenuEntry[] = useMemo(() => {
    if (failure !== undefined) {
      return [{ id: '__failure', label: `${t('common.errorLabel')}: ${failure}`, disabled: true }]
    }
    const harness: MenuEntry = {
      id: HARNESS_AGENT,
      label: (
        <span className="ma-agent-option">
          <span className="ma-agent-option-name">{t('composer.agent.harness')}</span>
        </span>
      ),
    }
    const externals: MenuEntry[] = choices.map(choice => ({
      id: choice.agentId,
      label: (
        <span className="ma-agent-option">
          <span className="ma-agent-option-name">{choice.displayName}</span>
          <span className="ma-agent-option-status">
            {choice.defaultModel === undefined ? statusLabel(choice) : `${statusLabel(choice)} · ${choice.defaultModel}`}
          </span>
        </span>
      ),
      icon: <StateDot state={dotFor(choice)} size={8} />,
      ...(choice.installed ? {} : { disabled: true }),
    }))
    return [harness, ...externals]
  }, [choices, failure])

  const choose = useCallback((agentId: string): void => {
    setOpen(false)
    if (agentId === bound) return
    setBusy(true)
    void api
      .preferencesSet({ sessionAgent: { sessionId, agentId } })
      .then(store => {
        setBound(store.agentBySession?.[sessionId] ?? agentId)
        setSettled(store.startedSessions.includes(sessionId))
      })
      .catch(cause => {
        // A refusal means the conversation began between the read and the write, so the
        // control switches to its settled state and says why instead of retrying.
        if (cause instanceof Error && cause.message.includes('session/agent-locked')) setSettled(true)
        setFailure(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { setBusy(false) })
  }, [api, bound, sessionId])

  // The tooltip carries what the agent's configuration says about models, so where a model and
  // an endpoint come from is one hover away without a second dropdown in the tool row.
  const hint = useMemo(() => {
    const parts = [locked ? t('composer.agent.locked', { name: currentName }) : t('composer.agent.hint')]
    if (current?.defaultModel !== undefined) parts.push(t('composer.model.defaultModel', { name: current.defaultModel }))
    if (current?.source !== undefined) parts.push(t('composer.model.sources', { list: current.source }))
    return parts.join('\n')
  }, [current, currentName, locked])

  return (
    <Menu
      open={open}
      items={items}
      selectedId={bound}
      side="top"
      portal
      onSelect={choose}
      onClose={() => { setOpen(false) }}
      anchor={
        <button
          type="button"
          className="ma-agent-trigger"
          aria-label={locked
            ? t('composer.agent.lockedLabel', { name: currentName })
            : t('composer.agent.current', { name: currentName })}
          title={hint}
          disabled={busy || locked}
          onClick={() => {
            setOpen(!open)
            if (!open) void load()
          }}
        >
          {current === undefined || bound === HARNESS_AGENT ? null : (
            <span className="ma-agent-dot" aria-hidden>
              <StateDot state={dotFor(current)} size={8} />
            </span>
          )}
          <span className="ma-agent-label">{currentName}</span>
          <span className="ma-agent-chevron" aria-hidden>
            {locked ? (
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
                <path d="M6 7V5.5a2 2 0 0 1 4 0V7" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6.5 8 10.5l4-4" />
              </svg>
            )}
          </span>
        </button>
      }
    />
  )
}
