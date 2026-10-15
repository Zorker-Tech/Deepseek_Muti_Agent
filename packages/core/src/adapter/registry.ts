/**
 * The adapter registry. Everything above the adapter layer discovers agents here,
 * so no consumer holds a hard reference to a concrete adapter (ADR-0002).
 *
 * @module @zorker/muti-agent-core/adapter/registry
 */

import { AgentCapabilitiesSchema, type AgentCapabilities, type AgentDescriptor } from '@zorker/muti-agent-contracts'
import type { AgentAdapter } from './types.ts'
import type { Logger } from './types.ts'

/** A descriptor plus the adapter that produced it, as reported to consumers. */
export interface RegisteredAgent {
  descriptor: AgentDescriptor
  adapter: AgentAdapter
}

/**
 * Registry of integrated agents.
 *
 * Registration is additive and ordering-independent: the GUI sorts, and the
 * orchestrator resolves by id. A duplicate id is a programming error and throws,
 * because silently keeping the first would hide a miscomposition.
 */
export class AgentRegistry {
  private readonly entries = new Map<string, RegisteredAgent>()

  /**
   * @param log - Logger for registration diagnostics.
   */
  constructor(private readonly log: Logger) {}

  /**
   * Add an adapter.
   *
   * @param adapter - The adapter to register.
   * @throws {Error} when an adapter with the same id is already registered.
   */
  add(adapter: AgentAdapter): void {
    if (this.entries.has(adapter.id)) {
      throw new Error(`muti-agent: agent "${adapter.id}" is already registered`)
    }
    // Descriptors need detection, which touches the filesystem and spawns probes.
    // Registration therefore records the adapter and resolves the descriptor on
    // first use; see `describe`.
    this.entries.set(adapter.id, {
      adapter,
      descriptor: {
        id: adapter.id as AgentDescriptor['id'],
        displayName: adapter.displayName,
        summary: '',
        capabilities: adapter.capabilities(),
        detection: { installed: false, source: 'none', reason: 'not probed yet' },
        transports: [],
        environmentKeys: [],
      },
    })
  }

  /** Remove an adapter, returning whether it was present. */
  remove(id: string): boolean {
    return this.entries.delete(id)
  }

  /** The adapter for an id, or `undefined`. */
  get(id: string): AgentAdapter | undefined {
    return this.entries.get(id)?.adapter
  }

  /** Whether an id is registered. */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Every registered agent, with descriptors resolved. */
  async describe(): Promise<readonly RegisteredAgent[]> {
    const out: RegisteredAgent[] = []
    for (const [id, entry] of this.entries) {
      try {
        const descriptor = await entry.adapter.describe()
        out.push({ adapter: entry.adapter, descriptor })
        this.entries.set(id, { adapter: entry.adapter, descriptor })
      } catch (cause) {
        // A detection failure must not remove an agent from the catalog: the UI
        // needs to show it, with the reason, so the user can fix the install.
        this.log.warn(`describing agent ${id} failed`, {
          error: cause instanceof Error ? cause.message : String(cause),
        })
        out.push({
          adapter: entry.adapter,
          descriptor: {
            ...entry.descriptor,
            detection: {
              installed: false,
              source: 'none',
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          },
        })
      }
    }
    out.sort((a, b) => a.descriptor.displayName.localeCompare(b.descriptor.displayName))
    return out
  }

  /** Ids of every registered agent, in registration order. */
  ids(): readonly string[] {
    return [...this.entries.keys()]
  }

  /**
   * Capabilities declared by an adapter.
   *
   * @param id - Agent id.
   * @returns The declaration, or `undefined` when the agent is not registered.
   */
  capabilities(id: string): AgentCapabilities | undefined {
    return this.entries.get(id)?.adapter.capabilities()
  }

  /**
   * Validate every registered adapter's capability declaration and report the
   * problems instead of throwing, so a bad adapter degrades one agent.
   *
   * @returns Human-readable problems, one line each.
   */
  inspectCapabilities(): readonly string[] {
    const problems: string[] = []
    for (const [id, entry] of this.entries) {
      const result = AgentCapabilitiesSchema.safeParse(entry.adapter.capabilities())
      if (!result.ok) {
        for (const issue of result.issues) {
          problems.push(`${id}.capabilities.${issue.path.join('.')}: ${issue.message}`)
        }
      }
    }
    return problems
  }
}
