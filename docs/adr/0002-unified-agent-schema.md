# ADR-0002 — A canonical agent schema with lossy, declared projections

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

The three target agents store and speak entirely different models:

| Concern | Codex | Grok Build | Pi |
|---|---|---|---|
| Session store | `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` | `$GROK_HOME/sessions/<encoded-cwd>/<id>/summary.json` + `updates.jsonl` | `<agent-dir>/sessions/--<flattened-cwd>--/<ts>_<id>.jsonl` |
| Record model | append-only `RolloutItem` union (internally tagged `type`) | `Summary` metadata + ACP `session/update` stream | header + tree entries (`id`/`parentId`), 11 entry kinds |
| Titles | `session_index.jsonl` append-only index | `summary.session_summary` / `generated_title` / manual | latest `session_info` entry |
| Todos | `TurnItem::Plan` / `turn/plan/updated` | `plan.json` (`IndexMap<TodoId, TodoItem>`) | not built in (`todo_write` in extensions) |
| Auth store | `$CODEX_HOME/auth.json` | `$GROK_HOME/auth.json` (scope map) | `<agent-dir>/auth.json` (`Record<providerId, Credential>`) |
| Control protocol | `app-server` JSON-RPC v2 / `exec --json` JSONL | ACP JSON-RPC (stdio, WS, leader socket) | `--mode rpc` JSONL |
| Sandbox / approval | `sandbox_mode` × `approval_policy` | `--sandbox <profile>` × `permission_mode` | none (project trust only) |
| Worktree | `--worktree` (fork-specific) | `-w/--worktree` + `x.ai/git/worktree/*` | none |

The GUI, the orchestration engine, the MCP surface and the credential screens must all
work uniformly across these. A per-agent special case in each consumer is not viable.

## Decision

Define **one canonical schema** in `@zorker/muti-agent-contracts`, and require every
adapter to implement `AgentAdapter` mapping native ⇄ canonical through explicit,
documented projections.

Rules:

1. **Canonical types are the only vocabulary above the adapter layer.** Services, tools,
   HTTP routes, MCP tools and UI components never see a native record shape.
2. **Every projection records its losses.** `AgentSession`, `AgentMessage`,
   `AgentTranscript` and `NativeTaskState` carry `notes: ProjectionNote[]`, so a consumer
   can say "Grok Build does not expose per-turn token counts here" instead of silently
   rendering zero. `RunResult` carries the equivalent as `notes: string[]`.
3. **Capabilities are declared, not assumed.** `AgentCapabilities` is a closed record of
   booleans plus enums: `runModes`, `streaming`, `resume`, `interrupt`, `listSessions`,
   `readTranscript`, `nativeTodos`, `nativePlan`, `externalWorktree`, `mcpClient`,
   `listModels`, `sandboxProfiles`, `approvalModes`, `credentials`. Consumers branch on a
   capability, never on `agentId`.
4. **Native identifiers are preserved verbatim** in `native` sub-objects and branded id
   types, so a canonical object can always be traced back and any adapter can act on it.
5. **No LLM in the projection path.** Mapping is deterministic pure TypeScript; nothing
   here calls a model.
6. **Schema is expressed once** as TypeScript types plus Standard-Schema-compatible
   validators, so the same definition validates wire input at the HTTP/MCP boundary and
   documents the GUI contract.

Canonical surface (v1): `AgentDescriptor`, `AgentCapabilities`, `AgentAuthState`,
`AgentSession`, `AgentMessage`, `AgentTodo`, `AgentPlan`, `AgentRunEvent`,
`RunRequest`/`RunHandle`/`RunResult`, `MeshTask`, `MeshWorkspace`, `WorktreeProgress`,
`ConflictReport`, `SharedTodoDoc`, `RunRecord`, `Collaboration`, `ProjectionNote`.

`RunRequest` is the *declared* request shape a caller fills in; the runtime resolves it
through `RunManager.DispatchParams` (which adds orchestrator-owned fields such as
`requestedBy`) and what persists is a `RunRecord`. The distinction exists so an adapter's
`AdapterRunRequest` stays a small, adapter-facing subset.

## Consequences

**Positive**

- One UI, one tool surface, one MCP schema; adding a fourth agent is one package.
- Loss is explicit and reviewable rather than an accidental `undefined`.
- Adapters are independently testable against recorded native fixtures.

**Negative / accepted costs**

- Low-common-denominator risk: features unique to one agent (Grok's ACP extension
  methods, Codex's app-server approvals) must be reachable through an explicit
  `extensions` escape hatch rather than the core type. We accept a narrow
  `adapter.ext(raw)` escape hatch, documented as non-portable.
- The canonical schema becomes a versioned compatibility surface. `SCHEMA_VERSION` is
  bumped with a migration note; the MCP server and the HTTP gateway both advertise it.

## Alternatives considered

- **Union type of the three native models.** Rejected: every consumer would switch on
  agent at every call site, which is exactly the coupling the project exists to remove.
- **Adopt one agent's model as canonical (e.g. ACP).** Rejected: ACP is a *transport*
  protocol, not a session-universe model; Codex's rollout and Pi's tree do not fit it,
  and it would make Grok the de-facto owner of our schema.
- **Per-agent schemas with a thin common core (lowest common denominator only).**
  Rejected as the primary model, because it drops the session/todo/plan data that the
  orchestration and sidebar features actually need; retained only as the "documents"
  projection shape (ADR-0004).
