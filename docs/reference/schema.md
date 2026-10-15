# The canonical schema

Every agent's sessions, transcripts, todos, plans, runs and credential state are projected onto one set of TypeScript types, declared in `packages/contracts/src/`. Those types are the only vocabulary above the adapter layer: services, tools, HTTP routes, MCP tools and UI components never see a native record (ADR-0002).

Read this file together with the code; where a sentence here and a line of code disagree, the code is what runs. Every claim below was read from `packages/contracts/src/{ids,agent,session,run,mesh,errors,version,capabilities,schemas}.ts`, from `packages/core/src/adapter/types.ts` and from `packages/core/src/orchestration/runs.ts`.

Three notes where the prose in `docs/adr/0002-unified-agent-schema.md` has drifted from the code, and the code is authoritative:

- ADR-0002 rule 2 says `AgentSession` and `AgentMessage` carry `completeness`; the code carries `notes: readonly ProjectionNote[]` instead, and there is no `completeness` field anywhere.
- ADR-0002's v1 surface lists `SharedPlanDoc`; the code's plan document is `AgentPlan`, in `session.ts`, and `SharedTodoDoc` lives in `mesh.ts`.
- ADR-0002 rule 3 lists `headless`, `worktree` and `approvals` as capabilities; the code declares `runModes`, `externalWorktree` and `approvalModes`, plus `resume`, `interrupt`, `listSessions`, `readTranscript`, `listModels` and `credentials`.

## Branded identifiers

`packages/contracts/src/ids.ts` defines `Branded<B, T>`, a nominal wrapper that makes structurally identical strings incompatible. A brand prevents exactly one class of bug: passing an agent's own session id where a canonical session key is expected, or a run id where a worktree id is expected — the compiler rejects it, which no amount of naming discipline achieves with bare `string`.

| Type | Underlying value | What it names |
|---|---|---|
| `AgentId` | string | Stable id of an integrated agent kind, e.g. `codex`, `grok`, `pi`. |
| `NativeSessionId` | string | An agent's own session identifier, verbatim from its store or CLI. |
| `SessionKey` | string | `<agentId>:<nativeId>`; the value every session operation takes. |
| `RunId` | string | One delegated run (`run-<token>` as minted by `RunManager.dispatch`). |
| `CollaborationId` | string | A collaboration: a group of runs sharing todos and one plan. |
| `WorktreeId` | string | A tracked git worktree owned by MutiAgent. |
| `TodoId` | string | A todo item, unique within a collaboration. |
| `OperationId` | string | One operation id from the tool catalog. |

Functions: `brandId<B>()`, `agentId()`, `nativeSessionId()`, `runId()`, `collaborationId()`, `worktreeId()`, `todoId()`, `operationId()` are casts; `sessionKey(agent, native)` builds the canonical key; `splitSessionKey(key)` splits at the first colon and returns `undefined` for a malformed key (empty agent, empty native, or no colon).

## Agent descriptor

### `RunMode` and `CredentialFlow`

| Type | Values | Invariant |
|---|---|---|
| `RunMode` | `headless-exec`, `duplex-protocol` | `AgentCapabilities.runModes` is the set a given adapter implements; v0.1 implements `headless-exec` for all three agents (ADR-0003). |
| `CredentialFlow` | `oauth-loopback`, `device-code`, `api-key`, `interactive` | `interactive` means a human must act in the agent's own TUI; the adapter reports guidance rather than driving one. |

### `AgentCapabilities`

What an adapter supports, declared rather than assumed. A consumer must read these flags instead of branching on `agentId`; an unsupported capability renders as an explanation in the UI, never as a dead control.

| Field | Type | Required | Meaning | When false or absent, a consumer must |
|---|---|---|---|---|
| `runModes` | `readonly RunMode[]` | required | Run modes this adapter implements. | Not offer a dispatch that needs a mode outside the list; v0.1 always contains `headless-exec`. |
| `streaming` | boolean | required | Whether a run emits incremental events before it finishes. | Render the run as a single result when it completes, not as a live stream. |
| `resume` | boolean | required | Whether a previously created native session can be continued. | Not offer "continue this session"; `RunRequest.resumeNativeId` is refused or ignored. |
| `interrupt` | boolean | required | Whether a run can be interrupted mid-turn (not only killed). | Use cancel, and label it cancel: the process group is terminated and the turn is lost. |
| `listSessions` | boolean | required | Whether session summaries can be enumerated without running the agent. | Not offer a session list for this agent. |
| `readTranscript` | boolean | required | Whether a full transcript can be read from disk. | Not offer a transcript view. |
| `nativeTodos` | boolean | required | Whether the agent maintains its own todo list that MutiAgent can read. | Not fold native todos into the shared board; the board shows only authored items. |
| `nativePlan` | boolean | required | Whether the agent has a plan mode whose state MutiAgent can read. | Not offer plan observation; `AgentPlan.mode: 'observe'` has nothing to observe. |
| `externalWorktree` | boolean | required | Whether the agent can be told to work in a git worktree it did not create. | Never pass a worktree path the agent must accept as foreign: MutiAgent runs the agent with `cwd` set instead (ADR-0008). All three adapters declare `false`. |
| `mcpClient` | boolean | required | Whether the agent is an MCP client and can therefore pull the shared board. | Do not propose the MCP server configuration for this agent. |
| `listModels` | boolean | required | Whether the agent exposes a model/provider listing MutiAgent can surface. | Do not offer a model picker. |
| `sandboxProfiles` | `readonly string[]` | required | Sandbox profile names the agent accepts, when it has a sandbox. | Do not send a sandbox profile; an empty list means the agent has no sandbox at all. |
| `approvalModes` | `readonly string[]` | required | Approval modes the agent accepts. | Do not send an approval mode. |
| `credentials.status` | boolean | required | Whether status can be determined without a human. | Report credential state as unknown rather than guessing. |
| `credentials.login` | `readonly CredentialFlow[]` | required | Login flows available non-interactively or with a surfaced human step. | Do not offer a login button for a flow not in the list; empty means no login path exists. |
| `credentials.logout` | boolean | required | Whether logout is available. | Do not offer logout. |

