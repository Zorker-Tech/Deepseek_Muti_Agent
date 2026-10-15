# `@zorker/muti-agent-adapter-codex`

The MutiAgent adapter for [OpenAI Codex](https://github.com/openai/codex). It implements
the `AgentAdapter` SPI from `@zorker/muti-agent-core` for the `codex` CLI: session
discovery and transcript reading from `$CODEX_HOME`, run dispatch through
`codex exec --json`, native checklist extraction, and credential delegation to
`codex login` / `codex logout`.

Nothing here writes to a foreign store (ADR-0012). Rollouts, the title index and
`auth.json` are opened read-only through `FileProbe`; the only mutations this adapter
can cause are the ones Codex performs for itself when the CLI is asked to log in or out
(ADR-0010).

## Detection and home resolution

| Concern | Rule |
|---|---|
| Binary | `resolveBinary('codex', { candidates: [config.binaryPath] })` — the configured path first, then `PATH`, then the usual install locations |
| Version | `codex --version`, first line, verbatim |
| Home | `config.homeDir` if set; else `$CODEX_HOME` **only when it is a directory**; else `~/.codex`. A rejected `$CODEX_HOME` is logged and the default is used |
| Session root | `<home>/sessions` (active) and `<home>/archived_sessions` (archived, always included) |
| Title index | `<home>/session_index.jsonl` (append-only; newest entry per thread id wins) |
| Credentials | `<home>/auth.json` (read-only; only the presence and metadata of a credential are ever reported) |

`describe()` caches detection, so the catalog can be queried on every GUI load.

## Capability declaration

```jsonc
{
  "runModes": ["headless-exec"],
  "streaming": true,
  "resume": true,
  "interrupt": false,               // no duplex transport; killing the process group is cancellation, not interruption
  "listSessions": true,
  "readTranscript": true,
  "nativeTodos": true,
  "nativePlan": true,
  "externalWorktree": false,        // Codex creates its own worktree (`--worktree`); it is not told about ours
  "mcpClient": true,                // Codex reads `mcp_servers` from its own config
  "listModels": false,
  "sandboxProfiles": ["read-only", "workspace-write", "danger-full-access"],
  "approvalModes": ["on-request", "never"],
  "credentials": { "status": true, "login": ["oauth-loopback", "device-code", "api-key"], "logout": true }
}
```

Transports reported by `describe()`:

| Mode | Mechanism | Available |
|---|---|---|
| `headless-exec` | `codex exec --json` | yes |
| `duplex-protocol` | `codex app-server --stdio (duplex transport planned)` | no |

`AgentTransport` has no note field in the contract, so the reason the duplex transport
is unavailable is appended to `mechanism`. `codex app-server` is what would make
`interrupt` and interactive approval forwarding possible (ADR-0003).

## Projection table — session (`listSessions`)

| Native source | Canonical field |
|---|---|
| `session_meta` payload `id` (falls back to `session_id`, then the file name) | `nativeId` |
| `session_meta` payload `id` + adapter id | `key` = `codex:<threadId>` |
| rollout file path | `nativePath` |
| `session_index.jsonl` `thread_name` for the id | `title`, `titleIsNative: true` |
| `session_index.jsonl` `updated_at`, else the rollout file mtime | `updatedAt` |
| `session_meta` payload `timestamp` | `createdAt` |
| `session_meta` payload `cwd` | `cwd` |
| `session_meta` payload `git.branch` | `branch` |
| `session_meta` payload `git.commit_hash`, `git.repository_url` | *(no canonical field — declared in `notes`)* |
| first `turn_context` payload `model` inside the head read | `model` |
| `session_meta` payload `parent_thread_id`, else `forked_from_id` | `parentNativeId` |
| `session_meta` payload `source` (string, or single-key object flattened to `sub_agent:thread_spawn:…`) | `source`; `"<source> (archived)"` for a rollout under `archived_sessions` |
| — | `status` is always `"idle"`; a file that cannot be read becomes `"unreadable"` |
| — | `binding` is always `{ runIds: [] }`: it is MutiAgent-side state, never read from Codex |

Sorting is by rollout file mtime, newest first. A thread that briefly has both a plain
and a compressed rollout (compression happens in place) yields one session; a readable
record wins over an unreadable one.

## Projection table — transcript (`readTranscript`)

Records are read from the tail of the rollout (1 MiB by default) and mapped in file
order. Message `index` is window-relative and ascending.

| Native record | Canonical message |
|---|---|
| `session_meta` | `role: system`, `kind: system` — "Codex session `<id>` started (cwd …, originator …, codex …)" |
| `turn_context` | `role: system`, `kind: system` — "Codex turn context: model …, sandbox …, approvals …, reasoning …" |
| `compacted` | `role: system`, `kind: system` — the compaction summary |
| `response_item:message` (`role: user`) | `user` / `user`, text from `content[].text` |
| `response_item:message` (`role: assistant`, `system`, `developer`, `tool`) | `assistant`/`assistant`, `system`/`system`, `tool`/`tool-result` |
| `response_item:agent_message` | `assistant` / `assistant` |
| `response_item:reasoning` (`summary[].text`, else `content[].text`) | `assistant` / `reasoning` |
| `response_item:function_call`, `custom_tool_call` | `assistant` / `tool-call`, `tool.name`, `tool.input` = `arguments` |
| `response_item:local_shell_call` | `assistant` / `tool-call`, `tool.name: shell` |
| `response_item:function_call_output`, `custom_tool_call_output` | `tool` / `tool-result`, `tool.output` |
| `response_item:web_search_call` | `assistant` / `tool-call`, `tool.name: web_search` |
| `event_msg:item_started/item_updated/item_completed` → `TurnItem` (`UserMessage`, `AgentMessage`, `Reasoning`, `Plan`, `CommandExecution`, `FunctionCallOutput`, `McpToolCall`, `DynamicToolCall`, `CollabAgentToolCall`, `FileChange`, `WebSearch`, `ContextCompaction`) | the table above; `Plan` → `assistant` / `plan`; `FileChange` → `tool` / `file-change` with `paths` |
| `event_msg:plan_update` | `assistant` / `plan`, rendered as `- [<native status>] <step>` |
| `event_msg:error` | `system` / `error` |
| `event_msg:warning`, `guardian_warning` | `system` / `system` |
| `event_msg:user_message`, `agent_message`, `agent_reasoning(delta)`, `exec_command_begin`, `exec_command_end` (older rollouts) | the corresponding kinds above |
| `inter_agent_communication` | `system` / `system` |
| any other top-level or payload type | `unknown` / `unknown`, `nativeType` = `rollout:<type>` or `<family>:<type>`, text = bounded JSON |
| a line that is not JSON | `unknown` / `unknown`, `nativeType: rollout:unparsable`, text = the raw line |
| `token_usage`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `realtime_item`, `inter_agent_communication_metadata`, unmodelled `event_msg` subtypes | no message; an aggregated note lists each token with its count |

Type tokens are compared case- and separator-insensitively, because Codex serializes the
same item as `AgentMessage` in one payload family and `agent_message` in another.

## Projection table — native tasks (`readNativeTasks`)

Read from the rollout tail (1 MiB); the latest record in the window wins.

| Native source | Canonical |
|---|---|
| `event_msg:plan_update` / `turn_plan_updated` payload `plan[].step` + `status` | `todos[].content`, `todos[].status` (`pending`, `in_progress`, `completed`) |
| `response_item:function_call` named `update_plan`, arguments `{"plan":[…]}` | same |
| item/payload type `todo_list`, `items[].text` + `completed` | `todos[].content`, `completed → completed`, else `pending` |
| item type `Plan` (`{id, text}`) | `plan.items`: the latest plan text; `plan.active: true` |
| `id` derived from `hash(sessionId, nativeKey, content)` | `todos[].id` — stable across reads and list reorderings; a literal duplicate inside one list gets a `-<n>` suffix |
| model or session | `owner` = `codex`, `observedIn` = `codex:<threadId>`, `updatedAt` = the carrying record's timestamp, `blockedBy` = `[]` |
| — | `undefined` when the window records no checklist and no plan |

## Projection table — run (`run`)

`codex exec --json` emits one `ThreadEvent` JSON object per stdout line.

| Native event | Canonical event |
|---|---|
| adapter process start | `run.started` |
| `thread.started.thread_id` | `session.bound` (and `RunResult.handle.sessionKey`) |
| `item.started/item.updated` `agent_message` | `message.delta` with the *suffix* beyond what that item already emitted |
| `item.completed` `agent_message` | `message.completed` (also becomes `finalText`) |
| `item.started/item.updated` `reasoning` | `reasoning.delta`, as a suffix of that item's accumulated text |
| `item.started` `command_execution` | `tool.started`, `toolName: shell`, `input` = `command` |
| `item.completed` `command_execution` | `tool.completed`, `output` = `aggregated_output`, `failed` = `failed`/`declined` |
| `item.completed` `file_change` | `files.changed` with `changes[].path`; a failed apply also yields a `warning` |
| `item.*` `mcp_tool_call` | `tool.started` / `tool.completed`, `toolName` = `<server>/<tool>`, input/output as JSON |
| `item.*` `collab_tool_call` | `toolName` = `collab:<tool>`, input = `prompt`, output = agent states as JSON |
| `item.*` `web_search` | `toolName` = `web_search`, input = `query`, output = `results` as JSON |
| `item.completed` `todo_list` | `todos.updated` (`completed` / `pending`); identical consecutive snapshots are deduplicated |
| `item.*` `error` | `warning` (message also kept as error evidence) |
| `turn.completed.usage` | `usage.updated` (`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens`, `totalTokens` = input + output) |
| `turn.failed.error.message`, `error.message` | `warning`, plus error evidence on the result |
| any other event or item type | `unknown` with `nativeType` and the raw line (never dropped) |
| a line that is not JSON | `output` on `stdout`, with the line number and parse error |
| an over-long line | `warning` naming the bytes the splitter dropped |

A tool item that completes without a start having been observed emits a synthetic
`tool.started` first, so every `tool.completed` has a matching open event. Blank lines
are ignored: the core splitter reports its own end-of-stream artifact as an "empty line"
parse error, which is not agent output.

Process exit classification (ADR-0014):

| Condition | `RunResult.handle.status` | `RunResult.error.code` |
|---|---|---|
| exit 0 | `succeeded` | — |
| `cancel()` called (signal) | `cancelled` | `run/cancelled` |
| killed after `timeoutMs` | `timeout` | `run/timeout` |
| non-zero, stderr matches rate limit / 429 / quota | `failed` | `run/rate-limited` |
| non-zero, stderr matches policy / refused / blocked / safety | `failed` | `run/policy-blocked` |
| any other non-zero exit or signal | `failed` | `run/agent-crashed` |

### How a run is invoked

```
codex exec --json -C <cwd> [-m <model>] [-s <sandbox>] [-c approval_policy="<mode>"]
           [--skip-git-repo-check] [resume <threadId>] [--] <prompt>
```

- `-C <cwd>` **and** the spawn working directory are set to the same resolved directory,
  so the session Codex records cannot drift from the directory the orchestrator chose.
- `-m` is passed when the request or the adapter's `model` setting names a model.
- `-s` is passed for a sandbox value; an approval mode is passed as the config override
  `-c approval_policy="…"` because `codex exec` has no approval flag. Both values are
  validated against the declared sets, and an undeclared value is refused with
  `schema/invalid` rather than silently dropped.
- `--skip-git-repo-check` is passed only when `git rev-parse --is-inside-work-tree`
  reports that the cwd is not a repository. A git that is missing produces a false
  negative, which is the harmless direction.
- The prompt is the final positional argument and is preceded by `--` when it starts
  with `-`.
- The environment is `config.env` layered under `request.env`, with `CODEX_HOME` always
  set to the home this adapter resolved. `envMode` comes from the config; the variable
  names in `RUN_INHERIT_ENV_KEYS` (`CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_API_KEY`,
  `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`) are passed through by name at every mode, so an
  environment-provided credential reaches Codex exactly as `authStatus()` reports it.
  MutiAgent never copies a secret out of `auth.json` into the child environment.
- `AdapterRun.argv` is the spawned argv with the prompt passed through the core
  redactor, so a credential pasted into a task never lands in the run record.

## Projection table — credentials (`authStatus`, `login`, `logout`)

| Native source | Canonical field |
|---|---|
| `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN` set | `source: "env"`, `status: "authenticated"`, `method: "api-key"` / `"access-token"`, `environmentKeys`, `detail` explaining it cannot be logged out |
| `auth.json` `tokens.id_token` / `access_token` | `source: "file"`, `method: "chatgpt-oauth"` (or the file's `auth_mode`) |
| id_token claims `email` / `chatgpt_user_id` | `account` |
| id_token claim `chatgpt_plan_type` | `plan` |
| id_token claim `exp` (decoded, **not verified**) | `expiresAt`; `exp` in the past → `status: "expired"` |
| `auth.json` `OPENAI_API_KEY`, `personal_access_token`, `agent_identity`, `bedrock_*` | `status: "authenticated"` with the matching `method` |
| `auth.json` present but unusable (not an object, or empty for a known mode) | `status: "misconfigured"` / `"unauthenticated"`, `source: "file"` |
| `auth.json` absent and `cli_auth_credentials_store = "keyring"` | `status: "unknown"`, `source: "keyring"` |
| `auth.json` absent otherwise | `status: "unauthenticated"`, `source: "none"` |
| — | `credentialPath`, `observedAt` always; never a token, key or header value |

Login delegation:

| Flow | Command | Secret channel |
|---|---|---|
| `oauth-loopback` | `codex login` | none (browser) |
| `device-code` | `codex login --device-auth` | none (URL + code surfaced in `interaction`) |
| `api-key` | `codex login --with-api-key` | **stdin only**, never argv |

`logout` runs `codex logout`. Every login and logout ends with a fresh `authStatus()`
whose result is what `state` reports; a non-zero exit is returned as `ok: false` with the
redacted output attached, not thrown. A flow outside the declared list throws
`auth/login-unsupported`.

## Declared losses

Every one of these is either attached to the object it affects as a `ProjectionNote`, or
carried in `RunResult.notes` for a run.

**Sessions**

1. A rollout compressed in place (`rollout-*.jsonl.zst`) cannot be decompressed in this
   version — no zstd dependency was added on purpose — so it is listed as
   `status: "unreadable"` with the reason (`field: "*"`), and `readTranscript` throws
   `session/unreadable`. Open the session in Codex to materialise the plain rollout.
2. A rollout whose head cannot be parsed is `status: "unreadable"` with the parse error;
   its `nativeId` then comes from the file name (`rollout-<ts>-<threadId>[_<rolloutId>]`).
3. `model` is read only from a `turn_context` line inside the 64 KiB head read; when none
   is there it is omitted with a note.
4. `updatedAt` is the title index's `updated_at` when present, else the rollout file
   modification time; which one was used is stated in a note.
5. `usage` is not read during listing (it lives in the rollout tail) — note.
6. `messageCount` is never reported: Codex records no such count, and counting would mean
   a full read — note.
7. `repoRoot` is not resolved during listing, which would cost one git spawn per session — note.
8. `createdAt` and `cwd` are omitted with a note when the header lacks them.
9. The header's `git.commit_hash` and `git.repository_url` have no canonical field — note.
10. `session_id` (when it differs from the thread id), `originator`, `cli_version`,
    `thread_source`, `agent_nickname`, `agent_role` and `model_provider` are read but have
    no canonical field — one note lists the ones actually present.
11. `source` for a sub-agent rollout is flattened to one token
    (`sub_agent:thread_spawn:parent_thread_id:…`); archived rollouts have ` (archived)`
    appended and carry a note.
12. `parentNativeId` prefers `parent_thread_id` and falls back to `forked_from_id`, which
    is stated in a note when it applies.
13. `status` is always `"idle"`: the native store records no in-flight state, and this
    adapter never infers one.
14. `binding` is empty MutiAgent state; nothing of it comes from Codex.

**Transcripts**

15. `totalMessages` is never reported (Codex records no message count).
16. Token usage is recorded on `token_usage` lines and turn boundaries, never per message,
    so no `AgentMessage.usage` is ever set — note.
17. A malformed line becomes an `unknown` message holding the raw line, and the count is
    declared in a note.
18. Records that carry no conversational content are not projected; the note names each
    native token with its count. Unknown *payloads* are still preserved as `unknown`
    messages.
19. Any single text field is capped at 16 KiB, and `AgentMessage.truncated` is set when
    the cap cut it.
20. The window is bounded (1 MiB tail by default, overridable per call), so `hasMore` and
    a note declare that older content exists.
21. Native envelope fields (`ordinal`, per-line `metadata`, `history_mode`,
    `base_instructions`, `dynamic_tools`, `runtime_workspace_roots`, …) are not projected;
    they carry no conversational content.
22. Reasoning `summary` and `raw_content` are joined into one text when both are present.

**Native tasks**

23. `status` can only be `pending`, `in_progress` or `completed`; Codex's checklist has no
    blocked or cancelled state — note.
24. `updatedAt` is the timestamp of the record that carried the list, not a per-item change
    time — note.
25. `blockedBy` is always empty: Codex expresses no item dependencies — note.
26. `plan.active` is inferred as `true` from the presence of a plan item; whether plan mode
    is still active is not recorded — note.
27. `plan.items` is the latest plan text, verbatim, as a single element.
28. Only the latest checklist inside the read window is returned.
29. A compressed rollout yields `{ todos: [], notes: [...] }` rather than `undefined`, so
    "nothing recorded" and "could not be read" stay distinguishable.

**Runs**

30. `interrupt` is not available: cancellation kills the process group and cannot continue
    the run (ADR-0003) — stated in every run's notes.
31. Assistant text arrives as prefix deltas *plus* one completed message; a consumer must
    apply those semantics rather than concatenating both — stated in every run's notes.
32. A rewritten (non-prefix) reasoning text emits no further delta.
33. Partial command output is not streamed: only `aggregated_output` at completion.
34. `file_change` change kinds (`add`/`delete`/`update`) have no canonical field; only paths
    are projected.
35. Approval requests can never be answered over this transport, so
    `approval.requested` is never emitted.
36. Native item and event types this adapter does not model are emitted as `unknown`
    events, and the run's note lists them.
37. When nothing is reading the event stream, the oldest non-terminal events are dropped
    past 4096 pending and the count is reported in the run's notes. The terminal
    `run.finished` event is never dropped, and `AdapterRun.result` settles whether or not
    `events` is consumed.
38. Tool inputs and outputs, and every text carried into an event, are capped at 8 KiB.
39. `RunResult.notes` is a list of strings by contract; the structured per-object notes
    live on sessions, messages and task state.

**Credentials**

40. Status is derived from files and environment variables only: `codex login status` is
    deliberately not spawned, so `source: "cli-probe"` is never returned and a
    keyring-only credential is `unknown` with `source: "keyring"`.
41. When an environment credential is present it wins as `source`, and `account`/`plan`
    are omitted because they belong to the stored credential, which is not the one in use.
42. `expiresAt` comes only from the id_token's `exp` claim (decoded, not verified); a token
    without one, or one that cannot be decoded, omits it with a `detail` explaining why.
43. Live output streaming during a login is impossible through the SPI's single
    `AuthOperationResult`, so `interaction` and `output` are reported after the CLI exits;
    the process is held open for up to 10 minutes (`loginTimeoutMs` configurable).
44. CLI output is redacted with a redactor seeded with the submitted secret and capped at
    4 KiB.
45. An environment credential cannot be logged out; MutiAgent never un-sets a variable.

## Adapter settings

Read from `AdapterRuntimeConfig.settings`; an unset entry is ignored and a present but
unusable one is warned about and ignored.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `transcriptTailBytes` | positive integer | `1048576` | Bytes read from the tail of a rollout for a transcript |
| `loginTimeoutMs` | positive integer | `600000` | Wall-clock budget for a delegated login |

## Usage

```ts
import { createCodexAdapter, CODEX_ID } from '@zorker/muti-agent-adapter-codex'

const adapter = createCodexAdapter(ctx) // ctx: AdapterContext from @zorker/muti-agent-core
registry.add(adapter)
```

## Layout

| File | Contents |
|---|---|
| `src/index.ts` | `CODEX_ID`, `CodexAdapter`, `createCodexAdapter`, run dispatch and settings |
| `src/sessions.ts` | Rollout discovery, head parsing, title index, transcript projection, native task extraction |
| `src/events.ts` | `codex exec --json` line → `AgentRunEvent` mapping, outcome classification, the run event queue |
| `src/auth.ts` | `auth.json` classification and `codex login` / `codex logout` delegation |
