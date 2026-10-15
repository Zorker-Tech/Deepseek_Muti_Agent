/**
 * Branded identifier types. Every opaque cross-boundary id is branded so a native
 * id can never be passed where a canonical id is expected, and vice versa.
 *
 * @module @zorker/muti-agent-contracts/ids
 */

declare const brand: unique symbol

/**
 * A nominal wrapper around a primitive identity.
 *
 * @typeParam B - Discriminant label distinguishing brands of the same primitive.
 * @typeParam T - Underlying primitive representation.
 */
export type Branded<B extends string, T extends string = string> = T & {
  readonly [brand]: B
}

/** Stable identifier of an integrated agent kind, e.g. `codex`, `grok`, `pi`. */
export type AgentId = Branded<'AgentId'>

/** An agent's own session identifier, verbatim from its store or CLI. */
export type NativeSessionId = Branded<'NativeSessionId'>

/** MutiAgent's canonical session identifier: `<agentId>:<nativeId>`. */
export type SessionKey = Branded<'SessionKey'>

/** Identifier of one delegated run. */
export type RunId = Branded<'RunId'>

/** Identifier of a collaboration (a group of runs sharing todos and a plan). */
export type CollaborationId = Branded<'CollaborationId'>

/** Identifier of a tracked git worktree owned by MutiAgent. */
export type WorktreeId = Branded<'WorktreeId'>

/** Canonical todo item identifier, unique within a collaboration. */
export type TodoId = Branded<'TodoId'>

/** Identifier of one mutiagent operation from the tool catalog. */
export type OperationId = Branded<'OperationId'>

/**
 * Cast a primitive into a branded id.
 *
 * @param value - The raw identifier as read from a foreign store or the wire.
 * @returns The same value, branded.
 */
export function brandId<B extends string>(value: string): Branded<B> {
  return value as Branded<B>
}

/** Cast an agent id. */
export function agentId(value: string): AgentId {
  return value as AgentId
}

/** Cast a native session id. */
export function nativeSessionId(value: string): NativeSessionId {
  return value as NativeSessionId
}

/** Cast a run id. */
export function runId(value: string): RunId {
  return value as RunId
}

/** Cast a collaboration id. */
export function collaborationId(value: string): CollaborationId {
  return value as CollaborationId
}

/** Cast a worktree id. */
export function worktreeId(value: string): WorktreeId {
  return value as WorktreeId
}

/** Cast a todo id. */
export function todoId(value: string): TodoId {
  return value as TodoId
}

/** Cast an operation id. */
export function operationId(value: string): OperationId {
  return value as OperationId
}

/** The canonical session key for one agent's native session. */
export function sessionKey(agent: AgentId, native: NativeSessionId): SessionKey {
  return `${String(agent)}:${String(native)}` as SessionKey
}

/** Split a canonical session key back into its two parts, or `undefined` when malformed. */
export function splitSessionKey(key: SessionKey): { agentId: AgentId; nativeId: NativeSessionId } | undefined {
  const at = String(key).indexOf(':')
  if (at <= 0 || at === String(key).length - 1) return undefined
  return {
    agentId: agentId(String(key).slice(0, at)),
    nativeId: nativeSessionId(String(key).slice(at + 1)),
  }
}