Validator: `AgentCapabilitiesSchema` in `packages/contracts/src/capabilities.ts`, used by the adapter registry at registration time, so a malformed declaration fails at load rather than letting a consumer branch on an undefined flag later. `RunModeSchema` and `CredentialFlowSchema` validate the two enums.

### `AgentDetection`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `installed` | boolean | required | Whether a usable binary was found. |
| `binaryPath` | string | optional | Absolute path of the resolved binary. |
| `source` | `'path' \| 'config' \| 'well-known' \| 'none'` | required | Which probe produced the path. |
| `version` | string | optional | Version string reported by the binary, verbatim (first line of `--version`). |
| `homeDir` | string | optional | Absolute path of the agent's home/config directory. |
| `reason` | string | optional | Why detection failed, written as a remediation line, never a stack trace. |

Invariant: `installed: true` implies `source !== 'none'` and `binaryPath` present; `detectionFrom` in `packages/core/src/discovery/detect.ts` is the only constructor and enforces it.

### `AgentTransport`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `mode` | `RunMode` | required | Run mode this transport implements. |
| `mechanism` | string | required | Native mechanism, e.g. `codex exec --json`. |
| `available` | boolean | required | Whether the transport is implemented in this adapter version. |

`AgentTransport` has no note field, so an unavailable transport can only explain itself inside `mechanism`: Codex (`codex app-server --stdio (duplex transport planned)`) and Grok (`… — known but not implemented in v0.1; every dispatch uses the headless transport`) do, while Pi's `mechanism` is only `pi --mode rpc (JSONL commands on stdin, responses and events on stdout)` and its `available: false` is the only signal.

### `AgentDescriptor`

A fully described integrated agent. Produced by an adapter's `describe()` and returned verbatim from the catalog operations, so the GUI and external MCP clients see the same declaration.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `AgentId` | required | Canonical agent id. |
| `displayName` | string | required | Human name, e.g. `Codex`. |
| `summary` | string | required | One-line description of the product behind the adapter. |
| `capabilities` | `AgentCapabilities` | required | Capability declaration. |
| `detection` | `AgentDetection` | required | Detection result on this machine. |
| `transports` | `readonly AgentTransport[]` | required | Transports the adapter knows about. |
| `environmentKeys` | `readonly string[]` | required | Environment variable names the adapter sets for a run; names only, never values. |
| `sessionRoot` | string | optional | Where session data lives, for display. |
| `credentialPath` | string | optional | Where credentials live, for display. Not a secret. |

Invariant: `capabilities()` must be synchronous and must not depend on detection; `describe()` carries what is present on this machine. Only `describe()` touches the filesystem.

## Authentication

### `AgentAuthState`

Authentication state of one agent, with no secret material anywhere inside. `AuthStatus` is `authenticated | unauthenticated | expired | misconfigured | unknown`; `AuthSource` is `file | env | keyring | cli-probe | none`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `agentId` | `AgentId` | required | Canonical agent id. |
| `status` | `AuthStatus` | required | Classified state. `misconfigured` means the store exists but could not be read or does not hold credential material. |
| `source` | `AuthSource` | required | How the state was determined. `keyring` is how Codex reports a keyring-configured store MutiAgent cannot read. |
| `method` | string | optional | Credential mechanism observed, e.g. `api-key`, `chatgpt-oauth`, `web-login`. |
| `account` | string | optional | Account identifier or email, when the agent's store exposes one. |
| `plan` | string | optional | Subscription/plan label, when exposed. |
| `expiresAt` | string | optional | ISO 8601 expiry of the current credential, when known. |
| `credentialPath` | string | optional | Where the credential is stored, for display. |
| `environmentKeys` | `readonly string[]` | required | Variable names currently supplying a credential, names only. |
| `detail` | string | optional | Human-readable explanation of a non-authenticated state. |
| `observedAt` | string | required | ISO 8601 time this state was observed. |

Invariant: a credential supplied through the environment is always reported as such and carries a `detail` saying MutiAgent cannot log it out. Which source wins is adapter-specific and follows each agent's own behavior: Codex and Grok report the environment first (with Codex's keyring-only store yielding `unknown`/`source: 'keyring'`), while Pi classifies a usable stored credential first and falls back to the environment.

### `AuthOperationResult`

The result of a login or logout attempt: the intent plus the state observed immediately after.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `ok` | boolean | required | Whether the CLI process exited successfully. |
| `action` | `'login' \| 'logout'` | required | What was attempted. |
| `interaction.kind` | `'browser-url' \| 'device-code' \| 'stdin-secret' \| 'none'` | required inside `interaction` | Interaction the user must complete. |
| `interaction.url` | string | optional | Verification URL to open, when the flow provides one. |
| `interaction.code` | string | optional | Device/user code to display. |
| `interaction.instructions` | string | optional | Instructions for the human, in the flow's own terms. |
| `state` | `AgentAuthState` | required | State observed after the attempt; never the requested intent. |
| `output` | string | optional | Redacted tail of the CLI output, for diagnosis. |

Invariant: `ok: false` with an `interaction` is a complete answer, not an error — Pi and Grok report a flow they cannot complete non-interactively this way rather than faking a success. The SPI carries one result, so `interaction` and `output` are reported after the CLI exits, never streamed during the flow.

## Sessions

### `SessionBinding`

Which MutiAgent actor a session is bound to. All three fields are MutiAgent-side state and never read from a native store; an adapter always emits `{ runIds: [] }`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `collaborationId` | string | optional | Collaboration this session participates in, when any. |
| `worktreeId` | string | optional | Worktree the session's runs execute in, when isolated. |
| `runIds` | `readonly string[]` | required | Run ids dispatched into this session, oldest first. |

### `ProjectionNote`

A declared gap between a native record and the canonical projection.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `field` | string | required | Canonical field the note is about, or `'*'` for the whole object. |
| `reason` | string | required | Why the value is absent, approximated or lossy. |

