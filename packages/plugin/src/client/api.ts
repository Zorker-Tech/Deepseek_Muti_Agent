/**
 * The browser half's data layer: one RPC client over the gateway's `{ ok, … }`
 * envelope, typed wrappers for exactly the methods this client calls, and the SSE
 * subscription with its polling fallback (ADR-0004).
 *
 * The method names below mirror the host's operation catalog
 * (`packages/control-plane/src/operations/register.ts`) one for one; a method that
 * does not exist there must not appear here, and the parameter names are the
 * catalog's own so a rename upstream fails loudly instead of silently dropping a
 * filter.
 *
 * @module @zorker/muti-agent-plugin/client/api
 */

import type {
  AgentRunEvent,
  AgentSession,
  AgentSessionPartition,
  AgentTranscript,
  AgentAuthState,
  AuthOperationResult,
  Collaboration,
  ConflictReport,
  CredentialFlow,
  MeshWorkspace,
  RunRecord,
  SharedTodoDoc,
} from '@zorker/muti-agent-contracts'
import { createStore, type Store } from './store.ts'

/** The request/response endpoint, relative to the harness's `/api` channel. */
export const RPC_URL = '/api/mutiagent/rpc'

/** The server-sent event stream, relative to the harness's `/api` channel. */
export const EVENTS_URL = '/api/mutiagent/events'

/** How often the fallback poll runs while the event stream is down. */
export const POLL_INTERVAL_MS = 5_000

/** How many events the in-memory feed keeps. */
const FEED_LIMIT = 200

/** Every method this client calls; each is registered by the host operation catalog. */
export type RpcMethod =
  | 'sessions.list'
  | 'sessions.partitions'
  | 'sessions.refresh'
  | 'sessions.transcript'
  | 'sessions.import'
  | 'sessions.untrack'
  | 'runs.start'
  | 'runs.cancel'
  | 'runs.list'
  | 'worktrees.list'
  | 'worktrees.conflicts'
  | 'collaborations.list'
  | 'todos.get'
  | 'credentials.list'
  | 'credentials.login'
  | 'credentials.logout'
  | 'agents.diagnostics'
  | 'agents.launch_command'
  | 'preferences.get'
  | 'preferences.set'
  | 'models.list'

/** Sort orders `sessions.list` and `sessions.partitions` accept. */
export type SessionSort = 'updated' | 'created' | 'title'

/** Options common to every call. */
export interface RpcCallOptions {
  /** Asserted human approval; only the two confirmation-gated calls set it. */
  readonly confirm?: boolean
  /** Cancellation, forwarded to `fetch`. */
  readonly signal?: AbortSignal
}

/** The failure shape the host serializes. */
interface RpcErrorShape {
  readonly code: string
  readonly message: string
  readonly remediation: string | undefined
  readonly retryable: boolean
}

/** The confirmation challenge a dangerous operation returns instead of acting. */
export interface ConfirmationChallenge {
  readonly confirmationRequired: true
  readonly operation: string
  readonly prompt: string
  readonly howToConfirm: string
  readonly effects?: readonly string[]
}

/** A completed call: either the operation's result or a confirmation challenge. */
export type RpcOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'confirm'; readonly challenge: ConfirmationChallenge }

/** A domain failure carried back from the host, ready for inline display. */
export class RpcError extends Error {
  /** Stable code, e.g. `wire/bad-params`. */
  readonly code: string
  /** The next step for the human, when the host offered one. */
  readonly remediation: string | undefined
  /** Whether a plain retry could succeed. */
  readonly retryable: boolean
  /** HTTP status, when the failure was the transport rather than the operation. */
  readonly status: number | undefined

  /**
   * @param shape - Code, message and the optional action.
   */
  constructor(shape: RpcErrorShape & { status?: number }) {
    super(shape.message)
    this.name = 'RpcError'
    this.code = shape.code
    this.remediation = shape.remediation
    this.retryable = shape.retryable
    this.status = shape.status
  }
}

