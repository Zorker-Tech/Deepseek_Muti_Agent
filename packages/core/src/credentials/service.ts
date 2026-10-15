/**
 * Credential surface: one place that answers "is this agent usable, and how do I
 * change it" (ADR-0010).
 *
 * This service never stores a credential. It asks each adapter for status, delegates
 * login/logout to the agent's own CLI, redacts everything on the way out, and verifies
 * the result by re-reading status after every mutation. An environment-provided
 * credential is reported as such and is explicitly marked unmanageable, because
 * claiming MutiAgent could log it out would be a lie the user discovers later.
 *
 * @module @zorker/muti-agent-core/credentials/service
 */

import {
  ErrorCodes,
  MutiAgentError,
  type AgentAuthState,
  type AuthOperationResult,
  type CredentialFlow,
} from '@zorker/muti-agent-contracts'
import type { AgentRegistry } from '../adapter/registry.ts'
import type { Logger } from '../adapter/types.ts'
import type { Redactor } from '../log.ts'
import type { StateStore } from '../state/store.ts'

/** One agent's credential view, as shown in settings. */
export interface CredentialRow {
  agentId: string
  displayName: string
  installed: boolean
  state: AgentAuthState
  /** Whether MutiAgent can change this credential. */
  manageable: boolean
  /** Why it cannot be managed, when it cannot. */
  unmanageableReason?: string
  /** Flows the settings page may offer. */
  flows: readonly CredentialFlow[]
  /** Whether logout may be offered. */
  canLogout: boolean
}

/** Settings that change how status is determined. */
export interface CredentialOptions {
  /**
   * Whether to fall back to an agent's own CLI status probe when file inspection is
   * inconclusive. Costs one process start per probe.
   */
  probeCli: boolean
}

/**
 * Credential facade over the adapter registry.
 */
export class CredentialService {
  /**
   * @param registry - Adapter registry.
   * @param state - State store, used for the audit journal.
   * @param redactor - Applied to any CLI output before it leaves this process.
   * @param options - Probe policy.
   * @param log - Logger.
   */
  constructor(
    private readonly registry: AgentRegistry,
    private readonly state: StateStore,
    private readonly redactor: Redactor,
    private readonly options: CredentialOptions,
    private readonly log: Logger,
  ) {}

  /** Status for every registered agent, in display order. */
  async rows(): Promise<readonly CredentialRow[]> {
    const descriptors = await this.registry.describe()
    const rows: CredentialRow[] = []
    for (const entry of descriptors) {
      const agentId = String(entry.descriptor.id)
      const adapter = this.registry.get(agentId)
      if (adapter === undefined) continue
      const capabilities = entry.descriptor.capabilities
      let state: AgentAuthState
      try {
        state = await adapter.authStatus()
      } catch (cause) {
        state = {
          agentId: entry.descriptor.id,
          status: 'unknown',
          source: 'none',
          environmentKeys: [],
          detail: cause instanceof Error ? cause.message : String(cause),
          observedAt: new Date().toISOString(),
        }
      }
      const row: CredentialRow = {
        agentId,
        displayName: entry.descriptor.displayName,
        installed: entry.descriptor.detection.installed,
        state: this.redactState(state),
        manageable: state.source !== 'env',
        flows: capabilities.credentials.login,
        canLogout: capabilities.credentials.logout && state.source !== 'env',
      }
      if (state.source === 'env') {
        row.unmanageableReason =
          'This credential comes from an environment variable, which MutiAgent cannot change. Edit the process environment instead.'
      } else if (state.source === 'keyring') {
        row.unmanageableReason =
          'This credential lives in the operating system keyring, which MutiAgent does not read or write.'
      } else if (!entry.descriptor.detection.installed) {
        row.unmanageableReason = entry.descriptor.detection.reason ?? 'the agent binary was not found'
      }
      rows.push(row)
    }
    return rows
  }