Invariant: loss is declared, never silently dropped. A projection that cannot represent something either sets a `ProjectionNote`, sets `AgentMessage.truncated`, or (for a run) appends to `RunResult.notes`; the three adapters' declared losses are listed in each adapter README.

### `AgentSession`

A canonical session summary: enough to list, filter, sort and route a session without reading its transcript. `SessionStatus` is `idle | running | missing | unreadable`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `key` | `SessionKey` | required | `<agentId>:<nativeId>`. |
| `agentId` | `AgentId` | required | Owning agent. |
| `nativeId` | `NativeSessionId` | required | The agent's own identifier, verbatim; the value to pass back on resume. |
| `nativePath` | string | optional | Absolute path of the native record on disk, when it has one. |
| `title` | string | optional | Title from the agent's own naming, else derived by a consumer from the first user message; adapters never invent one. |
| `titleIsNative` | boolean | optional | Whether `title` is the agent's own name rather than derived. |
| `cwd` | string | optional | Absolute working directory the session was created in. |
| `repoRoot` | string | optional | Repository root inferred from `cwd`, when it is inside a git repository. |
| `branch` | string | optional | Git branch recorded by the agent, when it recorded one. |
| `model` | string | optional | Model id used by the session, verbatim. |
| `createdAt` | string | optional | ISO 8601 creation time. |
| `updatedAt` | string | optional | ISO 8601 last activity time. |
| `status` | `SessionStatus` | required | Observed status. All three adapters report only `idle` or `unreadable`; MutiAgent's session index (`packages/core/src/sessions/index.ts`) marks a tracked session `missing` when it can no longer be found. `running` is declared for a run in flight and nothing sets it yet. |
| `messageCount` | number | optional | Message count as the agent reports it. |
| `parentNativeId` | `NativeSessionId` | optional | Parent session for a forked or subagent session. |
| `source` | string | optional | What created the session, in the agent's own vocabulary. |
| `usage` | `SessionUsage` | optional | Token usage totals, when the agent records them. |
| `binding` | `SessionBinding` | required | MutiAgent-side binding state. |
| `notes` | `readonly ProjectionNote[]` | required | Declared projection gaps. |

Invariant: `ids.ts`'s `sessionKey(agentId, nativeId)` is the only way to build `key`, and `splitSessionKey` is the only way back, so a consumer never re-derives the format.

### `SessionUsage`

Token accounting for one session or one run. Every field is optional because the three agents report different subsets.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `inputTokens` | number | optional | Input tokens. |
| `outputTokens` | number | optional | Output tokens. |
| `cachedInputTokens` | number | optional | Cached input tokens (Grok's `cachedReadTokens`, Codex's `cached_input_tokens`). |
| `reasoningTokens` | number | optional | Reasoning/thinking tokens. |
| `totalTokens` | number | optional | Total, when the agent computes one. |
| `costUsd` | number | optional | Reported cost in USD when the agent computes one (Grok: `costUsdTicks / 1e10`). |

### `AgentMessage` and `AgentTranscript`

`MessageKind` is `user | assistant | reasoning | tool-call | tool-result | file-change | plan | error | system | unknown`.

| `AgentMessage` field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | optional | Stable id within the session when the native store provides one. |
| `index` | number | required | Ordering index within the read window, ascending. Adapters add it after projecting. |
| `role` | `'user' \| 'assistant' \| 'system' \| 'tool' \| 'unknown'` | required | Which side of the conversation produced the item. |
| `kind` | `MessageKind` | required | Normalized kind. |
| `text` | string | optional | Plain text content, when the item has any. |
| `timestamp` | string | optional | ISO 8601 timestamp, when recorded. |
| `tool.name` | string | required inside `tool` | Tool name. |
| `tool.input` | string | optional | Serialized input, verbatim from the native record. |
| `tool.output` | string | optional | Serialized output, verbatim, possibly truncated. |
| `tool.failed` | boolean | optional | Whether the native record marks the call as failed. |
| `paths` | `readonly string[]` | optional | Paths touched, for `file-change`. |
| `usage` | `SessionUsage` | optional | Usage attributed to this item, when the native store records per-item usage. |
| `nativeType` | string | optional | Native record type, for traceability. |
| `truncated` | boolean | optional | Whether `text` or `tool` was truncated by a read cap. Only present when something was cut. |

| `AgentTranscript` field | Type | Required | Meaning |
|---|---|---|---|
| `key` | `SessionKey` | required | Session this transcript belongs to. |
| `messages` | `readonly AgentMessage[]` | required | Messages in ascending order. |
| `totalMessages` | number | optional | Total messages the native store holds, when knowable from metadata. Codex never reports it. |
| `hasMore` | boolean | required | Whether older messages exist before `messages[0]`. |
| `notes` | `readonly ProjectionNote[]` | required | Declared projection gaps. |

Invariant: `index` is window-relative, so a consumer that wants absolute positions must resolve them from `hasMore` plus the reader's own caps; the SPI's `readTranscript` returns exactly this minus `key` (see `AgentAdapter.readTranscript` in `packages/core/src/adapter/types.ts`).

## Tasks, plans and partitions

### `TodoStatus` and `AgentTodo`

`TodoStatus` is `pending | in_progress | completed | blocked | cancelled`. It names the canonical vocabulary for every agent's task model, and a native status outside it is normalized: Codex maps only `pending`/`in_progress`/`completed` (its checklist has no blocked or cancelled state), Grok maps its four 1:1, and anything unrecognized becomes `pending`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `TodoId` | required | Stable id; a foreign item gets a deterministic id derived from its native key (Codex: FNV-1a of session, native key and content; Grok: FNV-1a of the native key). |
| `content` | string | required | Short imperative line. |
| `status` | `TodoStatus` | required | Current status. |
| `owner` | `AgentId \| 'shared'` | required | Agent that owns the item, or `'shared'` for a collaboration-level item. |
| `blockedBy` | `readonly TodoId[]` | required | Ids that must complete first. Always empty for Codex and Grok: neither expresses dependencies between items. |
| `updatedAt` | string | required | ISO 8601 last change time. |
| `observedIn` | `SessionKey` | optional | Session the item was observed in, when it came from a native store. |
| `nativeKey` | string | optional | Native key of the item, for traceability. |