/**
 * Raised when a call needed confirmation and the host answered with a challenge.
 * A distinct outcome, never a success: the caller must ask a human, then repeat
 * with `confirm: true`.
 */
export class ConfirmationRequiredError extends RpcError {
  /** What the host wants confirmed, in the human's terms. */
  readonly challenge: ConfirmationChallenge

  /**
   * @param challenge - The host's challenge.
   */
  constructor(challenge: ConfirmationChallenge) {
    super({
      code: 'mesh/confirmation-required',
      message: challenge.prompt,
      remediation: challenge.howToConfirm,
      retryable: true,
    })
    this.name = 'ConfirmationRequiredError'
    this.challenge = challenge
  }
}

/** A `{ sessions.partitions }` summary: index freshness and per-agent totals. */
export interface SessionIndexSummary {
  readonly agents: readonly {
    readonly agentId: string
    readonly displayName: string
    readonly installed: boolean
    readonly total: number
    readonly tracked: number
    readonly lastScan?: string
    readonly error?: string
  }[]
  readonly totalTracked: number
  readonly lastRefresh?: string
}

/** One agent's refresh result, as `sessions.refresh` reports it. */
export interface RefreshOutcome {
  readonly agentId: string
  readonly ok: boolean
  readonly found: number
  readonly error?: string
}

/** One agent's credential view, as `credentials.list` reports it. */
export interface CredentialRow {
  readonly agentId: string
  readonly displayName: string
  readonly installed: boolean
  readonly state: AgentAuthState
  /** Whether MutiAgent can change this credential. */
  readonly manageable: boolean
  /** Why it cannot be managed, when it cannot. */
  readonly unmanageableReason?: string
  /** Flows the settings page may offer. */
  readonly flows: readonly CredentialFlow[]
  /** Whether logout may be offered. */
  readonly canLogout: boolean
}

/** The `agents.diagnostics` report. */
export interface DiagnosticsReport {
  readonly pluginVersion: string
  readonly stateDir: string
  readonly isolation: 'worktree' | 'shared-disabled'
  readonly harness: {
    readonly services: readonly string[]
    readonly missing: readonly { readonly service: string; readonly disables: string }[]
  }
  readonly agents: readonly {
    readonly agentId: string
    readonly displayName: string
    readonly installed: boolean
    readonly version?: string
    readonly binaryPath?: string
    readonly reason?: string
    readonly transports: readonly {
      readonly mode: string
      readonly mechanism: string
      readonly available: boolean
    }[]
  }[]
  readonly warnings: readonly string[]
}

/** The argv `agents.launch_command` returns: what a human pastes into a terminal. */
export interface LaunchCommand {
  readonly argv: readonly string[]
  readonly note: string
}

/** Parameters for `sessions.list` and `sessions.partitions`. */
export interface SessionListParams {
  /** Only these agents. */
  readonly agentIds?: readonly string[]
  /** Only sessions created in this working directory. */
  readonly cwd?: string
  /** Only sessions inside this repository. */
  readonly repoRoot?: string
  /** Substring match against title, cwd and native id. */
  readonly query?: string
  /** Include sessions discovered but not yet tracked. */
  readonly includeUntracked?: boolean
  /** Result order. */
  readonly sort?: SessionSort
  /** Maximum sessions per agent. */
  readonly limit?: number
}

/** Parameters for `runs.start`. */
export interface RunStartParams {
  readonly agentId: string
  readonly prompt: string
  readonly cwd?: string
  readonly collaborationId?: string
  readonly isolation?: 'worktree' | 'shared-cwd'
  readonly resumeNativeId?: string
  readonly model?: string
  readonly sandbox?: string
  readonly approval?: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  readonly requestedBy?: string
}

/** Everything `runs.list` returns for one page of history. */
export interface RunListResult {
  readonly runs: readonly RunRecord[]
}

