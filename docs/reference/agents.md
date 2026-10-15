# Agent integration facts

What MutiAgent verifies about each integrated agent, per adapter, with the file each fact came from. Every statement here was read from the adapter source: `packages/adapter-codex/src/{index,sessions,events,auth}.ts`, the same four files for `-grok` and `-pi`, and each adapter's README. Where an adapter README and its code disagree, the code is what runs.

The verified agent versions are at the end of this file. Native formats are another product's; they change without notice, and every reader here degrades a field rather than crashing when one does.

## Shared detection machinery

All three adapters detect the same way, through `packages/core/src/discovery/detect.ts`:

| Step | Rule |
|---|---|
| Binary | `resolveBinary(name, { candidates: [config.binaryPath] })`: the configured path first (`source: 'config'`), then each `PATH` entry (`'path'`), then `~/.local/bin`, `~/.cargo/bin`, `~/.bun/bin`, `/usr/local/bin`, `/opt/homebrew/bin` (`'well-known'`). A found path is passed through `realpath` when it resolves. |
| Version | `probeVersion(process, binaryPath)`: run `<binary> --version` with `envMode: 'minimal'`, 10 s timeout, from the user's home directory, and take the first non-empty line of stdout, else of stderr, verbatim. No parsing, because these strings are versioned by their own products. |
| Home | `resolveHome({ override, envName, defaultName })`, resolved against the process cwd when relative. Each adapter adds its own rule on top (below). |
| Result | `detectionFrom(resolution, { version?, homeDir? })` builds the `AgentDetection`: `installed: false`, `source: 'none'` and a `reason` line when nothing was found. |

## Codex

### Detection

| Concern | Rule, from `packages/adapter-codex/src/{index,sessions}.ts` |
|---|---|
| Binary name | `codex` (`CODEX_ID`). |
| Home | `config.homeDir` first; else `$CODEX_HOME` **only when it names a directory**; else `~/.codex` (`CODEX_DEFAULT_HOME_DIR`). A `$CODEX_HOME` set to a non-directory is logged and the default is used; a relative result is replaced by `<os home>/.codex`. |
| Home layout | `sessionsRoot` = `<home>/sessions`, `archivedRoot` = `<home>/archived_sessions`, `indexFile` = `<home>/session_index.jsonl`, `credentialFile` = `<home>/auth.json`. |
| Version probe | `codex --version`. |
| Caching | `describe()` resolves detection once and caches it; a detection failure is not cached, so installing the binary does not require a restart. |

### Session store

Rollout files named `rollout-*.jsonl` (or `rollout-*.jsonl.zst`) are discovered under both `sessions/` and `archived_sessions/`, walked to 4 directory levels with a 5,000-file cap per root, newest modification time first. Nothing about the directory layout below the root is assumed, and the thread id is recovered from the file name (`rollout-<19 chars>-<threadId>[_<rolloutId>]`) only as a fallback.

Each rollout is an append-only JSONL log:

