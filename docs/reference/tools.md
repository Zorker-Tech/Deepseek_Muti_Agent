# The operation catalog

Every MutiAgent capability is declared once, in `packages/control-plane/src/operations/register.ts`, and exposed identically on three surfaces: native harness tools, an MCP server (stdio and streamable HTTP), and the authenticated HTTP+SSE gateway (ADR-0011). Nothing else in the project defines a surface.

`mutiagent.methods` is the self-describing entry point: it takes no parameters and returns every method with its authority and JSON Schema. Its output and MCP `tools/list` are both generated from the live catalog — `OperationCatalog.describe()` and `OperationCatalog.tools()` in `packages/control-plane/src/operations/catalog.ts` — so they cannot drift from what dispatch validates.

How the surfaces select from the catalog:

| Surface | Source | Selection |
|---|---|---|
| `mutiagent.methods` | `describe()` | All 38 operations, including `exposeAsTool: false` ones, each with `id`, `summary`, `scope`, `danger`, `exposeAsTool` and `inputSchema`. |
| MCP `tools/list` and `tools/call` | `tools()` | The 26 operations with `exposeAsTool: true`, named `mutiagent_<id with dots as underscores>`. |
| Native harness tools | `buildTools()` in `packages/control-plane/src/tools.ts` | The same 26, registered on `ctx.tools`, named identically. |
| HTTP `POST /api/mutiagent/rpc` | `invoke()` | Any declared operation, addressed by id. |

## Catalog and discovery

| Method | Scope | Danger | Tool | Parameters | Returns |
|---|---|---|---|---|---|
| `mutiagent.methods` | read | safe | no | none | `{ schemaVersion, wireVersion, pluginVersion, methods: [{ id, summary, scope, danger, exposeAsTool, inputSchema }] }` |
| `agents.diagnostics` | read | safe | yes | none | A diagnostics report: `{ schemaVersion, wireVersion, pluginVersion, stateDir, isolation: 'worktree' \| 'shared-disabled', harness: { services: string[], missing: { service, disables }[] }, agents: [{ agentId, displayName, installed, version?, binaryPath?, reason?, transports: [{ mode, mechanism, available }] }], warnings }` |
| `agents.list` | read | safe | yes | none | `{ agents: AgentDescriptor[] }` |

`agents.diagnostics` also carries the registry's capability warnings (`registry.inspectCapabilities()`) in `warnings`, which is where a malformed capability declaration would surface.

## Sessions

`sessions.list` and `sessions.partitions` share `SessionListParamsSchema`. Its `partitions` boolean is declared in the schema and read by neither handler — `sessions.partitions` is the operation that returns partitions. A caller that sets it on `sessions.list` gets the flat list; the flag is accepted and ignored.

| Method | Scope | Danger | Tool | Parameters | Returns |
|---|---|---|---|---|---|
| `sessions.list` | read | safe | yes | `agentIds?: string[]`, `cwd?: string`, `repoRoot?: string`, `query?: string`, `includeUntracked?: boolean`, `sort?: 'updated' \| 'created' \| 'title'`, `limit?: int 1..1000`, `partitions?: boolean` (ignored) | `{ sessions: AgentSession[] }` |
| `sessions.partitions` | read | safe | no | the same schema | `{ partitions: AgentSessionPartition[], summary }` — one partition per agent, plus the session index's freshness summary |
| `sessions.refresh` | read | safe | yes | `agentIds?: string[]` (omitted scans every registered agent) | `{ outcomes: [{ agentId, ok, found, error? }] }` |
| `sessions.transcript` | read | safe | yes | `key: SessionKey` (required), `maxMessages?: int 1..2000` | `AgentTranscript`: `{ key, messages, totalMessages?, hasMore, notes }` |
| `sessions.native_tasks` | read | safe | yes | `key: SessionKey` (required) | `{ todos, plan?, notes, available }`; `available: false` with empty todos when the agent has no native task model |
| `sessions.import` | mutate | safe | yes | `keys: SessionKey[]` (required, at least one), `actor?: string` (recorded in the audit journal) | `{ tracked: string[], alreadyTracked: string[] }` |
| `sessions.untrack` | mutate | safe | no | `keys: SessionKey[]` (required, at least one) | `{ untracked: string[] }` |