/** Whether a decoded value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param source - A record to read from.
 * @param key - Property name.
 * @returns The string value, or `undefined` when it is absent or another type.
 */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * @param value - A decoded payload.
 * @returns Whether it is the confirmation challenge rather than a result.
 */
function isChallenge(value: unknown): value is ConfirmationChallenge {
  return isRecord(value) && value['confirmationRequired'] === true
}

/**
 * @param value - The envelope's `error` member.
 * @param status - HTTP status the answer carried.
 * @returns The failure shape, defensively filled in.
 */
function readErrorShape(value: unknown, status: number): RpcErrorShape {
  if (!isRecord(value)) {
    return {
      code: 'wire/bad-envelope',
      message: `the MutiAgent endpoint answered HTTP ${String(status)} without a readable error`,
      remediation: 'Confirm the plugin is loaded in this harness host, then retry.',
      retryable: true,
    }
  }
  const remediation = readString(value, 'remediation')
  return {
    code: readString(value, 'code') ?? 'harness/unclassified',
    message: readString(value, 'message') ?? `the MutiAgent endpoint answered HTTP ${String(status)}`,
    remediation,
    retryable: value['retryable'] === true,
  }
}

/**
 * @param cause - A caught transport failure.
 * @returns A message safe to show.
 */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The typed wire client. One instance per plugin load is enough; it holds no state
 * beyond the endpoint, so a surface may also build its own.
 */
export class RpcClient {
  private readonly url: string

  /**
   * @param options - Endpoint override, for tests and for a host that mounts the
   *   channel elsewhere.
   */
  constructor(options: { readonly url?: string } = {}) {
    this.url = options.url ?? RPC_URL
  }

  /**
   * Invoke one method and return its outcome, including the confirmation challenge
   * as a distinct tag rather than a success.
   *
   * @typeParam T - The operation's result type, as declared in the host catalog.
   * @param method - Operation id.
   * @param params - Operation parameters, using the catalog's own names.
   * @param options - Confirmation flag and cancellation.
   * @returns The tagged outcome.
   * @throws {RpcError} When the transport failed or the host answered `ok: false`.
   */
  async invoke<T>(
    method: RpcMethod,
    params: object = {},
    options: RpcCallOptions = {},
  ): Promise<RpcOutcome<T>> {
    const body: Record<string, unknown> = { method, params }
    if (options.confirm === true) body['confirm'] = true
    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (cause) {
      // An abort is the caller's own navigation, not a failure to report.
      if (cause instanceof Error && cause.name === 'AbortError') throw cause
      throw new RpcError({
        code: 'wire/bad-envelope',
        message: `the MutiAgent endpoint could not be reached: ${messageOf(cause)}`,
        remediation: 'Check that this harness host serves MutiAgent, then retry.',
        retryable: true,
      })
    }

    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      throw new RpcError({
        code: 'wire/bad-envelope',
        message: `the MutiAgent endpoint's answer was cut short: ${messageOf(cause)}`,
        remediation: 'Retry; if it repeats, check the host log.',
        retryable: true,
        status: response.status,
      })
    }

    let payload: unknown
    try {
      payload = text.trim() === '' ? undefined : JSON.parse(text)
    } catch {
      throw new RpcError({
        code: 'wire/bad-envelope',
        message: `the MutiAgent endpoint answered HTTP ${String(response.status)} with a non-JSON body`,
        remediation:
          response.status === 403
            ? 'This browser session is not the host owner; open the GUI on the host machine.'
            : 'Retry, and check the host log if it repeats.',
        retryable: false,
        status: response.status,
      })
    }