| Line | What it carries, and what the adapter takes from it |
|---|---|
| first `session_meta` | Identity and git state: `id`, `session_id`, `forked_from_id`, `parent_thread_id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `thread_source`, `agent_nickname`, `agent_role`, `model_provider`, `git.branch`, `git.commit_hash`, `git.repository_url`. Payload is accepted flat or under a `meta` wrapper. |
| first `turn_context` in the head read | `model` — the only cheap way to learn a session's model without reading the tail. |
| `response_item`, `event_msg`, `compacted`, `inter_agent_communication` | Transcript records; see the README's projection table for the full mapping. |
| `token_usage`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `realtime_item`, `inter_agent_communication_metadata` | No conversational content; not projected, and the count per native token is declared in a note. |

| Read | Window | Cap |
|---|---|---|
| Listing | Head of each rollout, 64 KiB (`SESSION_HEAD_BYTES`) | Title index read capped at 4 MiB; rollouts per root 5,000. |
| Transcript | Tail, 1 MiB by default (`DEFAULT_TRANSCRIPT_TAIL_BYTES`), overridable per call and by the `transcriptTailBytes` setting | Any single text field capped at 16 KiB with `truncated` set. |
| Native tasks | Tail, 1 MiB (`DEFAULT_TASK_TAIL_BYTES`) | — |

Title lookup folds `<home>/session_index.jsonl` (append-only; the newest entry per thread id wins) for `thread_name` and `updated_at`. A rollout compressed in place (`.zst`) is listed as `status: 'unreadable'` with the reason, and `readTranscript` throws `session/unreadable`: this adapter adds no zstd dependency on purpose, and opening the session in Codex materialises the plain rollout.

### Auth

| Concern | Rule, from `packages/adapter-codex/src/auth.ts` |
|---|---|
| Credential file | `<home>/auth.json`, read only. Recognized material: `tokens.id_token`, `tokens.access_token`, `OPENAI_API_KEY`, `personal_access_token`, `agent_identity`, `bedrock_api_key` / `bedrock_access_keys`, with `auth_mode` naming the mechanism. |
| Env vars | `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY` (`CODEX_CREDENTIAL_ENV_KEYS`). An env credential wins as `source: 'env'` and is reported as not loggable-out. |
| Status probe | File and environment only. `codex login status` is deliberately **not** spawned, so `source: 'cli-probe'` never occurs. `auth.json` absent plus `cli_auth_credentials_store = "keyring"` in `<home>/config.toml` (head read, 256 KiB) yields `status: 'unknown'`, `source: 'keyring'`. |
| Account and plan | Decoded from the id_token's claims, **not verified**: `email` / `chatgpt_user_id` → `account`, `chatgpt_plan_type` → `plan`, `exp` → `expiresAt` (in the past → `status: 'expired'`). |
| Login | `codex login` (oauth-loopback), `codex login --device-auth` (device-code), `codex login --with-api-key` (api-key; the key goes on **stdin**, never argv). Declared flows: those three. Budget 10 min, configurable. |
| Logout | `codex logout`. Budget 60 s. |
| Output | Every login/logout ends with a fresh `authStatus()`; `state` is that result, never the intent. CLI output is redacted with a redactor seeded with the submitted secret and capped at 4 KiB. A non-zero exit is `ok: false` with the output attached, not a throw. |

### Config

Adapter settings under `AdapterRuntimeConfig.settings`, from `parseCodexSettings`: `transcriptTailBytes` (positive integer, default `1048576`) and `loginTimeoutMs` (positive integer, default `600000`). The shared keys apply too: `enabled`, `binaryPath`, `homeDir`, `env`, `envMode`, `timeoutMs`, `model`. An unset setting is omitted; a present but unusable one is warned about and ignored.

### Headless run invocation

```
codex exec --json -C <cwd> [-m <model>] [-s <sandbox>] [-c approval_policy="<mode>"]
           [--skip-git-repo-check] [resume <threadId>] [--] <prompt>
```

- `-C <cwd>` and the process working directory are the same resolved directory, so the session Codex records cannot drift from what the orchestrator chose.
- `-m` is passed when the request or the adapter's `model` setting names one.
- An approval mode becomes the config override `-c approval_policy="…"` because `codex exec` has no approval flag. Both sandbox and approval are validated against the declared sets; an undeclared value is refused with `schema/invalid`.
- `--skip-git-repo-check` is passed only when `git rev-parse --is-inside-work-tree` says the cwd is not a repository; a missing git produces a false negative, which is the harmless direction.
- The prompt is the final positional argument, preceded by `--` when it starts with `-`.
- Environment: `config.env`, then `request.env`, then `CODEX_HOME` last, so a run can never resolve a different home than the one inspected. `RUN_INHERIT_ENV_KEYS` — `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `CODEX_HOME`, `CODEX_SQLITE_HOME`, `OPENAI_API_KEY`, sorted — is passed through by name at every `envMode`.
- `AdapterRun.argv` is the spawned argv with the prompt passed through the core redactor; the run record never keeps a credential-shaped substring.

Events come from `codex exec --json` (one JSON object per stdout line). Classification of the finished process: exit 0 → `succeeded`; cancellation → `run/cancelled`; timeout → `run/timeout`; non-zero with rate-limit evidence → `run/rate-limited`; with policy evidence → `run/policy-blocked`; otherwise `run/agent-crashed`. Two notes are attached to every run: assistant text arrives as item-level deltas plus one completed message (a consumer must apply those semantics, not concatenate both), and interrupt is unavailable in this transport.

### Resume

`codex exec … resume <threadId> <prompt>`: the `resume` subcommand is placed after every option and before the prompt, which is the only position the CLI's parser accepts for all of them.

### Native todos and plan