Import is a link, not a copy: it records the session key in MutiAgent's own index and touches no native file (ADR-0012). Untrack removes it from the sidebar without touching its files.

## Runs

| Method | Scope | Danger | Tool | Parameters | Returns |
|---|---|---|---|---|---|
| `runs.start` | mutate | safe | yes | `agentId: string` (required), `prompt: string` (required), `cwd?`, `collaborationId?`, `isolation?: 'worktree' \| 'shared-cwd'`, `resumeNativeId?`, `model?`, `sandbox?`, `approval?`, `timeoutMs?: int >= 1`, `env?: Record<string, string>`, `requestedBy?` | `{ run: RunRecord }` (the record as it stands at dispatch; the run continues) |
| `runs.cancel` | dangerous | needs-confirm | yes | `runId: string` (required), `reason?: string` | `{ cancelled: boolean, run?: RunRecord }` |
| `runs.wait` | read | safe | yes | `runId: string` (required), `waitMs?: int 1000..3600000` (default 600000) | The run's `RunRecord` once it is terminal, or the latest record when the wait budget expires |
| `runs.list` | read | safe | yes | `limit?: int 1..500` (default 50) | `{ runs: RunRecord[] }`, newest first, live runs included |
| `runs.get` | read | safe | no | `runId: string` (required) | `RunRecord`; `mesh/task-not-found` when no such run exists |
| `runs.interrupt` | dangerous | needs-confirm | no | `runId: string` (required) | `{ cancelled: boolean }`; `run/not-running` when the agent's `interrupt` capability is not true |

`runs.wait` and `runs.get` throw `mesh/task-not-found` for an unknown run id, which is the same code a missing mesh task uses. `runs.cancel` stops the process group; it is not a resume-able pause.

## Worktrees

| Method | Scope | Danger | Tool | Parameters | Returns |
|---|---|---|---|---|---|
| `worktrees.create` | mutate | safe | yes | `agentId: string` (required), `repoRoot: string` (required), `baseRef?`, `label?`, `collaborationId?`, `reuse?: boolean` | `{ worktree: MeshWorkspace }` |
| `worktrees.list` | read | safe | yes | `repoRoot?: string` (filter) | `{ worktrees: MeshWorkspace[] }` with each latest progress sample |
| `worktrees.conflicts` | read | safe | yes | `repoRoot: string` (required) | `ConflictReport`; `worktree/git-unavailable` when isolation is disabled |
| `worktrees.remove` | dangerous | irreversible | yes | `worktreeId: string` (required), `force?: boolean` (discard uncommitted and unmerged work) | `{ worktree: MeshWorkspace }`; a forced removal appends a `worktree.removed-forced` entry to the audit journal first |
| `worktrees.mark_integrated` | mutate | safe | no | `worktreeId: string` (required), `merged?: boolean` (default true; `false` marks it outstanding again) | `{ worktree: MeshWorkspace }` |

## Collaborations, todos and plan

