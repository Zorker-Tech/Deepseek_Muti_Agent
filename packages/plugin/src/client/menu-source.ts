/**
 * Our own source in the harness's `/` menu: the skills of the agent this conversation is
 * bound to.
 *
 * This is the safe, isolated way to make a *harness* surface follow the selected agent. The
 * `/` menu is composed of sources — the harness ships one for skills, one for commands, one
 * for references — and `inputTriggers.registerSource` is the public seam for adding another.
 * Nothing is shadowed (a source is our own group beside theirs), nothing is fabricated, and
 * our data comes from our own endpoint.
 *
 * It is per conversation because `candidates(session, req)` receives the session, which is how
 * this resolves the binding and answers with *that* agent's skills rather than a global list.
 * The harness's own skill source cannot do this: it reads `skills/list`, which the host
 * resolves from the session's agent preset, and a preset is fixed at session creation.
 *
 * Reach, stated plainly: this covers skills, in the menu. The Trajectory "Tools" tab is a view
 * of the session log's `request/header`, so tools reach it only through the session's
 * composition — see the capability panel for tools, and ADR-0015's note on why a plugin cannot
 * synthesize that composition safely.
 *
 * @module @zorker/muti-agent-plugin/client/menu-source
 */

import type { RpcClient } from './api.ts'
import { t } from './locales.ts'

/** One candidate the menu renders. */
interface MenuCandidate {
  name: string
  label?: string
  description?: string
  value?: string
}

/** The session the menu is serving, as the pipeline hands it over. */
interface MenuSession {
  sessionId: string
}

/** The registration point, structurally — the client depends on React alone (ADR-0005 §3). */
interface InputTriggerService {
  registerSource(source: {
    trigger: '/'
    name: string
    order?: number
    showGroupTitle?: boolean
    candidates(
      session: MenuSession,
      req: { query: string, signal: AbortSignal },
    ): Promise<readonly MenuCandidate[]>
    onPick(pick: { candidate: MenuCandidate }): { text: string }
  }): () => void
}

/** The slice of the client context this module uses. */
interface MenuContext {
  get(name: string): unknown
  /** The client context's effect returns whatever the framework's effect API returns. */
  effect?(callback: () => () => void, label?: string): unknown
  logger?: { warn?(line: string): void }
}

const SERVICE_NAME = 'inputTriggers'
const RETRY_ATTEMPTS = 6
const RETRY_DELAY_MS = 400

/**
 * Register the source, waiting for the input-trigger service to appear.
 *
 * The menu package activates on its own schedule, so a one-shot lookup taken at plugin
 * activation would be `undefined` in exactly the compositions where the menu exists. The
 * bounded retry is the client-side equivalent of the host's `ctx.inject`.
 *
 * @param ctx - The client context.
 * @param api - The wire client.
 */
export function registerAgentMenuSource(ctx: MenuContext, api: RpcClient): void {
  let registered = false
  const attempt = (remaining: number): void => {
    if (registered) return
    const service = ctx.get(SERVICE_NAME) as InputTriggerService | undefined
    if (service === undefined) {
      if (remaining > 1) setTimeout(() => { attempt(remaining - 1) }, RETRY_DELAY_MS).unref?.()
      return
    }
    try {
      const dispose = service.registerSource({
        trigger: '/',
        // Unique per trigger: a duplicate name throws, so this doubles as the group title.
        name: 'agents',
        order: 3,
        async candidates(session, { query, signal }) {
          const binding = await api.capabilitiesForSession({ sessionId: session.sessionId }, { signal })
          const skills = binding.inventory?.skills ?? []
          if (signal.aborted) return []
          const needle = query.trim().toLowerCase()
          return skills
            .filter(skill => needle === '' || skill.name.toLowerCase().includes(needle))
            .map(skill => ({
              name: skill.name,
              description: skill.description ?? t('menu.fromAgent', { name: binding.agentId }),
              value: `${binding.agentId}\u0000${skill.name}`,
            }))
        },
        onPick({ candidate }) {
          // Plain text, because no host pre-step will claim our names the way it claims the
          // harness's own skills. English on purpose: the reader is the harness agent, not the
          // user, and a localized sentence would be one more thing the model has to translate.
          return { text: `Delegate to ${candidate.value?.split('\u0000')[0] ?? 'the bound agent'}: use its "${candidate.name}" skill for ` }
        },
      })
      registered = true
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'mutiagent: agent skill menu source')
    } catch (cause) {
      ctx.logger?.warn?.(
        `mutiagent: the agent skill menu source was not registered: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }
  attempt(RETRY_ATTEMPTS)
}
