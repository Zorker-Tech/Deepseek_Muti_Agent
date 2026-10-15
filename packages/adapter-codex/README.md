# `@zorker/muti-agent-adapter-codex`

The MutiAgent adapter for [OpenAI Codex](https://github.com/openai/codex). It implements
the `AgentAdapter` SPI from `@zorker/muti-agent-core` for the `codex` CLI: session
discovery and transcript reading from `$CODEX_HOME`, run dispatch through
`codex exec --json`, native checklist extraction, the model and provider catalog read from
Codex's own `config.toml`, and credential delegation to `codex login` / `codex logout`.

Its second face is `registerCodexLlm`: the same configuration read again as **runnable
harness model routes** (`codex:<provider-id>`), so Codex's own models can be selected and
called from the harness's model selector. That face is optional — a deployment without an
`llm` service simply does not call it.

Nothing here writes to a foreign store (ADR-0012). Rollouts, the title index, `auth.json`
and `config.toml` are opened read-only through `FileProbe`; the only mutations this adapter
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
  "listModels": true,               // read from config.toml and the project layers, never fetched
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

## Projection table — model catalog (`listModels`)

`listModels()` reads Codex's own configuration. It never runs the CLI, never fetches a
URL, never writes a file, and never reads a secret: a credential is reported only as the
name of the environment variable that carries it plus whether that name is set, or as the
presence of something in the Codex auth store. `model_catalog_url` is the network form of a
model list and is therefore *reported but never fetched*.

### Which files are read, in ascending precedence

| Order | File | Applied |
|---|---|---|
| 1 | `$CODEX_HOME/config.toml` | always; the user layer, and the only layer whose `[projects]` table decides trust. Always in `sources`, with `present: false` when absent |
| 2 | `[profiles.<name>]` inside that file, when the file sets `profile = "<name>"` | yes, folded on top of the same file; the source note names the profile |
| 3 | `$CODEX_HOME/<name>.config.toml` for each profile file that exists | **no**: Codex reads such a file only for a run started with `--profile <name>`, which `listModels()` cannot know. Reported with that reason |
| 4 | `<project>/config.toml` | only when `<project>` is trusted |
| 5 | `<dir>/.codex/config.toml` for `<project>` and every ancestor up to the file-system root, root first | only when that directory is trusted. The repository root's `.codex/config.toml` is covered by this walk whenever `<project>` sits inside a checkout |

`<project>` is the host process's own working directory, which is what `${PWD}` means to
Codex. A `.codex` directory equal to `$CODEX_HOME` is skipped, because that file is already
the user layer.

Trust comes from the user layer's `[projects."<abs path>"] trust_level` entries only: a
directory matches an entry for itself or for the nearest ancestor that has one, under the
path as written or under its canonical (symlink-resolved) spelling, which is how Codex
looks it up. A trusted layer is applied and its source note says so; a layer whose
directory is marked `untrusted`, or has no entry, is reported as present with the reason
and contributes nothing. Trust recorded by managed (MDM) configuration is not read here.

### What is projected

| Native source | Canonical field |
|---|---|
| `model`, highest-precedence layer winning | `defaultModel`, and one `AgentModel` with `isDefault: true`, `source: "config"` |
| `model_provider` (user and profile layers only) | `providerId` on the default model |
| `model_context_window` | `contextWindow` on the default model |
| `review_model` | one further `AgentModel`, `source: "config"` |
| `model_catalog_json`, a JSON file on this machine (relative paths resolve against the directory of the file that named it) | one `AgentModel` per `models[].slug`, `source: "catalog"`, with `display_name`, `context_window` and `supported_reasoning_levels[].effort` |
| `[model_providers.<id>]`, merged key by key across layers | one `AgentProvider`, `source: "config"`, from `name`, `base_url`, `env_key` → `apiKeyEnv` and `wire_api` |
| `env_key` | `apiKeyEnv` is the variable *name*; `credentialPresent` is whether that name is set in the host environment or in this adapter's configured `env` |
| `requires_openai_auth` (and the built-in `openai` provider) | `credentialPresent` from the Codex auth store, through the same read-only `readCodexAuthState` that `authStatus()` uses — never a value |
| the built-in provider ids | `openai`, `lmstudio`, `ollama`, `amazon-bedrock`, `amazon-bedrock-runtime` as `AgentProvider` rows with `source: "builtin"` (`RESERVED_MODEL_PROVIDER_IDS` in this revision); a configuration cannot replace one |
| any other key of `config.toml` | nothing; the names of the keys that were present are listed in one `notes` entry |

**Why the model list is only what configuration names.** Codex has no `models` table and no
offline list of ids: a model is identified by a free-form string that the Codex backend
resolves. `ConfigToml` carries at most a default `model`, a `review_model` and a local
`model_catalog_json`, so the catalog reports exactly those three sources and adds a note
saying so. A model Codex would accept but this machine's configuration never mentions
cannot appear in the catalog, and claiming otherwise would be an invention.

## Declared losses

Every one of these is attached to the object it affects as a `ProjectionNote`, carried in a
`RunResult.notes` list for a run, or — for a file that contributed nothing — stated on its
`sources` row.

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

**Model catalog**

46. Codex carries no built-in model list, so `models` holds only what this machine's
    configuration names (`model`, `review_model`, `model_catalog_json`); a note on every
    catalog says so.
47. `model_catalog_url` is never fetched — this adapter makes no network call — so the
    models it would list are absent and the URL is declared in a note.
48. A profile-v2 file (`$CODEX_HOME/<name>.config.toml`) is reported in `sources` but not
    applied: Codex reads it only for a run started with `--profile <name>`, and the SPI
    carries no profile selection. A legacy `[profiles.<name>]` table selected by the
    `profile` key *is* applied, and the source note names it.
49. A project-local layer is applied only when the user layer records the directory as
    trusted; an untrusted or unrecorded directory is reported with the reason, and a note
    warns that the default model may not be the one Codex would use there. Trust recorded
    by managed configuration is not read.
50. A project layer's `model_provider`, `model_providers`, `profile` and `profiles` are
    ignored exactly as Codex ignores them (`PROJECT_LOCAL_CONFIG_DENYLIST`), and the fact is
    declared in a note.
51. `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity` and
    `model_auto_compact_token_limit` select how a model runs rather than naming one, and the
    canonical catalog has no field for them; they are declared in one note.
52. Provider keys with no canonical field (`capabilities`, `query_params`, `http_headers`,
    `env_http_headers`, `env_key_instructions`, retries, timeouts, `requires_openai_auth`,
    `supports_websockets`) are declared in a note per provider.
53. `experimental_bearer_token` makes a provider count as credentialed, but its value is
    never read; `auth`, `aws` and `gateway_oauth` credentials are neither read nor run, and
    each is declared.
54. A configuration file larger than the 1 MiB read cap is not projected at all: TOML is
    line oriented, so a truncated prefix could parse and silently misreport values. The
    `sources` row names the cap.
55. An absent file, an unreadable file and a TOML parse failure each contribute nothing and
    carry the reason in their `sources` row; `listModels()` never throws for any of them, and
    a missing home is simply a set of absent files.
56. A local `model_catalog_json` file's fields without a canonical home (`visibility`,
    `supported_in_api`, `priority`, `description`, `shell_type`, …) are declared in a note,
    as is any entry that carries no `slug`.