### `PlanPhase` and `AgentPlan`

| `PlanPhase` field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | required | Stable id within the plan. |
| `title` | string | required | Phase title. |
| `status` | `'todo' \| 'active' \| 'done'` | required | State of the phase. |
| `owner` | `AgentId \| 'shared'` | optional | Agent responsible for the phase, when assigned. |
| `exitCriteria` | string | optional | What must be true for the phase to be done. |

| `AgentPlan` field | Type | Required | Meaning |
|---|---|---|---|
| `collaborationId` | string | required | Collaboration this plan belongs to. |
| `objective` | string | required | One-sentence objective. |
| `phases` | `readonly PlanPhase[]` | required | Ordered phases. |
| `activePhaseId` | string | optional | Id of the phase currently being worked. |
| `decisions` | `readonly string[]` | required | Append-only decisions log; each entry is one line. |
| `updatedAt` | string | required | ISO 8601 last change time. |
| `mode` | `'inject' \| 'observe'` | required | How this document is treated for delegated agents (ADR-0009): `inject` puts it in their context, `observe` only records it. |

### `AgentSessionPartition`

A session-grouped view the UI renders directly: one partition per agent.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `agentId` | `AgentId` | required | Agent this partition belongs to. |
| `displayName` | string | required | Display name, so the client needs no descriptor lookup to render a header. |
| `installed` | boolean | required | Whether the agent is installed and usable here. |
| `sessions` | `readonly AgentSession[]` | required | Sessions in this partition, already sorted by the request's sort order. |
| `untrackedCount` | number | required | Sessions this agent has that could be tracked but are not yet. |
| `note` | string | optional | Why the partition is empty, when it is. |

## Runs

### `RunStatus` and `IsolationMode`

| Type | Values | Invariant |
|---|---|---|
| `RunStatus` | `preparing`, `running`, `succeeded`, `failed`, `cancelled`, `timeout` | `preparing` and `running` are non-terminal; `RunManager` treats exactly those two as live. |
| `IsolationMode` | `worktree`, `shared-cwd` | Isolation is decided in `RunManager.dispatch` and nowhere else; an adapter only sees the resolved `cwd` and the mode (ADR-0008). |

### `InjectedContext`

One context block injected into a delegated run's prompt (ADR-0009).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `kind` | `'shared-todos' \| 'shared-plan' \| 'collaboration-brief' \| 'user'` | required | What produced the block. |
| `text` | string | required | Rendered text, verbatim, so the run is reproducible from its record. |
| `hash` | string | required | Content hash of `text`, for idempotent re-injection. |

`renderPrompt(prompt, context)` in `packages/core/src/orchestration/runs.ts` composes the final prompt as the trimmed blocks joined by a blank line, then `---`, then the task; with no blocks, or only empty ones, the prompt is returned unchanged.

### `RunRequest`

Everything needed to dispatch one run.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `agentId` | `AgentId` | required | Target agent. |
| `prompt` | string | required | The task text handed to the agent. |
| `cwd` | string | required | Absolute directory to run in; already resolved to a worktree when isolated. |
| `isolation` | `IsolationMode` | required | Isolation actually applied. |
| `resumeNativeId` | `NativeSessionId` | optional | Continue this native session instead of starting a new one. |
| `model` | string | optional | Model override, verbatim; ignored when the agent has no model selection. |
| `sandbox` | string | optional | Sandbox profile name from the adapter's declared set. |
| `approval` | string | optional | Approval mode from the adapter's declared set. |
| `timeoutMs` | number | optional | Wall-clock budget; absent means bounded only by cancellation. |
| `env` | `Readonly<Record<string, string>>` | optional | Extra environment entries layered over the adapter's resolved set. |
| `context` | `readonly InjectedContext[]` | required | Context blocks to inject ahead of the prompt. |
| `collaborationId` | string | optional | Collaboration this run belongs to, when any. |
| `worktreeId` | string | optional | Worktree allocated for this run, when isolated. |
| `requestedBy` | string | required | Who asked for the run: the harness agent, the GUI, an MCP client, or a user. |

Note on this type's current use: `RunRequest` is declared and exported but nothing in the tree constructs one. `RunManager.dispatch` takes its own `DispatchParams` and hands adapters the core's `AdapterRunRequest`; once a run is live, the record is `RunRecord`. A consumer that wants "the request" should read `RunRecord`, which keeps the prompt, context, cwd, argv and environment names.

### `RunHandle`

A live run handle as returned to a dispatcher.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `RunId` | required | Run identifier. |
| `agentId` | `AgentId` | required | Target agent. |
| `sessionKey` | `SessionKey` | optional | Session the run writes into, once known; may arrive after the first event. |
| `status` | `RunStatus` | required | Current status. |
| `startedAt` | string | required | Wall-clock start, ISO 8601. |
| `cwd` | string | required | Directory the run executes in. |
| `isolation` | `IsolationMode` | required | Isolation applied. |
| `worktreeId` | `WorktreeId` | optional | Worktree allocated, when isolated. |
| `collaborationId` | `CollaborationId` | optional | Collaboration the run belongs to, when any. |
| `argv` | `readonly string[]` | required | Redacted argv of the spawned process, for the run record. The prompt passes through a `Redactor` before it lands here. |
| `environmentKeys` | `readonly string[]` | required | Environment variable names passed, never values. |

### `RunResult`