Supported (`nativeTodos: true`, `nativePlan: true`), read from the rollout tail; the latest record in the read window wins.

| Native source | Canonical |
|---|---|
| `event_msg:plan_update` / `turn_plan_updated`, payload `plan[].step` + `status` | `todos[].content`, `todos[].status` |
| `response_item:function_call` named `update_plan`, arguments `{"plan":[…]}` | same |
| item/payload type `todo_list`, `items[].text` + `completed` | `todos[]`, `completed` → `completed`, else `pending` |
| item type `Plan` (`{id, text}`) | `plan.items`: the latest plan text; `plan.active: true` |

Declared losses: statuses are limited to `pending`, `in_progress` and `completed` (Codex has no blocked or cancelled checklist state); `updatedAt` is the carrying record's timestamp; `blockedBy` is always empty; `plan.active` only means a plan item exists in the read window.

### Sandbox and approval

| | Values |
|---|---|
| `sandboxProfiles` | `read-only`, `workspace-write`, `danger-full-access` |
| `approvalModes` | `on-request`, `never` |

### Native launch

`codex` (fresh session) or `codex resume <threadId>`. Before the first `describe()` the command is the bare name `codex`, which resolves through `PATH` exactly as a user's shell would.

### Capability declaration

| Flag | Declared for Codex |
|---|---|
| `runModes` | `['headless-exec']` |
| `streaming` | `true` |
| `resume` | `true` |
| `interrupt` | `false` — `codex app-server` can interrupt a turn, but this adapter speaks only `codex exec` |
| `listSessions` | `true` |
| `readTranscript` | `true` |
| `nativeTodos` | `true` |
| `nativePlan` | `true` |
| `externalWorktree` | `false` — Codex can run in a worktree it created (`--worktree`), not one MutiAgent made |
| `mcpClient` | `true` — Codex reads `mcp_servers` from its own config |
| `listModels` | `false` |
| `sandboxProfiles` | `['read-only', 'workspace-write', 'danger-full-access']` |
| `approvalModes` | `['on-request', 'never']` |
| `credentials` | `{ status: true, login: ['oauth-loopback', 'device-code', 'api-key'], logout: true }` |

Transports reported by `describe()`: `headless-exec` → `codex exec --json`, available; `duplex-protocol` → `codex app-server --stdio (duplex transport planned)`, not available. `AgentTransport` has no note field, so the reason travels inside `mechanism`.

## Grok Build

### Detection

| Concern | Rule, from `packages/adapter-grok/src/{index,sessions}.ts` |
|---|---|
| Binary name | `grok` (`GROK_ID`), displayed as `Grok Build`. |
| Home | `config.homeDir` first; else `$GROK_HOME` verbatim when non-empty; else `<HOME>/.grok` (grok resolves no XDG path). A `$GROK_HOME` value is taken as given, not checked for being a directory. |
| Session root | `<home>/sessions`. |
| Credential path | `$GROK_AUTH_PATH` when set and non-empty, else `<home>/auth.json`. |
| Version probe | `grok --version`. |
| Failure behavior | Detection never rejects: a missing binary still yields a descriptor with `installed: false` and the resolution reason. |

### Session store

`<home>/sessions/<encoded-cwd>/<session-id>/`, where the cwd level is `encodeURIComponent(cwd)` or, when the encoded name exceeds 255 bytes, a `{slug}-{blake3_hex16}` name with a `.cwd` marker file holding the real path. Session ids are UUIDv7. A cwd directory is decoded by trying percent-decoding and falling back to reading `.cwd`.

| File in the session directory | Role |
|---|---|
| `summary.json` | Authoritative metadata. Projected onto `AgentSession`: `info.id`, `info.cwd`, `session_summary`, `created_at`, `updated_at`, `num_messages`, `num_chat_messages`, `current_model_id`, `parent_session_id`, `session_kind`, `hidden`, `source_workspace_dir`, `git_root_dir`, `head_branch`, `generated_title`, `title_is_manual`, `worktree_label`, `sandbox_profile`. `reasoning_effort` and `last_turn_summary` are parsed but not projected (no canonical field), alongside `git_remotes`, `request_id`, `grok_home`, `previous_cwd`, `chat_format_version`, `context_window`, `cwd_generation` and the flattened `agent_name`/`agent_profile`, which are not read at all. |
| `updates.jsonl` | The authoritative ACP update stream. Persisted lines are `{timestamp, method, params}` with `method` in `session/update`, `_x.ai/session/update`; legacy unenveloped notifications are accepted too. |
| `chat_history.jsonl` | A derived model-message cache, used only when `updates.jsonl` is absent or empty, and the substitution is declared as a note. |
| `plan.json` | The todo map: `todos` keyed by native id, each with `content` and `status`. |
| `plan_mode.json` | Plan-mode lifecycle: `state` (`Active`, `Inactive`, and transient values). |
| `usage.json` | `session` object in camelCase; `costUsdTicks` is converted with `/ 1e10`. |
| `.cwd` | The real cwd, for long-path session directories. |