| Method | Scope | Danger | Tool | Parameters | Returns |
|---|---|---|---|---|---|
| `collaborations.start` | mutate | safe | yes | `title: string` (required), `objective: string` (required), `repoRoot?`, `tasks?: [{ title, instruction, assignee } (required), dependsOn?: string[], isolation?: 'worktree' \| 'shared-cwd' }]` | `{ collaboration: Collaboration }` |
| `collaborations.list` | read | safe | yes | none | `{ collaborations: Collaboration[] }` |
| `collaborations.get` | read | safe | no | `collaborationId: string` (required) | `Collaboration` |
| `todos.set` | mutate | safe | yes | `collaborationId: string` (required), `todos: AgentTodo[]` (required; each item needs `id`, `content`, `status`, `owner`, `updatedAt`, and may carry `blockedBy`, `observedIn`, `nativeKey`), `expectedRevision?: int >= 0` | `{ todos: SharedTodoDoc }`; a stale `expectedRevision` is rejected rather than clobbering the board |
| `todos.get` | read | safe | yes | `collaborationId: string` (required) | `SharedTodoDoc` |
| `todos.observe` | mutate | safe | no | `collaborationId: string`, `agentId: string`, `sessionKey: SessionKey` (all required) | `{ todos: SharedTodoDoc, observed: number }` — the agent's own state folded in without overwriting authored items |
| `plan.set` | mutate | safe | yes | `collaborationId: string` (required), `objective: string` (required), `phases?: PlanPhase[]`, `activePhaseId?`, `decisions?: string[]`, `mode?: 'inject' \| 'observe'` | `{ plan: AgentPlan }` |
| `plan.get` | read | safe | yes | `collaborationId: string` (required) | `AgentPlan` |
| `plan.advance` | mutate | safe | yes | `collaborationId: string`, `phaseId: string` (both required) | `{ plan: AgentPlan }`; `mesh/invalid-transition` when an earlier phase is not done |
| `plan.context_preview` | read | safe | no | `collaborationId: string`, `agentId: string` (both required) | `{}` when the collaboration has no context for that agent, else `{ context: string, hash: string }` — exactly what a delegated run would receive |
| `collaborations.dispatch_task` | mutate | safe | yes | `collaborationId: string`, `taskId: string` (both required), `wait?: boolean` | `{ run: RunRecord, task }`; `mesh/task-not-found` for an unknown task, `mesh/invalid-transition` when the task is already running or succeeded, or is blocked by an unfinished dependency |

## Credentials

| Method | Scope | Danger | Tool | Parameters | Returns |
|---|---|---|---|---|---|
| `credentials.list` | read | safe | yes | none | `{ credentials: CredentialRow[] }`, where a row is `{ agentId, displayName, installed, state: AgentAuthState, manageable, unmanageableReason?, flows: CredentialFlow[], canLogout }` |
| `credentials.status` | read | safe | yes | `agentId: string` (required) | `{ credentials: CredentialRow[] }` filtered to that agent |
| `credentials.login` | mutate | safe | no | `agentId: string`, `flow: 'oauth-loopback' \| 'device-code' \| 'api-key' \| 'interactive'` (both required), `secret?: string` (an API key, sent on stdin and never persisted) | `{ result: AuthOperationResult }` |
| `credentials.logout` | dangerous | needs-confirm | yes | `agentId: string` (required) | `{ result: AuthOperationResult }` |

A row is `manageable: false` with a `unmanageableReason` when the credential comes from the environment, from the OS keyring, or from an agent that is not installed; `canLogout` is false for an environment credential. MutiAgent stores no credential of its own (ADR-0010).

## Native UI and MCP

| Method | Scope | Danger | Tool | Parameters | Returns |
|---|---|---|---|---|---|
| `agents.launch_command` | read | safe | no | `agentId: string` (required), `nativeSessionId?: string` | `{ argv: string[], note }` — the command that opens the agent's own interactive UI, optionally resuming a session |
| `mcp.config` | read | safe | no | none | `{ stdio: { command, args, env }, http?: { url, headers? }, forAgents: [{ agentId, location, snippet }] }` — ready-to-paste MCP client configuration, using each agent's own config format |

Neither of these drives a TUI: MutiAgent launches an agent's own interface, it does not parse one (ADR-0003). `mcp.config` publishes the configuration; wiring another agent to MutiAgent's MCP server stays the user's explicit act.

## How to call one

HTTP, on the harness's authenticated `/api` channel (the harness applies its browser-trust fence before the request reaches MutiAgent), body limit 4 MiB by default:

```
POST /api/mutiagent/rpc
{ "method": "sessions.list", "params": { "limit": 20 }, "confirm": false }
```

The reply is always HTTP 200 for an answered request, success or domain failure:

```
{ "ok": true,  "schemaVersion": 1, "wireVersion": 1, "result": { "sessions": [] } }
{ "ok": false, "schemaVersion": 1, "wireVersion": 1, "error": { "code": "wire/bad-params", "message": "…", "retryable": false } }
```

Only a malformed envelope (unparsable JSON, oversized body) answers non-200, so a client distinguishes transport health from operation outcome by the envelope alone. `GET /api/mutiagent/events` is the SSE stream of `MeshEvent`s, `POST /api/mutiagent/mcp` is MCP over streamable HTTP.