Final outcome of a run.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `handle` | `RunHandle` | required | The handle the run was started with, with `status` and `sessionKey` finalized. |
| `finishedAt` | string | required | ISO 8601 completion time. |
| `durationMs` | number | required | Duration in milliseconds. |
| `exitCode` | number | optional | Process exit code, when the run reached a process exit. |
| `signal` | string | optional | Signal that terminated the process, when it was signalled. |
| `finalText` | string | optional | Final assistant text, when the agent produced one. |
| `usage` | `SessionUsage` | optional | Token usage, when the agent reported it. |
| `error.code` | string | required inside `error` | Canonical error code (a value of `ErrorCodes`). |
| `error.message` | string | required inside `error` | What happened. |
| `error.remediation` | string | optional | Actionable next step for the human. |
| `error.output` | string | optional | Redacted tail of native stderr, bounded. |
| `notes` | `readonly string[]` | required | Declared projection gaps for this run's events. Structured per-object notes live on sessions, messages and task state; `RunResult` carries strings by declaration. |

Invariant: a run that failed carries `error`, and its `handle.status` matches the error class: `run/cancelled` → `cancelled`, `run/timeout` → `timeout`, everything else → `failed`. `RunManager.pump` re-derives the stored record's status from the error code exactly that way, and treats a result with no `error` as `succeeded` (or `failed` when no result arrived at all).

### `AgentRunEvent`

The single normalized run-event union every adapter emits (ADR-0003). `kind` is the discriminant; every variant carries `runId` and an ISO 8601 `at`. `run.finished` is always the last event, and `isTerminalEvent(event)` is the narrowing helper (`event.kind === 'run.finished'`).

| Discriminant | Payload beyond `runId`/`at` | Meaning |
|---|---|---|
| `run.started` | `agentId: AgentId`, `nativeSessionId?: NativeSessionId` | The process started; the adapter resolved a native session id if it had one early. |
| `session.bound` | `nativeSessionId: NativeSessionId`, `title?: string` | The agent told us which native session it is using. |
| `message.delta` | `text: string` | Incremental assistant text. Codex sends accumulated text, so the adapter emits only the suffix beyond what that item already emitted. |
| `reasoning.delta` | `text: string` | Incremental reasoning/thinking text, where the agent exposes it. |
| `message.completed` | `text: string` | A complete assistant message. |
| `tool.started` | `callId?: string`, `toolName: string`, `input?: string` | A tool call began. |
| `tool.completed` | `callId?: string`, `toolName: string`, `output?: string`, `failed?: boolean` | A tool call ended. |
| `files.changed` | `paths: readonly string[]` | Files the agent changed, as reported by the agent. |
| `todos.updated` | `todos: readonly { content: string; status: string }[]` | The agent's todo list changed. The status here is the native token, not the canonical `TodoStatus`. |
| `plan.updated` | `active: boolean`, `phases?: readonly string[]` | The agent's plan-mode state changed. |
| `usage.updated` | `usage: SessionUsage` | Token/usage accounting. |
| `approval.requested` | `requestId: string`, `summary: string`, `answerable: boolean` | An approval or permission request the host must answer. Never emitted over a headless transport, which cannot carry an answer. |
| `warning` | `message: string` | A non-fatal diagnostic worth surfacing. |
| `unknown` | `nativeType?: string`, `native: string` | A native event the adapter does not model; preserved rather than dropped. |
| `output` | `stream: 'stdout' \| 'stderr'`, `text: string` | The agent produced output MutiAgent could not attribute to a known kind. |
| `run.finished` | `result: RunResult` | The run reached a terminal state. Always the last event. |

Invariants a consumer can rely on: the stream is single-consumer and ends after `run.finished`; `AdapterRun.result` resolves with the same terminal result whether or not `events` is consumed; a `tool.completed` always has a matching `tool.started`, synthesized by the adapter if the start was missed; and the terminal event is never dropped when a reader falls behind.

## Mesh

### `MeshTask`

One delegated unit of work inside a collaboration.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | required | Task id, stable for the life of the collaboration. |
| `collaborationId` | `CollaborationId` | required | Collaboration the task belongs to. |
| `title` | string | required | One-line description of the deliverable. |
| `instruction` | string | required | Full instruction handed to the agent. |
| `assignee` | `AgentId` | required | Agent the task is assigned to. |
| `status` | `'queued' \| 'running' \| 'succeeded' \| 'failed' \| 'cancelled' \| 'blocked'` | required | Task state. Dispatching a task already `running` or `succeeded`, or blocked by an unfinished dependency, is refused with `mesh/invalid-transition`. |
| `dependsOn` | `readonly string[]` | required | Tasks that must finish first. |
| `runId` | `RunId` | optional | Run dispatched for this task, once any. |
| `worktreeId` | `WorktreeId` | optional | Worktree the task executes in, when isolated. |
| `createdAt` | string | required | ISO 8601 creation time. |
| `updatedAt` | string | required | ISO 8601 last state change. |
| `note` | string | optional | Why the task is blocked or failed. |

### `FileChangeStat` and `WorktreeProgress`

`ConflictSeverity` (used by `ConflictFinding`) is `info | warning | blocking`.

| `FileChangeStat` field | Type | Required | Meaning |
|---|---|---|---|
| `path` | string | required | Repository-relative path. |
| `insertions` | number | required | Lines added. |
| `deletions` | number | required | Lines removed. |
| `status` | `'added' \| 'modified' \| 'deleted' \| 'renamed' \| 'untracked' \| 'conflicted'` | required | Change kind as git reports it. |
| `hunks` | `readonly { start: number; lines: number }[]` | optional | Hunk ranges of the working-tree diff, in unified-diff order. |

| `WorktreeProgress` field | Type | Required | Meaning |
|---|---|---|---|
| `at` | string | required | ISO 8601 time of the sample. |
| `head` | string | required | HEAD commit at sample time. |
| `branch` | string | required | Branch name. |
| `ahead` | number | required | Commits ahead of the recorded base. |
| `behind` | number | optional | Commits behind the base branch, when it can be computed. |
| `files` | `readonly FileChangeStat[]` | required | Changed files with counts. |
| `totals` | `{ insertions: number; deletions: number; files: number }` | required | Totals across `files`. |
| `agentAlive` | boolean | required | Whether the owning agent process was alive at sample time. |
| `dirty` | boolean | required | Whether the worktree has uncommitted changes. |
| `notes` | `readonly string[]` | required | Declared gaps, e.g. hunks unavailable. |