Reads: the transcript window is the newest 1 MiB of `updates.jsonl` (or `maxBytes`), capped at 16 KiB per projected field; malformed lines are counted, not thrown. `session_search.sqlite` is deliberately not read: it is a rebuildable cache and reading it would cost a SQLite dependency.

### Auth

| Concern | Rule, from `packages/adapter-grok/src/auth.ts` |
|---|---|
| Credential file | `$GROK_AUTH_PATH` or `<home>/auth.json`: a map keyed by scope string, where the scope is `xai::api_key`, the legacy `https://accounts.x.ai/sign-in`, or an OIDC issuer URL. An entry carries `key`, `auth_mode` (`web_login`, `oidc`, `external`, `api_key`), `expires_at`, `email`, `team_name`, `refresh_token`. Token values are reduced to presence booleans in-process; nothing in the module returns a secret. |
| Env vars | `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, `GROK_AUTH`, `GROK_DEPLOYMENT_KEY`, checked in that order. An env credential wins as `source: 'env'`. |
| Status probe | Store first, entry chosen by rank (a usable account login, then a refreshable one, then `xai::api_key`, then any entry with a key). Only when the store and the environment are both empty does it spawn `grok models` and read the first line of stdout as a banner — `You are using XAI_API_KEY`, `You are authenticated via deployment key`, `You are logged in with …`, `You are not authenticated`, or `Model '…' is using its own API key.` — reported as `source: 'cli-probe'`. Disable with the `probeCli: false` setting. |
| Login | `grok login --oauth` for `oauth-loopback`, `grok login --device-auth` for `device-code`. Budget 300 s; the URL and device code are parsed out of the CLI output into `interaction`. `api-key` is **not** declared: `grok login` has no `--api-key` flag, and an explicit request returns `{ok: false, interaction: {kind: 'stdin-secret', …}}` with a fresh status rather than a faked success. The `interactive` flow returns `{kind: 'none'}` guidance to run `grok login` in a terminal. |
| Logout | `grok logout`, 30 s budget. A deployment key or an environment credential cannot be revoked; the state says so. |
| Output | Redacted and capped at 8 KiB; a non-zero exit is reported, not thrown. |

### Config

Adapter settings: `probeCli` (boolean; `false` disables the `grok models` banner probe), `sandbox` (default `--sandbox` profile and `GROK_SANDBOX` for children), `approval` (default approval mode), `reasoningEffort`, `maxTurns`, and the booleans `noPlan`, `noSubagents`, `disableWebSearch`. Shared keys: `binaryPath`, `homeDir`, `env`, `envMode`, `timeoutMs`, `model`.

### Headless run invocation

```
grok -p <prompt> --output-format streaming-json --cwd <cwd> [-m <model>] [--sandbox <profile>]
     [--always-approve | --permission-mode <mode>] [--max-turns <n>] [--reasoning-effort <e>]
     [-r <session-id>] [--no-plan] [--no-subagents] [--disable-web-search]