57. `review_model` is listed as one more acceptable id because `AgentModel` has no purpose
    field; a note says it is the review model.
58. `defaultModel` is omitted when no layer names a model — the built-in default lives in
    Codex's code, not in configuration — and `providerId` is omitted when no layer names a
    provider, with a note explaining that a built-in default then applies.
59. Duplicate ids collapse into one row: the configured default keeps its `isDefault` and
    gains only what it lacked from a catalog file.

## Harness LLM routes (`registerCodexLlm`)

`registerCodexLlm(ctx, options)` turns the configuration this adapter already reads into
routes the **harness itself** can select and call, instead of only describing them to the
MutiAgent GUI. One read — the same `readCodexModelCatalog` `listModels()` uses, with a fact
sink for the two provider keys the canonical catalog has no field for — feeds both
registrations:

- `ctx.llm.registerAdapter(routes, adapter)` registers one adapter for every route below;
- `ctx.llm.registerConfigurableProviders(entries)` declares the same routes so the harness
  lists them (live or dormant) beside its own providers.

The returned object carries `providers` (the route keys), `notes` (every refusal, every
catalog gap, every route that cannot authenticate right now) and a `dispose()` that releases
both registrations. The response body is translated by `src/llm-responses.ts`; the SSE
framing, in-band error classification and attribution headers are the shared
`@zorker/muti-agent-llm-bridge` ones, the same code the Pi and Grok Build routes use.

