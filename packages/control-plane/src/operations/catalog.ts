/**
 * The operation catalog: every MutiAgent capability is declared once here and then
 * exposed identically as a native harness tool, an MCP tool and an HTTP method
 * (ADR-0011). Nothing else in the project defines a surface.
 *
 * Declaration rules:
 *
 * - `id` is dotted lower snake case and is a **stable contract**: it appears in
 *   every surface, in recorded run context and in user scripts.
 * - `scope` says whether the operation reads or changes state; `danger` says whether
 *   it needs explicit confirmation and whether it can be undone. A dangerous
 *   operation returns a confirmation object instead of acting unless the caller
 *   passed `confirm: true`, on **all three** surfaces.
 * - `params` is the schema used for validation, for the MCP `inputSchema`, and for
 *   the GUI's TypeScript types. One declaration, three consumers.
 *
 * @module @zorker/muti-agent-control-plane/operations/catalog
 */

import {
  ErrorCodes,
  MutiAgentError,
  AgentIdSchema,
  JsonObjectSchema,
  PlanSetParamsSchema,
  RunStartParamsSchema,
  SessionListParamsSchema,
  TodosSetParamsSchema,
  WorktreeCreateParamsSchema,
  isMethodName,
  s,
  type JsonSchema,
  type Schema,
} from '@zorker/muti-agent-contracts'

/** How much authority an operation requires. */
export type OperationScope = 'read' | 'mutate' | 'dangerous'

/** Whether an operation can be undone. */
export type OperationDanger = 'safe' | 'needs-confirm' | 'irreversible'

/** Who is calling, for the audit journal and for messages. */
export interface OperationActor {
  /** Stable identifier: `gui`, `harness-agent`, `mcp:<client>`, `http`, `user`. */
  id: string
  /** Human label when known. */
  label?: string
  /** Whether this caller may run `mutate`/`dangerous` operations without confirmation. */
  trusted: boolean
}

/** Runtime context handed to an operation. */
export interface OperationContext {
  /** The assembled domain layer. */
  service: import('@zorker/muti-agent-core').MutiAgentService
  /** Who is calling. */
  actor: OperationActor
  /** Cancellation for the whole request. */
  signal?: AbortSignal
}

/**
 * One declared capability.
 *
 * @typeParam P - The validated parameter type.
 * @typeParam R - The result type.
 */
export interface MeshOperation<P = unknown, R = unknown> {
  /** Stable dotted id, e.g. `sessions.list`. */
  id: string
  /** One line describing what it does, shown in tool listings. */
  summary: string
  /** Parameter schema; validated before `run` is called on every surface. */
  params: Schema<P>
  /** Authority required. */
  scope: OperationScope
  /** Reversibility and confirmation requirement. */
  danger: OperationDanger
  /** Whether this operation is exposed as a model-facing tool. */
  exposeAsTool: boolean
  /**
   * Perform the operation. Reached only with validated parameters, and only after
   * the dispatch layer has satisfied the confirmation requirement.
   *
   * @param context - Services, caller identity and cancellation.
   * @param params - Validated parameters.
   */
  run(context: OperationContext, params: P): Promise<R>
}

/** A confirmation challenge, returned instead of acting. */
export interface ConfirmationChallenge {
  /** Always `true`; discriminates this result from an operation's own result. */
  confirmationRequired: true
  /** Operation that was not performed. */
  operation: string
  /** What the caller must confirm, phrased for the human who will approve it. */
  prompt: string
  /** How to proceed. */
  howToConfirm: string
  /** What would change, when the operation can describe it. */
  effects?: readonly string[]
}

/** Registry of declared operations. */
export class OperationCatalog {
  private readonly operations = new Map<string, MeshOperation<never, unknown>>()

  /**
   * Register one operation.
   *
   * @param operation - The declaration.
   * @throws {Error} on an invalid or duplicate id, which is a programming error and
   *   must fail at load rather than produce a silently shadowed capability.
   */
  register<P, R>(operation: MeshOperation<P, R>): void {
    if (!isMethodName(operation.id)) {
      throw new Error(`muti-agent: operation id "${operation.id}" is not a dotted lower snake case name`)
    }
    if (this.operations.has(operation.id)) {
      throw new Error(`muti-agent: operation "${operation.id}" is already registered`)
    }
    this.operations.set(operation.id, operation as unknown as MeshOperation<never, unknown>)
  }

  /** Whether an id is registered. */
  has(id: string): boolean {
    return this.operations.has(id)
  }

  /** One operation, if registered. */
  get(id: string): MeshOperation<never, unknown> | undefined {
    return this.operations.get(id)
  }