```

- When the prompt starts with `-`, the form is `--single=<prompt>` instead of `-p <prompt>`, because clap reads a leading `-` as a flag and `--single` has no `allow_hyphen_values`.
- `--cwd <cwd>` is always passed: grok records the session's cwd in `summary.json`, so the record must match what MutiAgent asked for, not the process cwd.
- `--permission-mode <mode>` is passed for every declared mode except `bypassPermissions`, which becomes `--always-approve`. When no approval is requested, grok's own configured permission mode applies and a note says so.
- `--sandbox` comes from the request, else the `sandbox` setting; when a resume passes no sandbox, the session's recorded profile applies (a note says so).
- `--no-plan`, `--no-subagents` and `--disable-web-search` are passed when configured, but headless grok only records them: the interactive pager is what applies them, and a note states that.
- Environment: `GROK_HOME` (always), `GROK_AUTH_PATH` (only when it differs from `<home>/auth.json`), `GROK_SANDBOX` (when a sandbox is configured), then `config.env`, then the request's `env`. `GROK_MANAGED_ENV_KEYS` (`GROK_HOME`, `GROK_AUTH_PATH`, `GROK_SANDBOX` plus the four credential variables) is the runner's `inheritKeys`.
- The native session id comes from the `end` line's `sessionId`, else from a before/after snapshot of `<sessionRoot>/*/*`; when neither yields one, no `session.bound` is emitted, a `warning` is emitted, and the run is recorded as unbound and therefore not resumable.
- Failure classification: cancellation → `run/cancelled`; timeout → `run/timeout`; grok's own "cannot resume this session under sandbox profile" refusal → `run/policy-blocked`; rate-limit evidence → `run/rate-limited`; unauthenticated evidence → `auth/not-configured`; other policy evidence → `run/policy-blocked`; otherwise `run/agent-crashed`.

### Resume

`-r <session-id>` on the same command line. Nothing else changes; when no explicit sandbox or approval is given, the session's recorded values apply and notes record it.

### Native todos and plan

Supported (`nativeTodos: true`, `nativePlan: true`), read from the session directory rather than a stream.

| Native source | Canonical |
|---|---|
| `plan.json` `todos` map, preserving file order | `todos[]`; `id` = `grok-<fnv1a32(nativeKey)>`; `content` falls back to the key; `status` maps `pending`/`in_progress`/`completed`/`cancelled` 1:1 and anything else to `pending`; `updatedAt` = `plan.json` mtime; `owner` = `grok`; `observedIn` = the canonical session key; `nativeKey` = the map key |
| `plan_mode.json` `state` | `plan.active` is `true` only for `Active`; `plan.items` is every todo's content, because `plan_mode.json` has no phase titles of its own |

Declared losses: `blockedBy` is always empty (grok's todo model has no dependency edges); `plan.json`'s `priority` and opaque `meta` are dropped; `plan.md` is not read; a transient `plan_mode` state is noted as not a durable activity signal.

### Sandbox and approval

| | Values |
|---|---|
| `sandboxProfiles` | `off`, `workspace`, `devbox`, `read-only`, `strict` |
| `approvalModes` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan` |

### Native launch

`grok` (fresh session) or `grok --resume <session-id>`.

### Capability declaration

| Flag | Declared for Grok Build |
|---|---|
| `runModes` | `['headless-exec']` |
| `streaming` | `true` |
| `resume` | `true` |
| `interrupt` | `false` — the headless transport is one-shot: cancellation kills the process group |
| `listSessions` | `true` |
| `readTranscript` | `true` |
| `nativeTodos` | `true` |
| `nativePlan` | `true` |
| `externalWorktree` | `false` — grok can create its own worktree, but MutiAgent always creates it and passes `--cwd` |
| `mcpClient` | `true` |
| `listModels` | `true` |
| `sandboxProfiles` | `['off', 'workspace', 'devbox', 'read-only', 'strict']` |
| `approvalModes` | `['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan']` |
| `credentials` | `{ status: true, login: ['oauth-loopback', 'device-code', 'interactive'], logout: true }` |

Transports reported by `describe()`: `headless-exec` → `grok -p --output-format streaming-json`, available; `duplex-protocol` → `grok agent stdio (ACP JSON-RPC) — known but not implemented in v0.1; every dispatch uses the headless transport`, not available.

## Pi

Pi is `@earendil-works/pi-coding-agent`, binary `pi`, session file format version 3 (`PI_SESSION_VERSION` in `packages/adapter-pi/src/sessions.ts`).

### Detection

| Concern | Rule, from `packages/adapter-pi/src/{index,sessions}.ts` |
|---|---|
| Binary name | `pi` (`PI_BINARY`). |
| Agent dir | `config.homeDir`; else `$PI_CODING_AGENT_DIR`; else `~/.pi/agent`. |
| Session directory override | Adapter setting `sessionDir`, then `$PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in `<agent-dir>/settings.json`. This is not a second root: it is the directory that directly holds session files, replacing the per-cwd subdirectory for every project. |
| Default sessions root | `<agent-dir>/sessions`. |
| Credential path | `<agent-dir>/auth.json`; settings at `<agent-dir>/settings.json`. |
| Version probe | `pi --version`. |
| Caching | `describe()` caches the descriptor once built. |

### Session store

```
<agent-dir>/sessions/--<flattened-cwd>--/<timestamp>_<sessionId>.jsonl
```

The flattened cwd is `'--' + absoluteCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'`; with an override, session files sit directly in the override directory and the reader reads that directory flat. Both layouts are scanned, because a machine that switched layouts keeps sessions in both; the directory name is only a hint and the header's own `cwd` is authoritative. Session ids are the part of the file name after the last `_`.

The file is a header line followed by append-only entries forming a tree (`id` / `parentId`). A branch switch appends an entry whose `parentId` is not the previous line's `id`, so the live conversation is the chain ending at the **last** line, never file order; entries on abandoned branches are excluded and counted in a note.

| Native entry | Projection |
|---|---|
| header | `id`, `cwd` (authoritative), `timestamp`, `parentSession`, and the version |
| `message` role `user` | `user`/`user`, text blocks joined; image blocks counted in a note |
| `message` role `assistant` | one message per block: `text` → `assistant`/`assistant`, `thinking` → `assistant`/`reasoning`, `toolCall` → `assistant`/`tool-call` |
| `message` role `toolResult` | `tool`/`tool-result`, `failed` from `isError` |
| `message` role `bashExecution` | `tool`/`tool-result`, tool `bash`, `input` = the command |
| `message` role `custom`, entry `custom_message` | `user` when `display` is true, else `system`; `nativeType` keeps the extension's `customType` |
| `compaction`, `branch_summary` | `system`/`system` with the summary text |
| `session_info` | the title: the latest `name` in the window wins, and an empty name clears it |
| `model_change` | `model` (latest in the window), with the provider noted as having no canonical field |
| `thinking_level_change`, `usage`, `label` | state folded into the summary; no message |
| `context_edit` | **not applied**: recorded content is shown and edits are counted in a note |
| an unmodelled entry type | no message; named in a note |

There is no session index: enumeration is a directory scan, bounded at 200 directories, 400 files per directory and 1,500 files per scan, with any cap that was hit reported as a note. Reads are bounded: 64 KiB for a header, the whole file at or below 256 KiB, head + tail above that, and a transcript window of 512 KiB by default (minimum 64 KiB, maximum 8 MiB).

### Auth

| Concern | Rule, from `packages/adapter-pi/src/auth.ts` |
|---|---|
| Credential file | `<agent-dir>/auth.json`: `Record<providerId, {type: 'api_key', key?, env?} \| {type: 'oauth', access, refresh, expires, …}>`. A `key` starting with `!` is a command reference: it is reported as `<provider>(command)` and never executed or read. Nothing writes, locks or rewrites the file. |
| Env vars | `PI_PROVIDER_ENV_VARS` (42 names), the provider-key list pi resolves from, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, plus Amazon Bedrock's own (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`, …). Ambient sources pi also supports (AWS IAM profiles, Google ADC) are deliberately absent, matching pi's own `findEnvKeys`, which excludes them because presence alone cannot classify them. |
| Status | File-first and file-only: a usable `oauth` (expires in the future) or `api_key` entry → `authenticated`/`source: 'file'`; only expired OAuth → `expired` (pi refreshes it on the next request, so this is not "logged out"); a provider env key → `authenticated`/`source: 'env'`; an unparsable file → `misconfigured`; otherwise `unauthenticated`. `source: 'cli-probe'` is never used: `pi auth check` costs a process start for what the file already says. |
| Login | **No non-interactive path.** `/login` exists only inside Pi's TUI, and this adapter never drives a TUI (ADR-0003), so the declared flow is `interactive` and the operation returns `{ok: false, interaction: {kind: 'none', instructions: PI_LOGIN_INSTRUCTIONS}, state}`. The secret parameter is never used. |
| Logout | Same situation: `{ok: false, interaction: {kind: 'none', instructions: PI_LOGOUT_INSTRUCTIONS}, state}`. `pi auth print-api-key` and `print-bearer-token` exist and are deliberately never called, because they would print a secret. |

### Config

Adapter settings: `sessionDir` (string, unset by default) and `inheritCredentialEnv` (boolean, default `false` — the explicit opt-in ADR-0014 requires before provider credentials are forwarded to a child). Unknown keys are ignored rather than rejected.

### Headless run invocation

```
pi --mode json [--session <file> | --session <id> | --session-id <generated-id>]
   [--provider <provider>] [--model <model>] [--approve]
```

- The prompt is written to the child's **stdin**, never argv, which keeps it out of the process table and out of `ARG_MAX`. `--append-system-prompt` is deliberately unused: the orchestrator's context block is already part of the prompt text, so a run stays reproducible from the prompt alone.
- A new run gets `--session-id <id>` with a uuid-v7-shaped id this adapter generates.
- A model in `provider/id` form is split into `--provider` and `--model`; anything else is passed to `--model` verbatim, because a bare fuzzy pattern is legal in pi and guessing would select a different model.
- `--approve` is passed only when `approval` is `approve`; `default` passes no flag, so pi's own trust store decides.
- Environment: `PI_CODING_AGENT_DIR` always, `PI_CODING_AGENT_SESSION_DIR` whenever an override is in force, then `config.env`, then the request's `env`. Provider credentials are not forwarded by default.
- Events: `run.started` → `session.bound` (from the stream's first header record) → mapped events → exactly one `run.finished`. `--mode json` emits delta-only content, so `message_update` maps to `message.delta`/`reasoning.delta`/`tool.started`, and `tool_execution_start` is deduplicated by call id. Idle is `agent_settled`, not `agent_end` (a turn can retry after `agent_end`); a stream that ends without `agent_settled` carries a note.
- Failure classification, in code order: cancellation → `run/cancelled`; timeout → `run/timeout`; a process that never reported an exit (spawn failure) → `run/start-failed`; non-zero exit classified from stderr (`no session found matching` → `session/not-found`; credential evidence → `auth/not-configured`; rate-limit evidence → `run/rate-limited`; otherwise `run/agent-crashed`); exit 0 with a stream stop reason of `error` → `run/agent-crashed` (Pi's JSON mode exits 0 even when the last response failed); exit 0 with **no session header at all** → `run/context-unavailable`, which is the signature of an unanswerable interactive question; a stream-reported abort → `run/cancelled`.
- An empty prompt is warned about, because pi would exit 0 without doing work; a requested sandbox profile is warned about and ignored, because `sandboxProfiles` is empty.

### Resume

`--session <file>` when the adapter resolved the session file for the id, else `--session <id>` for pi's own lookup. The path form is the reliable one: with a bare id pi asks an interactive "fork this session into current directory?" question when the session's project differs from the process cwd, and with stdin closed that question is never answered — pi exits 0 having done nothing. A resume whose recorded `cwd` differs from the requested `cwd` is refused **before spawning**, as a classified `run/context-unavailable` failure with remediation, because the path form cannot cross projects either.

### Native todos and plan

Not supported. `readNativeTasks()` returns `undefined`: Pi has no todo tool (its built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) and no plan mode (its README says it skips features like sub-agents and plan mode). Pattern-matching extension `custom` entries was rejected on purpose — a list scraped out of some extension's private entry is not a native task model, and pretending otherwise would make the shared board lie.

### Sandbox and approval

| | Values |
|---|---|
| `sandboxProfiles` | none — `[]`. Pi has no built-in permission system and runs with the launching user's permissions; a requested profile is warned about and ignored. |
| `approvalModes` | `default`, `approve`. `default` means "obey pi's own trust store"; `approve` passes `--approve`. |

### Native launch

`pi [--session-dir <dir>] [--session <id>]`, where `--session-dir` is included whenever the adapter resolved a session directory itself, and `--resume` is deliberately unused because it opens an interactive picker. A launcher must export `PI_CODING_AGENT_DIR` when a `homeDir` override is set, because argv cannot carry it.

### Extra beyond the SPI

`capabilities().listModels` has no SPI method, so `PiAdapter.listModels(search?)` is an adapter-specific extra: it runs `pi --offline --list-models [search]` (offline so the probe neither refreshes catalogs nor blocks on the network; 20 s cap) and parses the table into `{ provider, id, contextWindow?, maxOutput?, thinking, images }` rows. Rows are accepted only after pi's `provider  model  …` header, so the credential guidance pi prints when it has no usable provider is reported as a note instead of being read as models.

### Capability declaration

| Flag | Declared for Pi |
|---|---|
| `runModes` | `['headless-exec']` |
| `streaming` | `true` |
| `resume` | `true` |
| `interrupt` | `false` — `pi --mode json` cannot abort one turn and keep the session |
| `listSessions` | `true` |
| `readTranscript` | `true` |
| `nativeTodos` | `false` |
| `nativePlan` | `false` |
| `externalWorktree` | `false` |
| `mcpClient` | `true` |
| `listModels` | `true` |
| `sandboxProfiles` | `[]` |
| `approvalModes` | `['default', 'approve']` |
| `credentials` | `{ status: true, login: ['interactive'], logout: false }` |

Transports reported by `describe()`: `headless-exec` → `pi --mode json`, available; `duplex-protocol` → `pi --mode rpc (JSONL commands on stdin, responses and events on stdout)`, not available.

## Choosing an agent

| | Codex | Grok Build | Pi |
|---|---|---|---|
| Isolation | MutiAgent worktree via `-C` and the child cwd; `externalWorktree: false` | MutiAgent worktree via `--cwd`; `externalWorktree: false` | MutiAgent worktree via the child cwd; `externalWorktree: false` |
| Streaming | yes (`codex exec --json`, JSONL `ThreadEvent`) | yes (`--output-format streaming-json`, NDJSON) | yes (`--mode json`, JSONL) |
| Resume | yes (`resume <threadId>`) | yes (`-r <id>`) | yes (`--session <file>`, else `--session <id>`) |
| Native todos | yes (plan/todo items in the rollout) | yes (`plan.json`) | no |
| Native plan | yes (`Plan` items, plan mode) | yes (`plan_mode.json`) | no |
| Sandbox | 3 profiles | 5 profiles | none |
| Approval | 2 modes, passed as a config override | 6 modes, native flags | 2 modes, one flag |
| `mcpClient` | yes (`mcp_servers` in its own config) | yes | yes |
| `listModels` | no | yes | yes, via an adapter extra |
| Login automatable | yes: loopback, device code, API key on stdin; logout available | partly: loopback and device code; no API-key flag, and env/deployment credentials cannot be revoked | no: TUI-only login and logout, reported as guidance |

All three are driven through the headless transport only; `interrupt` is `false` everywhere, so cancellation always means "kill the process group and lose the turn".

## What we deliberately do not use

Each agent's own worktree flag (ADR-0008): Codex's `--worktree` (fork-specific, plus internal `codex_worktrees` MCP tools), Grok's first-class `-w/--worktree[=name]` / `--worktree-ref` / `x.ai/git/worktree/*` surface. Pi has no worktree flag at all. Using them would give three different behaviors, three directory layouts and no way to correlate a worktree with the run that owns it, so MutiAgent creates the worktree itself and tells the agent where to work: `-C` for Codex, `--cwd` for Grok, the child cwd for Pi. All three adapters therefore declare `externalWorktree: false`, and a native worktree label found in a session (Grok's `worktree_label`) is recorded as a note rather than adopted.

Each agent's duplex protocol (ADR-0003): Codex's `codex app-server --stdio` (JSON-RPC v2, which is what would make interrupt and interactive approvals possible), Grok's `grok agent stdio` (ACP JSON-RPC, plus `x.ai/*` extension methods), and Pi's `--mode rpc` (NDJSON commands on stdin). All three are declared as `duplex-protocol` transports with `available: false`, and their `mechanism` string says so. They need a long-lived session with handshakes, correlation ids and lifecycle management, which is the per-adapter opt-in ADR-0003 describes; until one lands, `approval.requested` is never emitted, a live turn cannot be steered, and the UI shows the capability as unavailable rather than as a control that does nothing.

Two smaller deliberate omissions: Codex `codex login status` is never spawned (status comes from files and the environment, and a keyring-only credential is honestly `unknown`), and Pi's `pi auth check --json` / `print-api-key` / `print-bearer-token` are never called (the first costs a process for information a file read gives, the others print a secret).

## Verified against

Versions observed on the machine where this reference was written, from each binary's own `--version`:

| Agent | Version |
|---|---|
| Codex | `codex-cli 0.156.1` |
| Grok Build | `grok 1.0.34 (3736acbc8658)` |
| Pi | `1.2.0` |

The Grok adapter additionally names the xAI source revision its formats were read from: `SOURCE_REV 559751fdcec02d413e4c57c8832ab275e4f44980`. The Pi session reader is pinned to session format version 3. These are the revisions the projection tables above are true for; a native format change is expected to surface as a failing fixture rather than as a silent gap (ADR-0013).