    if (payload === undefined) {
      throw new RpcError({
        code: 'wire/bad-envelope',
        message: `the MutiAgent endpoint answered HTTP ${String(response.status)} with an empty body`,
        remediation: 'Retry, and check the host log if it repeats.',
        retryable: true,
        status: response.status,
      })
    }
    if (!isRecord(payload)) {
      throw new RpcError({
        code: 'wire/bad-envelope',
        message: `the MutiAgent endpoint answered HTTP ${String(response.status)} with an unreadable envelope`,
        remediation: 'Retry, and check the host log if it repeats.',
        retryable: false,
        status: response.status,
      })
    }
    if (payload['ok'] === false) {
      throw new RpcError({ ...readErrorShape(payload['error'], response.status), status: response.status })
    }
    if (payload['ok'] !== true) {
      throw new RpcError({
        code: 'wire/bad-envelope',
        message: `the MutiAgent endpoint answered HTTP ${String(response.status)} without an ok flag`,
        remediation: 'Retry, and check the host log if it repeats.',
        retryable: false,
        status: response.status,
      })
    }

    const result: unknown = payload['result']
    if (isChallenge(result)) return { kind: 'confirm', challenge: result }
    // The wire is the boundary: the host validated the result against the schema the
    // catalog declares for this method, so the caller's declared type is the contract.
    return { kind: 'ok', value: result as T }
  }

  /**
   * Invoke one method, treating a confirmation challenge as a failure.
   *
   * @typeParam T - The operation's result type.
   * @param method - Operation id.
   * @param params - Operation parameters.
   * @param options - Confirmation flag and cancellation.
   * @returns The operation's result.
   * @throws {RpcError} On any failure, including a challenge.
   */
  async call<T>(method: RpcMethod, params: object = {}, options: RpcCallOptions = {}): Promise<T> {
    const outcome = await this.invoke<T>(method, params, options)
    if (outcome.kind === 'confirm') throw new ConfirmationRequiredError(outcome.challenge)
    return outcome.value
  }

  // ------------------------------------------------------------ sessions ----

  /**
   * @param params - Filters applied on the host.
   * @param options - Cancellation.
   * @returns Canonical sessions.
   */
  async sessionsList(
    params: SessionListParams = {},
    options: RpcCallOptions = {},
  ): Promise<readonly AgentSession[]> {
    const result = await this.call<{ sessions: readonly AgentSession[] }>(
      'sessions.list',
      { ...params },
      options,
    )
    return result.sessions
  }

  /**
   * @param params - Filters applied on the host.
   * @param options - Cancellation.
   * @returns One partition per agent plus index freshness.
   */
  async sessionsPartitions(
    params: SessionListParams = {},
    options: RpcCallOptions = {},
  ): Promise<{ partitions: readonly AgentSessionPartition[]; summary: SessionIndexSummary }> {
    return await this.call<{ partitions: readonly AgentSessionPartition[]; summary: SessionIndexSummary }>(
      'sessions.partitions',
      { ...params },
      options,
    )
  }

  /**
   * @param params - Which agents to re-scan; omitted scans all of them.
   * @param options - Cancellation.
   * @returns One outcome per agent.
   */
  async sessionsRefresh(
    params: { agentIds?: readonly string[] } = {},
    options: RpcCallOptions = {},
  ): Promise<readonly RefreshOutcome[]> {
    const result = await this.call<{ outcomes: readonly RefreshOutcome[] }>(
      'sessions.refresh',
      { ...params },
      options,
    )
    return result.outcomes
  }

  /**
   * @param params - Session key and read cap.
   * @param options - Cancellation.
   * @returns The bounded transcript window.
   */
  async sessionsTranscript(
    params: { key: string; maxMessages?: number },
    options: RpcCallOptions = {},
  ): Promise<AgentTranscript> {
    return await this.call<AgentTranscript>('sessions.transcript', { ...params }, options)
  }

  /**
   * @param params - Session keys to track and the actor to record.
   * @param options - Cancellation.
   * @returns The tracked and already-tracked keys.
   */
  async sessionsImport(
    params: { keys: readonly string[]; actor?: string },
    options: RpcCallOptions = {},
  ): Promise<{ tracked: readonly string[]; alreadyTracked: readonly string[] }> {
    return await this.call<{ tracked: readonly string[]; alreadyTracked: readonly string[] }>(
      'sessions.import',
      { ...params },
      options,
    )
  }

  /**
   * @param params - Session keys to stop tracking.
   * @param options - Cancellation.
   * @returns The keys that were untracked.
   */
  async sessionsUntrack(
    params: { keys: readonly string[] },
    options: RpcCallOptions = {},
  ): Promise<readonly string[]> {
    const result = await this.call<{ untracked: readonly string[] }>(
      'sessions.untrack',
      { ...params },
      options,
    )
    return result.untracked
  }

  // ---------------------------------------------------------------- runs ----

  /**
   * @param params - The run request.
   * @param options - Cancellation.
   * @returns The recorded run.
   */
  async runsStart(params: RunStartParams, options: RpcCallOptions = {}): Promise<RunRecord> {
    const result = await this.call<{ run: RunRecord }>('runs.start', { ...params }, options)
    return result.run
  }

  /**
   * Cancel a live run. The confirmation gate is satisfied by a human decision taken
   * in the UI immediately before this call.
   *
   * @param params - Run id and the reason recorded on the run.
   * @param options - Cancellation.
   * @returns Whether it was cancelled, plus the settled record when available.
   */
  async runsCancel(
    params: { runId: string; reason?: string },
    options: RpcCallOptions = {},
  ): Promise<{ cancelled: boolean; run?: RunRecord }> {
    return await this.call<{ cancelled: boolean; run?: RunRecord }>(
      'runs.cancel',
      { ...params, confirm: true },
      options,
    )
  }

  /**
   * @param params - Page size; the host defaults to 50.
   * @param options - Cancellation.
   * @returns Recent runs, newest first.
   */
  async runsList(
    params: { limit?: number } = {},
    options: RpcCallOptions = {},
  ): Promise<RunListResult> {
    return await this.call<RunListResult>('runs.list', { ...params }, options)
  }

  // ----------------------------------------------------------- worktrees ----

  /**
   * @param params - Restrict to one repository.
   * @param options - Cancellation.
   * @returns Worktrees MutiAgent owns.
   */
  async worktreesList(
    params: { repoRoot?: string } = {},
    options: RpcCallOptions = {},
  ): Promise<readonly MeshWorkspace[]> {
    const result = await this.call<{ worktrees: readonly MeshWorkspace[] }>(
      'worktrees.list',
      { ...params },
      options,
    )
    return result.worktrees
  }

  /**
   * @param params - The repository to analyse.
   * @param options - Cancellation.
   * @returns The conflict report.
   */
  async worktreesConflicts(
    params: { repoRoot: string },
    options: RpcCallOptions = {},
  ): Promise<ConflictReport> {
    return await this.call<ConflictReport>('worktrees.conflicts', { ...params }, options)
  }

  // ------------------------------------------------------ collaborations ----

  /**
   * @param options - Cancellation.
   * @returns Every collaboration with its plan and board.
   */
  async collaborationsList(options: RpcCallOptions = {}): Promise<readonly Collaboration[]> {
    const result = await this.call<{ collaborations: readonly Collaboration[] }>(
      'collaborations.list',
      {},
      options,
    )
    return result.collaborations
  }

  /**
   * @param params - The collaboration whose board to read.
   * @param options - Cancellation.
   * @returns The shared todo board.
   */
  async todosGet(
    params: { collaborationId: string },
    options: RpcCallOptions = {},
  ): Promise<SharedTodoDoc> {
    return await this.call<SharedTodoDoc>('todos.get', { ...params }, options)
  }

  // --------------------------------------------------------- credentials ----

  /**
   * @param options - Cancellation.
   * @returns One row per registered agent.
   */
  async credentialsList(options: RpcCallOptions = {}): Promise<readonly CredentialRow[]> {
    const result = await this.call<{ credentials: readonly CredentialRow[] }>(
      'credentials.list',
      {},
      options,
    )
    return result.credentials
  }

  /**
   * Start one agent's own sign-in flow.
   *
   * @param params - Agent, flow, and the API key for an `api-key` flow.
   * @param options - Cancellation.
   * @returns The intent plus the observed post-state.
   */
  async credentialsLogin(
    params: { agentId: string; flow: CredentialFlow; secret?: string },
    options: RpcCallOptions = {},
  ): Promise<AuthOperationResult> {
    const result = await this.call<{ result: AuthOperationResult }>(
      'credentials.login',
      { ...params },
      options,
    )
    return result.result
  }

  /**
   * Sign one agent out. Gated on a human confirmation taken in the UI.
   *
   * @param params - The agent to sign out of.
   * @param options - Cancellation.
   * @returns The intent plus the observed post-state.
   */
  async credentialsLogout(
    params: { agentId: string },
    options: RpcCallOptions = {},
  ): Promise<AuthOperationResult> {
    const result = await this.call<{ result: AuthOperationResult }>(
      'credentials.logout',
      { ...params, confirm: true },
      options,
    )
    return result.result
  }

  // --------------------------------------------------------------- agents ----

  /**
   * @param options - Cancellation.
   * @returns What MutiAgent can reach on this machine.
   */
  async agentsDiagnostics(options: RpcCallOptions = {}): Promise<DiagnosticsReport> {
    return await this.call<DiagnosticsReport>('agents.diagnostics', {}, options)
  }

  /**
   * @param options - Cancellation.
   * @returns The stored operator preferences.
   */
  async preferencesGet(options: RpcCallOptions = {}): Promise<PreferencesSnapshot> {
    return await this.call<PreferencesSnapshot>('preferences.get', {}, options)
  }

  /**
   * @param params - The fields to change.
   * @param options - Cancellation.
   * @returns The stored preferences after the change.
   */
  async preferencesSet(
    params: {
      preferredAgent?: string
      sessionAgent?: { sessionId: string; agentId: string }
      preferredModel?: { agentId: string; model: string }
    },
    options: RpcCallOptions = {},
  ): Promise<PreferencesSnapshot> {
    return await this.call<PreferencesSnapshot>('preferences.set', { ...params }, options)
  }

  /**
   * @param params - Agents to read; omitted reads all of them.
   * @param options - Cancellation.
   * @returns One catalog per agent, each carrying its own declared gaps.
   */
  async modelsList(params: { agentIds?: readonly string[] } = {}, options: RpcCallOptions = {}): Promise<readonly ModelCatalog[]> {
    const result = await this.call<{ catalogs: readonly ModelCatalog[] }>('models.list', { ...params }, options)
    return result.catalogs
  }

  /**
   * @param params - Agent, and the native session id to resume.
   * @param options - Cancellation.
   * @returns The argv that opens the agent's own UI.
   */
  async agentsLaunchCommand(
    params: { agentId: string; nativeSessionId?: string },
    options: RpcCallOptions = {},
  ): Promise<LaunchCommand> {
    return await this.call<LaunchCommand>('agents.launch_command', { ...params }, options)
  }
}

