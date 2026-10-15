/**
 * The dispatcher every surface funnels through. A surface is responsible only for
 * transporting a `{ method, params }` envelope and carrying the result back; identity,
 * validation, confirmation and error shaping all happen here, so the three surfaces
 * cannot drift apart (ADR-0011).
 *
 * @module @zorker/muti-agent-control-plane/dispatch
 */

import {
  ErrorCodes,
  MutiAgentError,
  SCHEMA_VERSION,
  WIRE_VERSION,
  toErrorShape,
  type MutiAgentErrorShape,
} from '@zorker/muti-agent-contracts'
import type { MutiAgentService } from '@zorker/muti-agent-core'
import type { OperationActor, OperationCatalog, ConfirmationChallenge } from './operations/catalog.ts'

/** The request envelope accepted by every surface. */
export interface InvokeRequest {
  /** Operation id, e.g. `sessions.list`. */
  method: string
  /** Operation parameters; the envelope-level `confirm` flag also belongs here. */
  params?: unknown
  /** Asserted human approval for a dangerous operation. */
  confirm?: boolean
}

/** The success envelope. */
export interface InvokeSuccess {
  ok: true
  schemaVersion: number
  wireVersion: number
  /** The operation's result, or a confirmation challenge. */
  result: unknown
}

/** The failure envelope. */
export interface InvokeFailure {
  ok: false
  schemaVersion: number
  wireVersion: number
  error: MutiAgentErrorShape
}

/** Result of one dispatch. */
export type InvokeResult = InvokeSuccess | InvokeFailure

/** How a surface tells the dispatcher who is calling. */
export interface DispatchOptions {
  /** Caller identity. */
  actor: OperationActor
  /** Cancellation for the whole request. */
  signal?: AbortSignal
}

/**
 * Authenticated, validated operation dispatch.
 *
 * Returns a failure envelope rather than throwing, because every surface has to make a
 * decision about how to report a failure and none of them should have to catch a
 * different error type than another.
 */
export class Dispatcher {
  /**
   * @param service - The assembled domain layer.
   * @param catalog - The operation catalog.
   */
  constructor(
    private readonly service: MutiAgentService,
    private readonly catalog: OperationCatalog,
  ) {}

  /** The catalog, for surfaces that list methods. */
  get operations(): OperationCatalog {
    return this.catalog
  }

  /**
   * Invoke one method.
   *
   * @param request - Method, parameters and the confirmation flag.
   * @param options - Caller identity and cancellation.
   * @returns A success envelope (whose `result` may be a confirmation challenge) or a
   *   failure envelope. Never throws for a bad request.
   */
  async invoke(request: InvokeRequest, options: DispatchOptions): Promise<InvokeResult> {
    try {
      if (typeof request.method !== 'string' || request.method.trim() === '') {
        throw new MutiAgentError(ErrorCodes.wireBadEnvelope, 'the request has no method', {
          remediation: 'Send {"method":"mutiagent.methods"} to discover the available methods.',
        })
      }
      // The envelope-level `confirm` is merged into the parameters the catalog sees,
      // so a surface that transports it separately behaves identically to one that
      // puts it in `params`.
      const params = mergeConfirm(request.params, request.confirm)
      const result = await this.catalog.invoke(request.method, params, {
        service: this.service,
        actor: options.actor,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      return {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        wireVersion: WIRE_VERSION,
        result,
      }
    } catch (cause) {
      return {
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        wireVersion: WIRE_VERSION,
        error: toErrorShape(cause),
      }
    }
  }
}

/** Merge a separately transported confirmation flag into the parameter object. */
function mergeConfirm(params: unknown, confirm: boolean | undefined): unknown {
  if (confirm !== true) return params ?? {}
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    return { ...(params as Record<string, unknown>), confirm: true }
  }
  return { confirm: true }
}

/** Whether a result is a confirmation challenge rather than an operation's own result. */
export function isChallenge(result: unknown): result is ConfirmationChallenge {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { confirmationRequired?: unknown }).confirmationRequired === true
  )
}

/**
 * The actor for a locally trusted caller: the harness's own agent, a tool invocation,
 * or the operating user working in the GUI. Such a caller has already passed the
 * harness's own permission gate.
 *
 * @param id - Stable identifier recorded in the audit journal.
 * @param label - Human label, when known.
 */
export function trustedActor(id: string, label?: string): OperationActor {
  return label === undefined ? { id, trusted: true } : { id, label, trusted: true }
}

/**
 * The actor for an external MCP client. Untrusted, so a dangerous operation returns a
 * confirmation challenge unless it passed `confirm: true` explicitly.
 *
 * @param clientName - The client's self-reported name from `initialize`.
 */
export function mcpActor(clientName: string): OperationActor {
  return { id: `mcp:${clientName}`, label: clientName, trusted: false }
}

/**
 * The actor for an authenticated browser session. The harness has already proven the
 * user owns this Host, and the GUI asks before every irreversible action, so it is
 * trusted for confirmation purposes.
 *
 * @param subject - The signed operator id from the browser cookie, when available.
 */
export function browserActor(subject?: string): OperationActor {
  return subject === undefined ? { id: 'gui', trusted: true } : { id: `gui:${subject}`, trusted: true }
}