MCP, after `initialize` (`tools/list` and `tools/call` are refused before it):

```
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"mutiagent_sessions_list","arguments":{"limit":20}}}
```

A tool result is `{ "content": [{ "type": "text", "text": "…" }], "structuredContent": …, "isError": false }`. A tool failure is still a successful JSON-RPC call with `isError: true` and a text block carrying `code: message` plus the remediation line; a protocol error is a JSON-RPC `error` object instead. The supported protocol versions are `2025-06-18`, `2025-03-26` and `2024-11-05`; an unknown requested version negotiates down to `2025-06-18`.

Native harness tool: the same operation under the name `mutiagent_<operation>` with dots as underscores, for example `mutiagent_runs_start` for `runs.start`. The tool's `parameters` are the operation's own JSON Schema. A failed operation is thrown so the harness reports a failed tool call, which is what lets a model correct itself; a confirmation challenge is returned as a normal result, because it is information the model needs.

Slash commands map onto operations as well: `/agents` → `credentials.list`, `/agent-sessions` → `sessions.partitions`, `/agent-refresh` → `sessions.refresh`, `/agents-diagnostics` → `agents.diagnostics`, `/mesh-runs` → `runs.list`, `/mesh-state` → the state directory and isolation mode.

## Confirmation

`confirm` is an envelope-level flag, not a parameter. `Dispatcher.invoke` merges a separately transported flag into `params` (`mergeConfirm` in `packages/control-plane/src/dispatch.ts`), and `OperationCatalog.invoke` strips it again before the operation's own schema validates the rest (`confirmStripped`), so an operation can never treat it as data. The catalog declares `ConfirmField` and then explicitly discards it (`void ConfirmField`) to document that it belongs to the envelope.

The gate is decided by `canInvoke`: a `read` operation and a `danger: 'safe'` operation are always allowed; anything else needs a trusted caller or an explicit `confirm: true`. The asymmetry is deliberate (ADR-0011): a trusted actor is the GUI, the harness's own agent, a tool call or a slash command — a caller for which the harness has already proven the user owns this process, and the GUI confirms before every irreversible action in its own dialog. An untrusted actor is an external MCP client, so it gets the gate rather than a weaker one:

| Caller | `danger: 'needs-confirm'` or `'irreversible'`, no `confirm` |
|---|---|
| Trusted (`trustedActor`, `browserActor`) | Performed. |
| Untrusted (`mcpActor`) | Not performed; the challenge below is returned as the result. |
| Any caller with `confirm: true` | Performed, because the caller asserted a human approved it. |

A challenged call returns this object in place of a result (the exact fields `challengeFor` produces):

```json
{
  "confirmationRequired": true,
  "operation": "worktrees.remove",
  "prompt": "Remove a worktree MutiAgent owns. Unmerged work requires force. This cannot be undone automatically.",
  "howToConfirm": "Repeat with {\"confirm\": true} after a human has approved worktrees.remove."
}
```

A client recognizes it with `isChallenge(result)` — the `confirmationRequired: true` field discriminates it from an operation's own result. The type allows an `effects` array; `challengeFor` never sets one. `OperationCatalog.invoke` also contains a branch that would throw `ErrorCodes.meshConfirmationRequired` with the message `<id> needs explicit confirmation`, but that branch is unreachable under the current `canInvoke` logic — reaching it requires `actor.trusted || confirmed`, which `canInvoke` has already accepted — so in practice an untrusted caller always receives the challenge and never that error code.

## Error codes

`ErrorCodes` in `packages/contracts/src/errors.ts` is the one table of codes; `MutiAgentError` carries `code`, `message`, `remediation?`, `details?` and `retryable`. Grouped by namespace, with the next step each code carries where a throw site sets one:

