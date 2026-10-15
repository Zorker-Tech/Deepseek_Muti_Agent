/**
 * Adapter construction shared by the harness plugin and the standalone MCP server, so
 * both enumerate the same agents with the same settings and there is one list of
 * supported integrations in the project.
 *
 * Each adapter is imported dynamically and its absence is tolerated: a build that ships
 * without one adapter must still serve the others (ADR-0006).
 *
 * @module @zorker/muti-agent-control-plane/adapters
 */

import type { MutiAgentService } from '@zorker/muti-agent-core'

/** One adapter this build knows how to construct. */
export interface AdapterEntry {
  /** Canonical agent id. */
  id: string
  /** Human name, for diagnostics when construction fails. */
  displayName: string
  /** Load and register the adapter. */
  load: (service: MutiAgentService) => Promise<void>
}

/**
 * The adapters compiled into this build, in display order.
 *
 * Import failures are reported as a diagnostic rather than thrown, because a missing
 * optional adapter peer must not stop the plugin from booting.
 */
export const ADAPTER_ENTRIES: readonly AdapterEntry[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    load: async service => {
      const module = await import('@zorker/muti-agent-adapter-codex')
      service.registerAdapter('codex', module.createCodexAdapter)
    },
  },
  {
    id: 'grok',
    displayName: 'Grok Build',
    load: async service => {
      const module = await import('@zorker/muti-agent-adapter-grok')
      service.registerAdapter('grok', module.createGrokAdapter)
    },
  },
  {
    id: 'omp',
    displayName: 'oh-my-pi',
    load: async service => {
      const module = await import('@zorker/muti-agent-adapter-omp')
      service.registerAdapter('omp', module.createOmpAdapter)
    },
  },
  {
    id: 'pi',
    displayName: 'Pi',
    load: async service => {
      const module = await import('@zorker/muti-agent-adapter-pi')
      service.registerAdapter('pi', module.createPiAdapter)
    },
  },
]

/** What happened while registering adapters. */
export interface AdapterRegistrationReport {
  registered: readonly string[]
  skipped: readonly { agentId: string, reason: string }[]
}

/**
 * Register every adapter this build carries.
 *
 * @param service - The service to register into.
 * @param options - Restrict to a subset of agent ids.
 * @returns Which adapters were registered and which were skipped, with reasons.
 */
export async function registerDefaultAdapters(
  service: MutiAgentService,
  options: { enabled?: readonly string[] } = {},
): Promise<AdapterRegistrationReport> {
  const registered: string[] = []
  const skipped: { agentId: string, reason: string }[] = []
  for (const entry of ADAPTER_ENTRIES) {
    if (options.enabled !== undefined && !options.enabled.includes(entry.id)) {
      skipped.push({ agentId: entry.id, reason: 'disabled in settings' })
      continue
    }
    try {
      await entry.load(service)
      registered.push(entry.id)
    } catch (cause) {
      skipped.push({
        agentId: entry.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return { registered, skipped }
}