| Concern | This adapter |
|---|---|
| Route key | `codex:<providerId>` — e.g. `codex:corp-gateway`, `codex:openai` |
| Why the prefix | a `[model_providers.*]` id may be `openai`, `deepseek`, … — names the harness ships; `codex:` keeps a user declaration from colliding with a shipped route, and makes the origin visible in the selector |
| Selector grouping | one provider per route, displayed as `Codex · <name>` (`Codex · OpenAI` for the built-in endpoint) |
| Routes registered | every `[model_providers.<id>]` entry that names a `base_url`, plus the built-in `openai` endpoint when the configuration names a model for it and the auth store holds a credential |
| Models offered | exactly the ids the configuration names (default `model`, `review_model`, `model_catalog_json`), with `display_name`, `contextWindow` and reasoning levels where the same read knows them |
| Endpoint | `<base_url>/responses`; the built-in route uses Codex's own default for the credential kind: `https://chatgpt.com/backend-api/codex` (ChatGPT) or `https://api.openai.com/v1` (API key) |
| Credential | the entry's `env_key` from the environment, resolved per request; a `requires_openai_auth` entry and the built-in route read `<home>/auth.json` per request, so a `codex login` reaches the next call without a restart |
| Request | `POST <base>/responses`, `store: false`, `stream: true`, `tool_choice: "auto"`, `parallel_tool_calls: true`, `prompt_cache_key` = the harness session id |
| Response | `block-start`/deltas/`block-end` per block, `usage` before exactly one `finish`; tool calls are assembled from `response.function_call_arguments.delta` |
| Settings namespace | `muti-agent` unless the host passes its own plugin entry id |

A route is registered even when its credential does not resolve right now: its identity is
the user's own declaration, the credential is resolved afresh on every request and on every
model listing, and the harness's configurable-provider directory is the surface built to
carry the reason. What such a route does *not* do is offer models — a selector must never
present something that cannot run. The built-in `openai` route is the reverse case: it is
this adapter's own route rather than a declaration, so it is registered only when the auth
store holds a credential, and skipped with a note when it does not.

### What the model selector shows