| Code | Raised when | Remediation carried |
|---|---|---|
| `detection/not-found` | The binary was never resolved, at the point a run or login needs it. | Install the agent, or set its binary path in the adapter's settings. |
| `detection/probe-failed` | Declared; nothing raises it in the current tree. | — |
| `detection/home-unresolved` | Declared; nothing raises it in the current tree. | — |
| `auth/not-configured` | Pi's stderr shows no usable credential; Grok's output shows an unauthenticated refusal. | Authenticate the agent (`/login` for Pi, `grok login` for Grok), or set the provider key for that agent. |
| `auth/expired` | Declared; expiry is reported through `AgentAuthState` instead. | — |
| `auth/store-unreadable` | Declared; an unreadable store is reported as `status: 'misconfigured'`. | — |
| `auth/login-unsupported` | A login flow outside the adapter's declared `credentials.login` set. | Use one of the declared flows, or "open native login" for anything else. |
| `auth/login-failed` | The `api-key` flow was requested without a secret. | Provide the key in the form; it is passed on stdin. |
| `auth/logout-failed` | Declared; a failed logout is returned as `ok: false` with output instead. | — |
| `auth/human-step-required` | Declared; a flow needing a human is returned as an `interaction` instead. | — |
| `session/not-found` | No native record matches the session id. | Refresh the session list; the record may have been archived, moved or deleted, and Pi asks for the session's own project directory. |
| `session/unreadable` | The record exists but cannot be read — for Codex, a zstd-compressed rollout. | Open the session in its own agent, which materialises a readable record, then read it again. |
| `session/root-missing` | Declared; an absent root yields an empty list instead. | — |
| `session/read-cap-exceeded` | Declared; a read cap yields a partial window plus a note instead. | — |
| `run/start-failed` | The process could not be started at all (a spawn failure reported as no exit status). | Check the binary exists and is executable, and that the working directory exists. |
| `run/agent-crashed` | A non-zero exit or a fatal stop reason with no more specific evidence. | Read the captured stderr tail; reproduce the run once by hand. |
| `run/cancelled` | `cancel()` was called, or the agent reported its own abort. | Nothing to do; re-dispatch when the work should continue. |
| `run/timeout` | The wall-clock budget elapsed and the process group was killed. | Raise the agent timeout in settings, or split the task into smaller runs. |
| `run/rate-limited` | Rate-limit or quota evidence in the agent's output. | Wait for the limit to reset, then dispatch again. |
| `run/policy-blocked` | Policy or sandbox refusal — including Grok refusing to resume a session under a different sandbox profile. | Reword the task, or run it where the sandbox and approvals allow it; for Grok, omit the sandbox override or start a new session. |
| `run/protocol-error` | A run's event stream ended without its terminal event, or the adapter failed while projecting the native stream. | Re-dispatch; if it repeats, capture the agent's stdout stream for diagnosis. |
| `run/not-running` | `runs.interrupt` was called for an agent whose `interrupt` capability is not true. | Cancel the run instead, or wait for the turn to finish. |
| `run/context-unavailable` | Pi cannot continue a session in the requested directory non-interactively, or exited without starting a session. | Dispatch the resume with the session's own cwd, or start a new session there. |
| `worktree/not-a-repository` | Isolation was requested for a path that is not inside a git work tree. | Initialize a repository, or run with `isolation=shared-cwd`. |
| `worktree/create-failed` | A worktree could not be created, e.g. no base commit resolves. | Make at least one commit, then retry. |
| `worktree/not-found` | No tracked worktree has that id. | List worktrees to find a valid id. |
| `worktree/dirty` | Removal was requested for a worktree with uncommitted changes without `force`. | Commit or stash the work, or pass `force` to discard it. |
| `worktree/unmerged` | Removal was requested for a worktree with unmerged commits without `force`. | Merge the branch, or pass `force` to discard the work. |
| `worktree/orphan` | Declared; a worktree present on disk but absent from state is reported as `state: 'orphan'` instead of being adopted. | — |
| `worktree/git-unavailable` | Worktree isolation is disabled, or git is unusable where it is needed. | Enable worktree isolation in settings, or dispatch with `isolation=shared-cwd`. |
| `schema/invalid` | A value outside a declared set, e.g. an undeclared sandbox profile or approval mode. | Use one of the declared values, which the message names. |
| `schema/version-unsupported` | Declared; the envelope advertises its versions instead of failing. | — |
| `schema/todo-conflict` | A write would clobber another actor's todo mutation. | Re-read the board, re-apply the change, then write again. |
| `harness/tools-unavailable` | Declared; an absent tool seam is diagnosed and the surface is skipped. | — |
| `harness/route-unavailable` | Declared; an absent route seam is diagnosed and the surface is skipped. | — |
| `harness/service-missing` | An agent id has no registered adapter, or the stdio MCP server has no state directory. | Check the agent is installed and enabled in plugin settings; for the MCP server, add `MUTI_AGENT_STATE_DIR`. |
| `harness/unclassified` | Any thrown value that is not a `MutiAgentError`, converted by `toErrorShape`. | — |
| `mesh/collaboration-not-found` | No collaboration has that id. | List collaborations to find a valid id, or start one first. |
| `mesh/task-not-found` | No task or run has that id. | List the collaboration's tasks, or `runs.list`, to find a valid id. |
| `mesh/confirmation-required` | Declared for the confirmation gate; unreachable through `OperationCatalog.invoke` under the current `canInvoke` logic (see "Confirmation"). | — |
| `mesh/invalid-transition` | A task is already running or succeeded, blocked by an unfinished dependency, or a plan phase is advanced out of order. | Mark the earlier phases or dependencies done first, or reorder the plan. |
| `wire/bad-envelope` | The request has no `method`, is not valid JSON, or exceeds the body limit. | Send `{"method":"mutiagent.methods"}` to discover methods; send a smaller request. |
| `wire/unknown-method` | No operation has that id. | Call `mutiagent.methods` to list the available methods. |
| `wire/unauthorized` | Declared; the harness's own fence refuses an unauthenticated request before it reaches MutiAgent. | — |
| `wire/bad-params` | The parameters failed the operation's schema. | Call `mutiagent.methods` for that method's schema; the message names every offending path. |