### `MeshWorkspace`

A git worktree owned by MutiAgent.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `WorktreeId` | required | Worktree id. |
| `path` | string | required | Absolute path of the worktree. |
| `repoRoot` | string | required | Absolute path of the repository the worktree belongs to. |
| `branch` | string | required | Branch checked out in the worktree. |
| `baseCommit` | string | required | Commit the worktree was created from. |
| `baseRef` | string | required | Ref the base commit belongs to, e.g. `main`. |
| `agentId` | `AgentId` | required | Agent that owns this worktree. |
| `runId` | `RunId` | optional | Run currently executing here, when any. |
| `collaborationId` | `CollaborationId` | optional | Collaboration the worktree serves, when any. |
| `createdAt` | string | required | Creation time. |
| `progress` | `WorktreeProgress` | optional | Latest sample, when the watcher has taken one. |
| `state` | `'active' \| 'idle' \| 'merged' \| 'removed' \| 'orphan'` | required | Lifecycle state. `orphan` means present on disk but absent from state; such a worktree is never adopted silently. |
| `reusable` | boolean | required | Whether a reserved worktree may be reused by a later run. |

### `ConflictFinding` and `ConflictReport`

| `ConflictFinding` field | Type | Required | Meaning |
|---|---|---|---|
| `kind` | `'same-file' \| 'same-hunk' \| 'feature-boundary' \| 'base-drift'` | required | How the conflict was detected. |
| `severity` | `ConflictSeverity` | required | Severity, per the configured conflict policy. |
| `left` | `WorktreeId` | required | First worktree. |
| `right` | `WorktreeId` | required | Second worktree. |
| `paths` | `readonly string[]` | required | Paths involved. |
| `detail` | string | required | Human explanation. |

| `ConflictReport` field | Type | Required | Meaning |
|---|---|---|---|
| `repoRoot` | string | required | Repository the report covers. |
| `at` | string | required | ISO 8601 time of the report. |
| `worktrees` | `readonly WorktreeId[]` | required | Worktrees considered. |
| `findings` | `readonly ConflictFinding[]` | required | Findings, most severe first. |
| `suggestedOrder` | `readonly WorktreeId[]` | optional | Proposed integration order when findings exist. |
| `notes` | `readonly string[]` | required | Declared gaps, e.g. hunk-level detection unavailable without a diff. |

Detection is advisory: it never blocks a run unless `worktree.conflictPolicy = 'block'` is configured (ADR-0008).

### `SharedTodoDoc`

The shared collaboration board.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `collaborationId` | `CollaborationId` | required | Collaboration the board belongs to. |
| `todos` | `readonly AgentTodo[]` | required | Every item, from agents and humans alike. |
| `updatedAt` | string | required | ISO 8601 last change. |
| `revision` | number | required | Monotonic revision, bumped on every accepted mutation. `todos.set` accepts `expectedRevision` and rejects a stale write rather than clobbering it. |

### `RunRecord`

A run's redacted record, kept for the mesh panel and for reproducibility.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `RunId` | required | Run id. |
| `collaborationId` | `CollaborationId` | optional | Collaboration, when any. |
| `taskId` | string | optional | Task, when any. |
| `agentId` | `AgentId` | required | Target agent. |
| `nativeSessionId` | string | optional | Native session the run wrote into, once the agent revealed it. Filled from `session.bound` or an early `run.started`. |
| `isolation` | `'worktree' \| 'shared-cwd'` | required | Isolation applied (the literals, not the `IsolationMode` alias). |
| `worktreeId` | `WorktreeId` | optional | Worktree, when isolated. |
| `cwd` | string | required | Working directory. |
| `argv` | `readonly string[]` | required | Redacted argv. |
| `environmentKeys` | `readonly string[]` | required | Environment variable names only. |
| `context` | `readonly { kind: string; hash: string; text: string }[]` | required | Context blocks injected, verbatim. |
| `prompt` | string | required | The prompt handed to the agent, after redaction. |
| `status` | `'preparing' \| 'running' \| 'succeeded' \| 'failed' \| 'cancelled' \| 'timeout'` | required | Lifecycle state. |
| `startedAt` | string | required | ISO 8601 start. |
| `finishedAt` | string | optional | ISO 8601 finish. |
| `exitCode` | number | optional | Exit code, when the run reached a process exit. |
| `error` | `{ code: string; message: string }` | optional | Classified error code and message, when the run failed. |
| `counters.events` | number | required inside `counters` | Events observed. |
| `counters.toolCalls` | number | required inside `counters` | `tool.started` events observed. |
| `counters.filesChanged` | number | required inside `counters` | Paths summed over `files.changed` events. |

### `Collaboration`

The collaboration aggregate returned to the UI.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `CollaborationId` | required | Collaboration id. |
| `title` | string | required | Human title. |
| `repoRoot` | string | required | Repository the collaboration works in. |
| `plan` | `AgentPlan` | required | Plan document. |
| `todos` | `SharedTodoDoc` | required | Shared todo board. |
| `tasks` | `readonly MeshTask[]` | required | Tasks. |
| `runs` | `readonly RunRecord[]` | required | Runs dispatched for this collaboration. |
| `worktrees` | `readonly MeshWorkspace[]` | required | Worktrees allocated. |
| `conflicts` | `ConflictReport` | optional | Latest conflict report, when a scan has run. |
| `createdAt` | string | required | ISO 8601 creation. |
| `updatedAt` | string | required | ISO 8601 last change. |

## Errors

`ErrorNamespace` names the nine namespaces: `detection`, `auth`, `session`, `run`, `worktree`, `schema`, `harness`, `mesh`, `wire`.

### `MutiAgentErrorShape`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `code` | string | required | `<namespace>/<slug>`. |
| `message` | string | required | What went wrong, naming the agent and operation. |
| `remediation` | string | optional | What the human should do next, when there is an action. |
| `details` | `Readonly<Record<string, string \| number \| boolean>>` | optional | Extra context: agent id, path, exit code. Never a credential. |
| `retryable` | boolean | required | Whether a retry could succeed without changing inputs. |
| `cause` | string | optional | Preserved lower-level cause message, redacted. |