`listModels('codex:<id>')` returns the configuration's own ids for that route, in
configuration order, each with `inputModalities: ['text']`. `resolveModel` reports the
context window and reasoning levels the configuration knows (a `model_context_window`, a
`model_catalog_json` entry's `context_window` / `supported_reasoning_levels`), plus
`model_reasoning_effort` as the model's default effort when that level is one the model
declares. An id the configuration never mentions is still described and still dispatched:
the Codex backend, not this file, decides which ids exist.

Where a model's provider is not named per model, it is the configuration's `model_provider`,
and with none configured it is the built-in OpenAI provider — the way Codex routes them. A
model whose provider has no runnable route (a built-in `ollama`/`lmstudio`/Bedrock entry,
or a `[model_providers.*]` entry without a `base_url`) contributes a note rather than a
silent disappearance.

### The Responses wire this speaks

Request shape and event handling were verified against the Codex revision in the checkout
under test — `codex-rs/codex-api/src/sse/responses.rs` (the event decoder:
`response.created`, `response.output_item.added`/`done`, `response.output_text.delta`,
`response.reasoning_summary_text.delta` / `response.reasoning_text.delta`,
`response.completed` / `response.incomplete` / `response.failed`, the in-band `error`
event), `codex-rs/codex-api/src/common.rs` (`ResponsesApiRequest`),
`codex-rs/core/src/client.rs` (`build_responses_request`),
`codex-rs/core/src/context/base_instructions.rs`,
`codex-rs/tools/src/responses_api.rs` (the function-tool declaration), and
`codex-rs/protocol/src/models.rs` (`ResponseItem`, `ContentItem`).

Three deliberate divergences:

- Codex ignores `response.function_call_arguments.delta` and reads a call's arguments from
  the finished item. This adapter consumes both, so the harness can show a call while it is
  still being written; the finished item's arguments are appended only if they extend what
  streamed, so the assembled block can never contradict the deltas a consumer already saw.
- Codex fails a stream whose final record never terminated. The shared framing discards the
  half-written record too, but reports the truncation, and this module turns it into a
  `STREAM_CLOSED` failure naming it.
- Codex sends `reasoning.summary` and its own service tier; this adapter sends `reasoning`
  only when an effort is selected, and never sends a service tier or any other
  Codex-specific request field.

### Deliberately not supported, and why

- **Codex's other built-in providers** (`ollama`, `lmstudio`, the Bedrock entries). This
  adapter registers what the configuration names; those endpoints live in Codex's code, not
  in `config.toml`, and inventing a base URL for them would be this plugin guessing.
- **A `[model_providers.*]` entry without a `base_url`.** There is no endpoint to post to,
  so the route is not registered and the note names the missing key.
- **`experimental_bearer_token`.** A credential written into configuration is never read,
  not even to test it; the route is registered with a note telling the user to move it to
  `env_key`, and a request through it fails with `MISSING_CREDENTIAL`.
- **Image input.** Every route declares `inputModalities: ['text']`, so the harness projects
  images to placeholder text before dispatch. The wire accepts images; this adapter has no
  attachment access through the seam it speaks.
- **Reasoning content on the request side.** A reasoning block is never sent back, because
  the Responses wire accepts a reasoning item only together with the encrypted form the
  provider returned, and this adapter emits no `replayState` to carry it. A replayed turn
  re-sends the visible text and its tool calls.
- **Stop sequences.** The Responses request vocabulary has no `stop` field, so a request
  that names one is refused with `UNSUPPORTED_OPTION` instead of silently generating past
  the requested halt.
- **`deferLoading` tool declarations.** The harness hint is not translated: the route
  declares no `toolUpdate` mode, so every request declares the complete tool list, which is
  exactly what an ignored defer request produces.
- **Codex's `stream_idle_timeout_ms`, `request_max_retries` and `stream_max_retries`.** The
  shared transport enforces no idle bound; a stalled provider is bounded by the caller's
  `AbortSignal` and by the harness's own retry policy, which classifies a transport failure
  as retryable.
- **HTTP redirects.** The request is sent with `redirect: 'error'`: a credential may not be
  carried to a host the configuration never named.
- **`wire_api` values other than `responses`.** This revision of Codex accepts only
  `"responses"` and refuses anything else at load time; `models.ts` already declares such a
  value in a note.

### Verifying it

```sh
node --test packages/adapter-codex/tests/stub-provider.test.ts
node --test packages/adapter-codex/tests/registration.test.ts
```

Both bundle `src/llm.ts` with esbuild (the tool `scripts/build.mjs` uses, because by-name
workspace imports resolve to built `lib/` directories, not source). The first drives a
loopback stub endpoint that speaks the Responses stream — text deltas, a function call split
across three events, a usage-bearing `response.completed` — and asserts the exact
`StreamChunk` sequence, the request body, and the failure codes for a truncated stream, an
in-band failure and an unsupported option. The second mounts the harness's real `LlmRuntime`
on a bare `Context`, registers through it, and asserts the provider directory, the model
listing, exact-model resolution, a prepared call's materialized reasoning default, the
streamed chunk sequence, and that `dispose()` empties both registries.

## Adapter settings

Read from `AdapterRuntimeConfig.settings`; an unset entry is ignored and a present but
unusable one is warned about and ignored.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `transcriptTailBytes` | positive integer | `1048576` | Bytes read from the tail of a rollout for a transcript |
| `loginTimeoutMs` | positive integer | `600000` | Wall-clock budget for a delegated login |

`listModels()` takes no settings: it reads at most 1 MiB from each candidate file, takes the
working directory from the host process (there is no per-call `cwd` in the SPI), and adds
`config.env` to the host environment when it tests whether a provider's `env_key` is set,
because a run started by this adapter would receive that variable too.

## Usage

```ts
import { createCodexAdapter, CODEX_ID } from '@zorker/muti-agent-adapter-codex'

const adapter = createCodexAdapter(ctx) // ctx: AdapterContext from @zorker/muti-agent-core
registry.add(adapter)
```

Registering the Codex models as harness routes, in a composition that mounts an `llm`
service:

```ts
import { registerCodexLlm } from '@zorker/muti-agent-adapter-codex'

const registration = await registerCodexLlm(
  { llm: ctx.llm },
  { homeDir: ctx.config.homeDir, env: process.env, cwd: process.cwd() },
)
// registration.providers, registration.notes, registration.dispose()
```

## Layout

| File | Contents |
|---|---|
| `src/index.ts` | `CODEX_ID`, `CodexAdapter`, `createCodexAdapter`, run dispatch and settings; the `registerCodexLlm` surface re-exported |
| `src/sessions.ts` | Rollout discovery, head parsing, title index, transcript projection, native task extraction |
| `src/events.ts` | `codex exec --json` line → `AgentRunEvent` mapping, outcome classification, the run event queue |
| `src/auth.ts` | `auth.json` classification and `codex login` / `codex logout` delegation |
| `src/models.ts` | `config.toml` layer discovery, TOML parsing (`smol-toml`), and the model/provider catalog projection |
| `src/llm.ts` | `codex:<id>` routes: configuration → plan, the adapter, and both harness registrations |
| `src/llm-responses.ts` | The Responses request body and the event-stream translator onto `StreamChunk` |
| `src/llm-credentials.ts` | Read-only `auth.json` bearer resolution for `requires_openai_auth` routes |