## Adding an operation

A new operation is a `MeshOperation` object pushed into `buildOperations` in `packages/control-plane/src/operations/register.ts`, and it declares exactly seven fields:

1. **`id`** — dotted lower snake case, matching `METHOD_PATTERN` (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`). It is a stable public surface: it appears in every surface, in recorded run context and in user scripts. `OperationCatalog.register` throws at load for a violation, and for a duplicate id, because both are programming errors that must fail loudly rather than shadow a capability.
2. **`summary`** — one line describing what it does, shown in tool listings and in MCP tool descriptions.
3. **`params`** — a `Schema` from `@zorker/muti-agent-contracts`, consumed three ways: validation on every surface, the MCP `inputSchema`, and the native tool's `parameters`. The catalog comment also names the GUI's types as a consumer; the bundled client currently declares its own parameter interfaces in `packages/plugin/src/client/api.ts` instead. Use `NoParams` for an operation that takes none.
4. **`scope`** — `read`, `mutate` or `dangerous`.
5. **`danger`** — `safe`, `needs-confirm` or `irreversible`; this is what the confirmation gate reads.
6. **`exposeAsTool`** — whether the operation becomes a model-facing tool. A `dangerous` operation can be exposed as a tool and still be gated; a `read` operation can be withheld from models while remaining callable over HTTP.
7. **`run(context, params)`** — the handler. It is reached only with validated parameters and only after dispatch has satisfied the confirmation requirement, so it never re-checks either.

What happens automatically once it is registered:

- It appears in `mutiagent.methods` with its JSON Schema and authority, and in MCP `tools/list` if it is exposed.
- It is registered as a native harness tool named `mutiagent_<id with dots as underscores>`, with the operation's schema as its `parameters`, a `presentCall` card, and a 24-hour cooperative timeout for a non-read operation.
- Parameters are validated on every surface with the same schema, and a failure is `wire/bad-params` naming each offending path.
- The confirmation gate applies on all three surfaces identically.
- MCP annotations are derived: `readOnlyHint` for `scope: 'read'`, `destructiveHint` for `danger: 'irreversible'`, `openWorldHint` for anything that mutates.
- A failure becomes a thrown `ToolCallFailure` on the native surface, `isError: true` on MCP, and a failure envelope over HTTP — one code, three presentations.
- `scripts/verify-plugin.mjs` loads the built bundle against a stub context and exercises the HTTP, MCP and tool surfaces, which is what catches an id-pattern or registration failure before a profile boots.