### `MutiAgentError`

The error class thrown inside the host. `code`, `remediation`, `details` and `retryable` are readonly; `retryable` defaults to `false` and `cause` is stored as a message string, never as the thrown object. `toShape()` serializes to the fields above; `isMutiAgentError(value)` narrows; `toErrorShape(value)` converts any thrown value, mapping everything that is not a `MutiAgentError` to `harness/unclassified` with `retryable: false`.

### `ErrorCodes`

`ErrorCodes` is a `const` table, kept in one place so the set is auditable. Codes are stable: the GUI, tools and diagnostics localize against the namespace, so a code must never be renamed without treating it as a breaking change. `ErrorCode` is the union of its values.

| Namespace | Code | Selector |
|---|---|---|
| detection | `detection/not-found` | `detectionNotFound` |
| detection | `detection/probe-failed` | `detectionProbeFailed` |
| detection | `detection/home-unresolved` | `detectionHomeUnresolved` |
| auth | `auth/not-configured` | `authNotConfigured` |
| auth | `auth/expired` | `authExpired` |
| auth | `auth/store-unreadable` | `authStoreUnreadable` |
| auth | `auth/login-unsupported` | `authLoginUnsupported` |
| auth | `auth/login-failed` | `authLoginFailed` |
| auth | `auth/logout-failed` | `authLogoutFailed` |
| auth | `auth/human-step-required` | `authHumanStepRequired` |
| session | `session/not-found` | `sessionNotFound` |
| session | `session/unreadable` | `sessionUnreadable` |
| session | `session/root-missing` | `sessionRootMissing` |
| session | `session/read-cap-exceeded` | `sessionReadCapExceeded` |
| run | `run/start-failed` | `runStartFailed` |
| run | `run/agent-crashed` | `runAgentCrashed` |
| run | `run/cancelled` | `runCancelled` |
| run | `run/timeout` | `runTimeout` |
| run | `run/rate-limited` | `runRateLimited` |
| run | `run/policy-blocked` | `runPolicyBlocked` |
| run | `run/protocol-error` | `runProtocolError` |
| run | `run/not-running` | `runNotRunning` |
| run | `run/context-unavailable` | `runContextUnavailable` |
| worktree | `worktree/not-a-repository` | `worktreeNotARepository` |
| worktree | `worktree/create-failed` | `worktreeCreateFailed` |
| worktree | `worktree/not-found` | `worktreeNotFound` |
| worktree | `worktree/dirty` | `worktreeDirty` |
| worktree | `worktree/unmerged` | `worktreeUnmerged` |
| worktree | `worktree/orphan` | `worktreeOrphan` |
| worktree | `worktree/git-unavailable` | `worktreeGitUnavailable` |
| schema | `schema/invalid` | `schemaInvalid` |
| schema | `schema/version-unsupported` | `schemaVersionUnsupported` |
| schema | `schema/todo-conflict` | `schemaTodoConflict` |
| harness | `harness/tools-unavailable` | `harnessToolsUnavailable` |
| harness | `harness/route-unavailable` | `harnessRouteUnavailable` |
| harness | `harness/service-missing` | `harnessServiceMissing` |
| harness | `harness/unclassified` | `harnessUnclassified` |
| mesh | `mesh/collaboration-not-found` | `meshCollaborationNotFound` |
| mesh | `mesh/task-not-found` | `meshTaskNotFound` |
| mesh | `mesh/confirmation-required` | `meshConfirmationRequired` |
| mesh | `mesh/invalid-transition` | `meshInvalidTransition` |
| wire | `wire/bad-envelope` | `wireBadEnvelope` |
| wire | `wire/unknown-method` | `wireUnknownMethod` |
| wire | `wire/unauthorized` | `wireUnauthorized` |
| wire | `wire/bad-params` | `wireBadParams` |

Some codes are declared before a caller raises them. The current tree raises: `detectionNotFound`, `authNotConfigured`, `authLoginUnsupported`, `authLoginFailed`, `sessionNotFound`, `sessionUnreadable`, `runStartFailed`, `runAgentCrashed`, `runCancelled`, `runTimeout`, `runRateLimited`, `runPolicyBlocked`, `runProtocolError`, `runNotRunning`, `runContextUnavailable`, `worktreeNotARepository`, `worktreeCreateFailed`, `worktreeNotFound`, `worktreeDirty`, `worktreeUnmerged`, `worktreeGitUnavailable`, `schemaInvalid`, `schemaTodoConflict`, `harnessServiceMissing`, `meshCollaborationNotFound`, `meshTaskNotFound`, `meshInvalidTransition`, `wireBadEnvelope`, `wireUnknownMethod`, `wireBadParams`. `meshConfirmationRequired` appears only in a branch of `OperationCatalog.invoke` that the current `canInvoke` logic makes unreachable. Declared but not raised anywhere in `packages/*/src`: `detectionProbeFailed`, `detectionHomeUnresolved`, `authExpired`, `authStoreUnreadable`, `authLogoutFailed`, `authHumanStepRequired`, `sessionRootMissing`, `sessionReadCapExceeded`, `worktreeOrphan`, `schemaVersionUnsupported`, `harnessToolsUnavailable`, `harnessRouteUnavailable`, `wireUnauthorized`. `harness/unclassified` is produced as a literal string by `toErrorShape` rather than through the table.

## Versioning rules

From `packages/contracts/src/version.ts`:

| Constant | Value | Bumped when | Consumers detect it |
|---|---|---|---|
| `SCHEMA_VERSION` | `1` | An existing field changes meaning, or a required field is added. Additive optional fields do not bump it. | Every HTTP and MCP success and failure envelope carries `schemaVersion`; `agents.diagnostics` and `mutiagent.methods` also report it. |
| `WIRE_VERSION` | `1` | The HTTP/MCP method envelope itself changes. | Same envelopes, and the SSE opening comment frame (`: mutiagent <schema>/<wire>`). |
| `PLUGIN_VERSION` | `'0.1.0'` | Mirrored from the installable package manifest (`packages/plugin/package.json`). | `mutiagent.methods`, `agents.diagnostics`, the MCP `serverInfo.version`, and tool descriptions. |
| `METHOD_PATTERN` | `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/` | — | `isMethodName(value)` tests it; `OperationCatalog.register` throws on a violation. |