/** The operator preferences MutiAgent persists, as the host stores them. */
export interface Preferences {
  /** Agent a delegated run defaults to when the caller names none. */
  readonly preferredAgent?: string
  /** Model chosen per agent, keyed by agent id. */
  readonly preferredModelByAgent?: Readonly<Record<string, string>>
  /** Agent bound to a harness session, keyed by session id. */
  readonly agentBySession?: Readonly<Record<string, string>>
}

/** One provider an agent's configuration declares. */
export interface ModelCatalogProvider {
  readonly id: string
  readonly name?: string
  readonly baseUrl?: string
  readonly apiKeyEnv?: string
  readonly credentialPresent?: boolean
  readonly wireApi?: string
  readonly source: string
}

/** One model an agent accepts, as its configuration declares it. */
export interface ModelCatalogEntry {
  readonly id: string
  readonly displayName?: string
  readonly providerId?: string
  readonly isDefault?: boolean
  readonly contextWindow?: number
  readonly source: string
}

/** One agent's model and provider catalog. */
export interface ModelCatalog {
  readonly agentId: string
  readonly defaultModel?: string
  readonly providers: readonly ModelCatalogProvider[]
  readonly models: readonly ModelCatalogEntry[]
  readonly sources: readonly { readonly path: string; readonly present: boolean; readonly note?: string }[]
  readonly notes: readonly { readonly field: string; readonly reason: string }[]
  readonly observedAt: string
}