  /**
   * Status for one agent.
   *
   * @param agentId - Agent id.
   * @throws {MutiAgentError} `harness/service-missing` when the agent is not registered.
   */
  async status(agentId: string): Promise<AgentAuthState> {
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) {
      throw new MutiAgentError(ErrorCodes.harnessServiceMissing, `agent "${agentId}" is not available`, {
        details: { agentId, registered: this.registry.ids().join(',') },
      })
    }
    return this.redactState(await adapter.authStatus())
  }

  /**
   * Start a credential flow through the agent's own CLI.
   *
   * @param agentId - Agent id.
   * @param flow - Flow to use; must be declared by the adapter.
   * @param secret - Secret for an `api-key` flow; passed on the child's stdin and
   *   never persisted, logged or returned.
   * @returns The intent plus the **observed** post-state.
   */
  async login(agentId: string, flow: CredentialFlow, secret?: string): Promise<AuthOperationResult> {
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) {
      throw new MutiAgentError(ErrorCodes.harnessServiceMissing, `agent "${agentId}" is not available`, {
        details: { agentId },
      })
    }
    const declared = adapter.capabilities().credentials.login
    if (!declared.includes(flow)) {
      throw new MutiAgentError(
        ErrorCodes.authLoginUnsupported,
        `${agentId} does not support a "${flow}" login`,
        {
          details: { agentId, flow, supported: declared.join(',') },
          remediation: 'Choose one of the supported flows shown in settings.',
        },
      )
    }
    const result = await adapter.login(secret === undefined ? { flow } : { flow, secret })
    const redacted = this.redactResult(result)
    this.state.appendJournal({
      at: new Date().toISOString(),
      kind: 'auth.login',
      id: agentId,
      actor: 'user',
      detail: { flow, ok: result.ok, status: result.state.status },
    })
    if (!result.ok && result.interaction === undefined) {
      this.log.warn(`login for ${agentId} did not succeed`, { status: result.state.status })
    }
    return redacted
  }

  /**
   * Revoke an agent's stored credential through its own CLI.
   *
   * @param agentId - Agent id.
   * @returns The intent plus the observed post-state.
   * @throws {MutiAgentError} `auth/login-unsupported` when the adapter has no logout.
   */
  async logout(agentId: string): Promise<AuthOperationResult> {
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) {
      throw new MutiAgentError(ErrorCodes.harnessServiceMissing, `agent "${agentId}" is not available`, {
        details: { agentId },
      })
    }
    if (!adapter.capabilities().credentials.logout) {
      throw new MutiAgentError(ErrorCodes.authLoginUnsupported, `${agentId} has no logout command`, {
        details: { agentId },
        remediation: 'Remove the credential through that agent\'s own interface.',
      })
    }
    const result = await adapter.logout()
    this.state.appendJournal({
      at: new Date().toISOString(),
      kind: 'auth.logout',
      id: agentId,
      actor: 'user',
      detail: { ok: result.ok, status: result.state.status },
    })
    return this.redactResult(result)
  }

  /** Whether CLI status probes are enabled. */
  get cliProbesEnabled(): boolean {
    return this.options.probeCli
  }

  /** Strip anything credential-shaped from a state before it is transmitted. */
  private redactState(state: AgentAuthState): AgentAuthState {
    return this.redactor.applyDeep(state)
  }

  /** Strip anything credential-shaped from an operation result. */
  private redactResult(result: AuthOperationResult): AuthOperationResult {
    return this.redactor.applyDeep(result)
  }
}

/**
 * Explain a status in the user's terms.
 *
 * @param state - Observed state.
 * @returns A one-line explanation plus, when there is one, the next action.
 */
export function explainAuth(state: AgentAuthState): { summary: string; action?: string } {
  switch (state.status) {
    case 'authenticated':
      return {
        summary:
          state.account === undefined
            ? `signed in via ${state.method ?? 'a stored credential'}`
            : `signed in as ${state.account}${state.plan === undefined ? '' : ` (${state.plan})`}`,
      }
    case 'unauthenticated':
      return { summary: 'not signed in', action: 'sign in below' }
    case 'expired':
      return { summary: 'the stored credential has expired', action: 'sign in again' }
    case 'misconfigured':
      return {
        summary: 'the credential file could not be read',
        action: 'repair or remove the file, then sign in again',
      }
    default:
      return {
        summary: 'sign-in state could not be determined',
        action: 'open the agent once to establish a credential',
      }
  }
}