  /** Every operation, sorted by id. */
  list(): readonly MeshOperation<never, unknown>[] {
    return [...this.operations.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Operations exposed as model-facing tools. */
  tools(): readonly MeshOperation<never, unknown>[] {
    return this.list().filter(operation => operation.exposeAsTool)
  }

  /**
   * The catalog as data, for `mutiagent.methods`, MCP `tools/list` and the panel's
   * diagnostics view.
   *
   * @returns One row per operation with its JSON Schema and authority metadata.
   */
  describe(): readonly {
    id: string
    summary: string
    scope: OperationScope
    danger: OperationDanger
    exposeAsTool: boolean
    inputSchema: JsonSchema
  }[] {
    return this.list().map(operation => ({
      id: operation.id,
      summary: operation.summary,
      scope: operation.scope,
      danger: operation.danger,
      exposeAsTool: operation.exposeAsTool,
      inputSchema: operation.params.toJsonSchema(),
    }))
  }

  /**
   * Invoke an operation.
   *
   * @param id - Operation id.
   * @param rawParams - Untrusted parameters from a wire or model boundary.
   * @param context - Services and caller identity.
   * @returns The operation's result, or a confirmation challenge when the caller
   *   must confirm first.
   * @throws {MutiAgentError} `wire/unknown-method` for an unknown id, `wire/bad-params`
   *   for invalid parameters.
   */
  async invoke(id: string, rawParams: unknown, context: OperationContext): Promise<unknown> {
    const operation = this.operations.get(id)
    if (operation === undefined) {
      throw new MutiAgentError(ErrorCodes.wireUnknownMethod, `no mutiagent method "${id}"`, {
        details: { method: id },
        remediation: 'Call mutiagent.methods to list the available methods.',
      })
    }
    const parsed = operation.params.safeParse(confirmStripped(rawParams))
    if (!parsed.ok) {
      const issues = parsed.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      }))
      throw new MutiAgentError(
        ErrorCodes.wireBadParams,
        `invalid parameters for ${id}: ${issues.map(i => `${i.path} ${i.message}`).join('; ')}`,
        {
          details: { method: id, issueCount: issues.length },
          remediation: 'Call mutiagent.methods for this method\'s schema.',
        },
      )
    }
    // An untrusted caller without confirmation gets the challenge; a trusted caller, or
    // one that asserted `confirm: true`, proceeds. There is no third outcome, so there is
    // no error path here to keep in sync with the gate.
    if (!canInvoke(operation, context.actor, isConfirmed(rawParams))) {
      return challengeFor(operation)
    }
    return operation.run(context, parsed.value as never)
  }
}

/**
 * Whether the caller asserted human approval for this call.
 *
 * `confirm` is deliberately **not** part of any operation's own parameter schema: it
 * is an envelope-level flag checked by the dispatcher, so a surface cannot forget to
 * forward it and an operation cannot accidentally treat it as data.
 */
function isConfirmed(rawParams: unknown): boolean {
  return (
    typeof rawParams === 'object' &&
    rawParams !== null &&
    (rawParams as { confirm?: unknown }).confirm === true
  )
}

/** Drop the envelope-level `confirm` flag so an operation's own schema stays closed. */
function confirmStripped(rawParams: unknown): unknown {
  if (typeof rawParams !== 'object' || rawParams === null) return rawParams ?? {}
  const { confirm: _confirm, ...rest } = rawParams as Record<string, unknown>
  return rest
}

/**
 * Whether a caller may perform an operation now.
 *
 * A `read` operation and a `safe` mutation are always allowed. A `dangerous` or
 * non-`safe`-danger operation needs a trusted caller or an explicit `confirm: true`.
 */
function canInvoke(
  operation: MeshOperation<never, unknown>,
  actor: OperationActor,
  confirmed: boolean,
): boolean {
  if (operation.scope === 'read') return true
  if (operation.danger === 'safe') return true
  return actor.trusted || confirmed
}

function challengeFor(operation: MeshOperation<never, unknown>): ConfirmationChallenge {
  return {
    confirmationRequired: true,
    operation: operation.id,
    prompt: `${operation.summary} This cannot be undone automatically.`,
    howToConfirm: `Repeat with {"confirm": true} after a human has approved ${operation.id}.`,
  }
}

/** The `confirm` parameter every mutating operation accepts. */
export const ConfirmField: Schema<boolean | undefined> = s.boolean().describeAs(
  'Required for an operation that needs confirmation; must be true after a human approved it.',
)

/** Empty parameter schema for operations that take nothing. */
export const NoParams: Schema<Record<string, never>> = s.object({}).describeAs('This method takes no parameters.')

/** A branded agent id parameter. */
export const AgentParam: Schema<string> = AgentIdSchema.describeAs('Canonical agent id, e.g. `codex`.')

/** A session key parameter. */
export const SessionKeyParam: Schema<string> = s
  .string()
  .min(3)
  .describeAs('Canonical session key, `<agentId>:<nativeId>`, as returned by `sessions.list`.')

/** A collaboration id parameter. */
export const CollaborationParam: Schema<string> = s.string().min(1).describeAs('Collaboration id.')

/** A worktree id parameter. */
export const WorktreeParam: Schema<string> = s.string().min(1).describeAs('Worktree id.')

/** A run id parameter. */
export const RunParam: Schema<string> = s.string().min(1).describeAs('Run id.')

/** Re-export the parameter schemas the plugin's settings and the surfaces share. */
export {
  JsonObjectSchema,
  PlanSetParamsSchema,
  RunStartParamsSchema,
  SessionListParamsSchema,
  TodosSetParamsSchema,
  WorktreeCreateParamsSchema,
}