/** What `preferences.get` answers: the stored preferences plus which bindings have settled. */
export interface PreferencesSnapshot extends Preferences {
  /**
   * Bound sessions that have already begun.
   *
   * A binding may be changed while its conversation has not started; from the first turn it
   * is fixed. The host decides that, so it reports it rather than letting a client guess.
   */
  readonly startedSessions: readonly string[]
}

/** The kinds the host publishes on the mesh stream. */
export type MeshEventKind = 'run-event' | 'run-record' | 'worktree-progress' | 'todos' | 'plan'

/**
 * One decoded stream event. Payloads are validated shallowly: the list operations
 * are the source of truth for anything a table renders, and the stream is used for
 * liveness, for run progress and for invalidation.
 */
export interface MeshEventEnvelope {
  /** Which family the event belongs to. */
  readonly kind: MeshEventKind
  /** When the host published it. */
  readonly at: string
  /** Run the event is scoped to, when any. */
  readonly runId?: string
  /** Collaboration the event is scoped to, when any. */
  readonly collaborationId?: string
  /** Canonical run event, for `run-event`. */
  readonly event?: AgentRunEvent
  /** Run record snapshot, for `run-record`. */
  readonly record?: RunRecord
  /** Worktree snapshot, for `worktree-progress`. */
  readonly worktree?: MeshWorkspace
}