Invariant: `version.ts` says changing either version requires a migration note in this file and a bump consumers can read before interpreting data (ADR-0002), so a version bump and the corresponding note here land together.

## Projection rules

From the rules block at the top of `packages/core/src/adapter/types.ts` and ADR-0002:

1. **Read-only toward others.** `listSessions`, `readTranscript` and `readNativeTasks` are read-only. No adapter may write into another product's store (ADR-0012); an "import" links to the native record in MutiAgent's own index.
2. **No stored credentials.** `authStatus`, `login` and `logout` never persist a credential of their own; they inspect the native store and delegate mutation to the native CLI (ADR-0010).
3. **Canonical events only.** `run` emits the canonical event union and nothing native; a native event the adapter cannot model is emitted as `unknown` rather than dropped (ADR-0003).
4. **Declaration over detection.** An adapter reports what it supports in `capabilities()`, whose result must not depend on detection; `describe().detection` carries what is present on this machine.
5. **Loss is declared.** A projection that cannot represent a native value sets a `ProjectionNote` (or `truncated`, or a run note) rather than dropping the value silently.
6. **Native identifiers are preserved verbatim** in branded types and native record labels (`nativeType`, `nativeKey`, `nativePath`), so any canonical object can be traced back.
7. **No model in the projection path.** Mapping is deterministic TypeScript.

Two further rules from ADR-0002 that the code enforces structurally: canonical types are the only vocabulary above the adapter layer, and the schema is expressed once, as TypeScript types plus validators in `packages/contracts/src/schemas.ts`, so the declared schema and the enforced schema are one declaration.

The SPI itself (`AgentAdapter` in `packages/core/src/adapter/types.ts`) is: `id`, `displayName`, `capabilities()`, `describe()`, `listSessions()`, `readTranscript()`, `readNativeTasks()`, `authStatus()`, `login()`, `logout()`, `run()` and `nativeLaunchCommand()`. Three of its companion types are worth knowing at this level: `AdapterRuntimeConfig` (the shared per-adapter configuration: `enabled`, `binaryPath?`, `homeDir?`, `env`, `envMode`, `timeoutMs`, `model?`, adapter-specific `settings`), `AdapterRun` (`argv`, `environmentKeys`, `events`, `result`, `cancel()`), and `AdapterContext` (the `log`, `config`, `process` and `files` the core hands an adapter).

## The `MeshEvent` (the SSE payload)

Stated first because the name misleads: `MeshEvent` in `packages/core/src/orchestration/runs.ts` is a single interface with a `kind` discriminator and optional payload fields, not a discriminated union of separate object types.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `kind` | `'run-event' \| 'run-record' \| 'worktree-progress' \| 'todos' \| 'plan'` | required | What changed. |
| `at` | string | required | ISO 8601 time of the event. |
| `runId` | string | optional | Run id for run-scoped events. |
| `event` | `AgentRunEvent` | optional | Canonical event payload, for `run-event`. |
| `record` | `RunRecord` | optional | Record snapshot, for `run-record`. |
| `worktree` | `MeshWorkspace` | optional | Worktree snapshot, for `worktree-progress`. |
| `collaborationId` | string | optional | Collaboration id for board-scoped events. |
| `context` | `InjectedContext` | optional | Rendered context block, for `plan` events. |

Which fields accompany which `kind`, as the publisher uses them today: `run-event` carries `runId` + `event` (redacted deeply) + `record`; `run-record` carries `runId` + `record` (published when a run starts, and again when a collaboration records a finished run, where it adds `collaborationId`); `worktree-progress` carries `worktree`. `todos` and `plan` are declared in the `kind` union and carry `collaborationId` and `context`, but nothing in `packages/*/src` publishes either yet — treat them as reserved values a subscriber must tolerate, not as events it will currently receive. A subscriber receives every event until it unsubscribes; a stalled subscriber's queue is dropped past 512 unread events rather than growing host memory, and is expected to re-read state (`runs.list`, `sessions.partitions`) on reconnect. The HTTP gateway writes each event as one `data:` line on `GET /api/mutiagent/events`.

## How an adapter projects onto this

One real case, from the Codex adapter (`packages/adapter-codex/src/events.ts`, documented in `packages/adapter-codex/README.md`): `codex exec --json` emits one JSON object per stdout line; `CodexExecEventMapper.mapLine` turns that line into zero or more `AgentRunEvent`s.

| Native line | Canonical events |
|---|---|
| `thread.started` with `thread_id` | `session.bound` with `nativeSessionId` (and the run's `RunResult.handle.sessionKey` is `codex:<thread_id>`). |
| `item.started` / `item.updated`, item type `agent_message` | `message.delta` with the suffix beyond what that item already emitted. |
| `item.completed`, item type `agent_message` | `message.completed` with the full text, which also becomes `RunResult.finalText`. |
| `item.started`, item type `command_execution` | `tool.started` with `toolName: 'shell'` and `input` = `command`. |
| `item.completed`, item type `command_execution` | `tool.completed` with `output` = `aggregated_output` and `failed` = `status === 'failed' \|\| status === 'declined'`. |
| `turn.completed` with `usage` | `usage.updated` with `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens` and `totalTokens` = input + output. |
| a type this mapper does not model | `unknown` with `nativeType` and the raw line, never dropped. |

The session side works the same way in the other direction: `listCodexSessions` reads the first `session_meta` line of each rollout for identity and git state, folds `session_index.jsonl` for the title, and declares what it could not project as `ProjectionNote`s on the returned `AgentSession` ("Codex records no message count for a rollout; counting would require a full read"). Nothing native escapes the adapter: a consumer only ever sees the canonical types on this page.