/** Connection state of the event stream. */
export type MeshStreamState = 'connecting' | 'open' | 'down'

/** What the browser half knows about the stream right now. */
export interface MeshFeedState {
  /** Current connection state. */
  readonly status: MeshStreamState
  /** Timestamp of the newest event seen. */
  readonly lastEventAt: string | undefined
  /** The newest events, bounded and newest first. */
  readonly recent: readonly MeshEventEnvelope[]
}

/** The live event feed every surface may read. */
export const meshFeedStore: Store<MeshFeedState> = createStore({
  status: 'connecting',
  lastEventAt: undefined,
  recent: [],
})

/**
 * Bumped whenever a stream event invalidates list data, so a view can re-query
 * without polling. Token-level deltas deliberately do not bump it.
 */
export const meshRevisionStore: Store<number> = createStore(0)

/**
 * @param value - A candidate payload.
 * @returns Whether it looks like a run event (its family is validated at decode time).
 */
function isRunEvent(value: unknown): value is AgentRunEvent {
  return isRecord(value) && typeof value['kind'] === 'string'
}

/**
 * @param value - A candidate payload.
 * @returns Whether it looks like a run record.
 */
function isRunRecord(value: unknown): value is RunRecord {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['status'] === 'string'
}

/**
 * @param value - A candidate payload.
 * @returns Whether it looks like a worktree snapshot.
 */
function isWorkspace(value: unknown): value is MeshWorkspace {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['branch'] === 'string'
}

/**
 * @param data - A raw SSE `data:` field.
 * @returns The decoded event, or `undefined` when it is not one this build knows.
 */
export function decodeMeshEvent(data: string): MeshEventEnvelope | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const kind = readString(parsed, 'kind')
  if (
    kind !== 'run-event' &&
    kind !== 'run-record' &&
    kind !== 'worktree-progress' &&
    kind !== 'todos' &&
    kind !== 'plan'
  ) {
    return undefined
  }
  const runId = readString(parsed, 'runId')
  const collaborationId = readString(parsed, 'collaborationId')
  const event = parsed['event']
  const record = parsed['record']
  const worktree = parsed['worktree']
  return {
    kind,
    at: readString(parsed, 'at') ?? new Date().toISOString(),
    ...(runId === undefined ? {} : { runId }),
    ...(collaborationId === undefined ? {} : { collaborationId }),
    ...(isRunEvent(event) ? { event } : {}),
    ...(isRunRecord(record) ? { record } : {}),
    ...(isWorkspace(worktree) ? { worktree } : {}),
  }
}

/**
 * Fold one event into the feed and bump the invalidation revision when it means
 * list data is stale.
 *
 * @param event - A decoded event.
 */
function recordMeshEvent(event: MeshEventEnvelope): void {
  meshFeedStore.update(state => ({
    ...state,
    lastEventAt: event.at,
    recent: [event, ...state.recent].slice(0, FEED_LIMIT),
  }))
  const stale = event.kind !== 'run-event' || event.event?.kind === 'run.finished'
  if (stale) meshRevisionStore.update(revision => revision + 1)
}

/** Options for {@link subscribeMeshEvents}. */
export interface MeshStreamOptions {
  /** Called for every decoded event, after the feed store has been updated. */
  readonly onEvent?: (event: MeshEventEnvelope) => void
  /**
   * The fallback poll body, run immediately and then every
   * {@link POLL_INTERVAL_MS} while the stream is down.
   */
  readonly poll?: (signal: AbortSignal) => void | Promise<void>
  /** Poll interval override. */
  readonly pollMs?: number
  /** Stream URL override. */
  readonly url?: string
}

/**
 * Subscribe to the mesh event stream, with a polling fallback.
 *
 * `EventSource` reconnects on its own; this adds the two things it does not do —
 * a defined "the stream is down" state, and a poll that keeps the panels fresh in
 * the meantime. Both the source and the timer are torn down by the returned
 * disposer, which is registered with `ctx.effect`, so nothing survives unload.
 *
 * @param options - Event sink, poll body and endpoints.
 * @returns A disposer that closes the stream and stops the poll.
 */
export function subscribeMeshEvents(options: MeshStreamOptions): () => void {
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS
  const url = options.url ?? EVENTS_URL
  const source: EventSource | undefined =
    typeof EventSource === 'undefined' ? undefined : new EventSource(url)
  let timer: ReturnType<typeof setInterval> | undefined
  let controller: AbortController | undefined

  const poll = (): void => {
    const body = options.poll
    if (body === undefined) return
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    // A failed poll is already visible as the panel's own inline error row; it must
    // never surface as an unhandled rejection from a timer.
    void Promise.resolve(body(signal)).catch(() => undefined)
  }

  const startPolling = (): void => {
    if (timer !== undefined) return
    poll()
    timer = setInterval(poll, pollMs)
  }

  const stopPolling = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    controller?.abort()
    controller = undefined
  }

  if (source === undefined) {
    meshFeedStore.update(state => ({ ...state, status: 'down' }))
    startPolling()
    return () => {
      stopPolling()
    }
  }

  source.onopen = () => {
    stopPolling()
    meshFeedStore.update(state => ({ ...state, status: 'open' }))
  }
  source.onerror = () => {
    meshFeedStore.update(state => ({ ...state, status: 'down' }))
    startPolling()
  }
  source.onmessage = (message: MessageEvent<unknown>) => {
    const raw = message.data
    const event = typeof raw === 'string' ? decodeMeshEvent(raw) : undefined
    if (event === undefined) return
    recordMeshEvent(event)
    options.onEvent?.(event)
  }

  return () => {
    source.onopen = null
    source.onerror = null
    source.onmessage = null
    stopPolling()
    source.close()
  }
}
