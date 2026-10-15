# `@zorker/muti-agent-adapter-grok`

Grok Build (xAI's `grok` CLI) as a MutiAgent agent: one `AgentAdapter`
implementation, no consumer changes (ADR-0002).

Verified against xAI's source at `SOURCE_REV 559751fdcec02d413e4c57c8832ab275e4f44980`.
Every fact below names the file it came from, because these are another product's
private formats.

## Surfaces

| Concern | Mechanism | Where the shape is defined |
|---|---|---|
| Dispatch | `grok -p "<prompt>" --output-format streaming-json` → NDJSON on stdout | `xai-grok-pager/src/app/cli.rs`, `headless/reducer/acp.rs` |
| Resume | `-r <session-id>` on the same command | `app/cli.rs` (`--resume`, `num_args = 0..=1`) |
| Sessions | `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/summary.json` | `xai-grok-config/src/paths.rs`, `xai-grok-shell/src/session/persistence.rs` |
| Transcript | `<session>/updates.jsonl` (ACP stream, authoritative) or `<session>/chat_history.jsonl` (derived cache) | `session/storage/mod.rs` |
| Todos / plan | `<session>/plan.json`, `<session>/plan_mode.json` | `session/storage/mod.rs`, `tools/.../todo/mod.rs`, `session/plan_mode.rs` |
| Credentials | `$GROK_AUTH_PATH` or `$GROK_HOME/auth.json`, a scope-keyed map | `xai-grok-login/src/storage.rs`, `src/model.rs` |
| Model catalog | `listModels()` reads `[models]`, `[model.<id>]`, `[model_providers.<id>]` and `[endpoints]` from the managed/config/requirements tiers, reports the project tier without merging it, and reads the `GROK_CONFIG`/`GROK_CONFIG_PATH` overlays | `xai-grok-config/src/config_layers.rs`, `env_overlay.rs`, `config_override.rs`, `xai-grok-permission-rules/src/project_config.rs` |

Not used on purpose:

- `$GROK_HOME/sessions/session_search.sqlite` — a rebuildable cache, and reading it
  would cost a SQLite dependency (`xai-grok-session-search/src/db.rs`).
- `grok -w/--worktree` — MutiAgent creates the worktree and passes `--cwd`; see below.
- `grok agent stdio` (ACP duplex) — declared as an unavailable transport; v0.1 drives
  everything through the headless transport (ADR-0003).

## Capability declaration

```ts
runModes: ['headless-exec']            streaming: true      resume: true
interrupt: false                       listSessions: true   readTranscript: true
nativeTodos: true                      nativePlan: true      mcpClient: true
listModels: true                       externalWorktree: false
sandboxProfiles: ['off', 'workspace', 'devbox', 'read-only', 'strict']
approvalModes: ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan']
credentials: { status: true, login: ['oauth-loopback', 'device-code', 'interactive'], logout: true }
```

- **`externalWorktree: false`.** Grok Build can create its own worktree (`-w/--worktree`,
  `api/cli.rs`), and it can run inside one it did not create. But MutiAgent's isolation
  contract is that *it* owns the worktree and tells the agent where to work (ADR-0008),
  and the adapter always passes `--cwd`; asking grok to also manage a worktree would
  create two competing owners of the same directory and leave `summary.worktree_label`
  pointing at a worktree MutiAgent did not create. The capability is therefore declared
  `false` — the flag is never used — while isolation still works through `--cwd`.
- **`interrupt: false`.** The headless transport is one-shot: cancellation kills the
  process group and reports `run/cancelled`; it cannot steer a live turn (ADR-0003).
- **No `api-key` login flow.** `grok login` accepts only `--oauth`, `--device-auth` and a
  hidden `--legacy` (`app/cli.rs`); there is no `--api-key`/`--with-api-key` flag, even
  though `xai-grok-login/src/model.rs` still documents one. Declaring a flow we cannot
  complete would render a dead button, so it is declared `interactive` instead and a
  caller that explicitly asks for `api-key` receives
  `{ok: false, interaction: {kind: 'stdin-secret', instructions}}` with a fresh status —
  never a faked success.

## Projection table — sessions (`summary.json` → `AgentSession`)

| Canonical field | Native source | Notes |
|---|---|---|
| `key` | `agentId` + `nativeId` | `grok:<uuidv7>` |
| `nativeId` | `info.id`, else the directory name | UUIDv7 |
| `nativePath` | the session directory | |
| `title` | `generated_title`, else `session_summary` | verbatim; `titleIsNative: true` |
| `cwd` | `info.cwd`, else the decoded directory name, else `.cwd` | declared when recovered |
| `repoRoot` | `git_root_dir` | |
| `branch` | `head_branch` | |
| `model` | `current_model_id` | |
| `createdAt` / `updatedAt` | `created_at` / `updated_at` | RFC3339, verbatim |
| `messageCount` | `num_messages`, else `num_chat_messages` | |
| `parentNativeId` | `parent_session_id` | subagent/fork children are listed, not filtered |
| `source` | `session_kind` | `fork`, `subagent`, `subagent_fork`, `worktree`, … |
| `usage` | `<session>/usage.json` → `session` | `costUsd` from `costUsdTicks / 1e10` |
| `status` | — | `idle` when the summary parsed, `unreadable` when it did not |
| `binding` | — | MutiAgent state; never read from the native store (`runIds: []`) |

Declared losses:

- `hidden: true` sessions are **listed** with a note; grok hides them by `session_kind`
  default rather than deleting them (`session/persistence.rs`).
- `sandbox_profile` is a note, not a field: grok refuses to resume a session under a
  different explicit profile, so the value is user-relevant but has no canonical slot.
- `worktree_label` / `source_workspace_dir` are notes; MutiAgent tracks its own worktrees.
- `title_is_manual` becomes a note, so a manual rename is distinguishable from an
  auto-title without a dedicated field.
- `git_remotes`, `request_id`, `grok_home`, `previous_cwd`, `last_turn_summary`,
  `chat_format_version`, `context_window`, `cwd_generation`, `reasoning_effort` and the
  flattened `agent_name`/`agent_profile` are not projected at all.
- A malformed `summary.json` yields `status: 'unreadable'` with the parse error as a note
  and every metadata field absent — the session is never silently dropped (ADR-0012).

## Projection table — transcript (`updates.jsonl` → `AgentMessage`)

Persisted lines are `{timestamp, method, params}` envelopes with
`method ∈ {session/update, _x.ai/session/update}`; legacy files without the envelope are
also accepted (`SessionUpdateEnvelope::from_value`).

| Native `sessionUpdate` | `kind` | `role` | Loss |
|---|---|---|---|
| `user_message_chunk` | `user` | `user` | content blocks collapsed to text |
| `agent_message_chunk` | `assistant` | `assistant` | text deltas are joined as one record per line |
| `agent_thought_chunk` | `reasoning` | `assistant` | |
| `tool_call` | `tool-call` | `assistant` | `rawInput` re-serialized, capped at 16 KiB; `kind`/`content`/`status` dropped; `locations` → `paths` |
| `tool_call_update` | `tool-result` | `tool` | only completed/failed updates are emitted; `toolName` is remembered from the `tool_call` because the update omits it |
| `plan` | `plan` | `assistant` | entries flattened to `status: content` lines |
| `current_mode_update` | `plan` | `system` | plan-mode toggles |
| anything else | `unknown` | `unknown` | `nativeType` preserved verbatim |

Declared losses: `available_commands_update` is kept only as `unknown`; a `diff` content
block contributes its touched path rather than a patch, and a `terminal` block contributes
nothing; the window is the newest 1 MiB (or `maxBytes`) and a dropped or truncated head
sets `hasMore`; a partial trailing line is discarded by the tail reader. When
`updates.jsonl` is absent or empty the reader falls back to `chat_history.jsonl`
(`ConversationItem` records: `system`/`user`/`assistant`/`tool_result`/`reasoning`), which
is a *derived* model-message cache — that substitution is always declared as a note.

## Projection table — native tasks (`plan.json` + `plan_mode.json` → `NativeTaskState`)

| Canonical field | Native source | Notes |
|---|---|---|
| `todos[].nativeKey` | the `todos` map key | |
| `todos[].id` | `grok-<fnv1a32(nativeKey)>` | dependency-free stable hash |
| `todos[].content` | `content` | falls back to the key |
| `todos[].status` | `status` | `pending`/`in_progress`/`completed`/`cancelled` map 1:1; anything else → `pending` |
| `todos[].updatedAt` | `plan.json` mtime | the native record carries no per-item time |
| `plan.active` | `plan_mode.json` → `state` | `true` only for `Active`; `Pending`/`ExitPending` are transient and collapse to `Inactive` on restore |
| `plan.items` | `content` of every todo | `plan_mode.json` has no phase titles of its own |

Declared losses: grok's todo model has no dependency edges, so `blockedBy` is always
empty; `plan.json`'s `priority` and opaque `meta` are dropped; `plan.md` (the plan body
itself) is not read, because the brief's surface is `plan.json`/`plan_mode.json`.

## Projection table — run events (`streaming-json` → `AgentRunEvent`)

| Native `type` | Canonical event | Loss |
|---|---|---|
| `text` (`data`) | `message.delta` (+ one `message.completed` at the end) | chunk boundaries are grok's, not turns |
| `thought` (`data`) | `reasoning.delta` | |
| `tool_call` | `tool.started` (+ `files.changed` from `locations`) | `title`, `kind`, `status`, `content` dropped; `rawInput` capped at 8 KiB |
| `tool_call_update` (terminal) | `tool.completed` | `content` preferred over `rawOutput`; `failed: status === "failed"` |
| `plan` | `todos.updated` + `plan.updated` | plan entries carry no ids, so todos are ordinal |
| `usage` | `usage.updated` | `cache_creation_input_tokens` has no canonical field and is declared as a note; `signature`/`messageId`/`stopReason` dropped |
| `end` | — (facts folded into the result) | `num_turns`, `modelUsage`, `total_cost_usd_ticks`, `structuredOutput` are not canonical; `num_turns` is declared as a note, `total_cost_usd` becomes `usage.costUsd` |
| `error` | `warning` (fatal classification still comes from the exit code) | |
| `max_turns_reached` | `warning` | |
| `available_commands`, `auto_compact_*`, `auto_continue_completed`, `image_compressed`, `memory_*` | `unknown` (preserved verbatim, capped) | per ADR-0003 nothing native is dropped |

Run dispatch details:

- The prompt is passed after `-p`; when it begins with `-`, the `--single=<prompt>` form is
  used instead of `-p -- <prompt>`, because clap treats an option's next token as a flag
  unless it is attached by `=` (`--single` has no `allow_hyphen_values`, unlike `wrap`).
- `--cwd <cwd>` is always passed: grok records the session's cwd in `summary.json`, so the
  record must match what MutiAgent asked for, not the process cwd.
- `--permission-mode <mode>` is passed for every declared mode except `bypassPermissions`,
  which becomes `--always-approve`. An explicit mode beats the user's grok `config.toml`
  (`util/config/permissions.rs`), which is what makes the declaration meaningful. When no
  approval is requested, grok's own config applies and a note says so.
- The native session id comes from the `end` line's `sessionId` (always present in the
  reducer source, but treated as optional), else from a before/after snapshot of
  `<sessionRoot>/*/*`; when neither yields one, `session.bound` is not emitted, a
  `warning` event is emitted, and the run is recorded as unbound.
- Resuming with an explicit `--sandbox` that differs from the session's recorded profile
  is refused by grok with exit code 1 (`app/cli.rs` + `pager-bin/src/main.rs`); the
  adapter surfaces it as `run/policy-blocked` with grok's own remediation and never
  retries.
- `--no-plan` and `--no-subagents` are only consumed by the interactive pager
  (`app/event_loop.rs`), not by the headless path; they are passed when configured, and a
  note records that headless grok ignores them.

## Credentials

Status is read from the scope-keyed `auth.json` map without writing, locking or rewriting
it, then classified:

| Observation | `status` | `source` |
|---|---|---|
| a credential variable is set (`XAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, `GROK_AUTH`, `GROK_DEPLOYMENT_KEY`) | `authenticated` (method from the key) | `env` |
| a usable account login, else an API-key entry, else `xai::api_key` | `authenticated` (`method` from `auth_mode`) | `file` |
| every entry expired and none has a refresh token | `expired` | `file` |
| the store is unreadable | `misconfigured` | `file` |
| the entry carries no key material | `misconfigured` | `file` |
| nothing in the store or environment, banner confirmed | `unauthenticated` / `authenticated` | `cli-probe` |
| nothing anywhere, no probe | `unauthenticated` | `file` |

- `email` → `account`, `team_name` → `plan`, `expires_at` → `expiresAt`, `auth_mode` →
  `method` (`web_login` → `web-login`), plus `credentialPath`. No other field of an entry
  is read, and the bearer/refresh token values are reduced to booleans in-process, so a
  secret cannot leave the adapter by construction (ADR-0010).
- The `grok models` probe is the first line of stdout and only spawns when the store and
  the environment are both empty and `settings.probeCli !== false`.
- `login` delegates to `grok login [--oauth|--device-auth]` and parses the CLI output for
  the verification URL and device code; `logout` delegates to `grok logout`. Both return
  the state observed *after* the command, never the intent.
- The loopback flow completes in a browser and cannot be steered from a TTY-less child:
  the child's stdin is closed (ADR-0014), so the URL grok prints is surfaced as
  `interaction: {kind: 'browser-url'}` and the run succeeds only once the callback lands
  within the flow's budget.
- Declared loss: a `deployment-key` credential and an environment-supplied key are not
  manageable from MutiAgent, so `logout` cannot revoke them; the state says so.

## Model catalog (`listModels`)

`listModels()` projects grok's **configured** models and endpoints onto
`AgentModelCatalog`. Grok keeps no model table on disk — `grok models` prints what the
endpoint offers — so the catalog is deliberately the configured subset, never a network
answer. Nothing is written; a missing or malformed file is a declared gap, and the call
never throws.

### Files read, lowest precedence first

| # | Source | Model-relevant keys |
|---|---|---|
| 1 | `/etc/grok/managed_config.toml` | `[models]`, `[model.<id>]`, `[model_providers.<id>]`, `[endpoints]` |
| 2 | `$GROK_HOME/managed_config.toml` | same |
| 3 | `$GROK_HOME/config.toml` | same |
| — | project `.grok/config.toml`, repo root → cwd | **read but never merged**: grok takes only `[mcp_servers]`, `[plugins]`, `[permission]` and `[mcp] max_output_bytes` from a project file, so a model key there is reported and ignored |
| 4 | `GROK_CONFIG_PATH` file, then `GROK_CONFIG` inline JSON | `[models]` only — grok's overlay allowlist keeps `models`, `features`, a narrowed `toolset` and the `shell_environment_policy` filter fields, and an inline value that parses wins over the path |
| 5 | `$GROK_HOME/requirements.toml` | same keys as 1–3 (an admin pin wins over everything below it) |
| 6 | `/etc/grok/requirements.toml` | same keys |
| 7 | macOS MDM `ai.x.grok` | not read: device-management preferences, not a file |

`$GROK_HOME` is `$GROK_HOME` verbatim when non-empty, else `~/.grok`. The merge order is
`xai-grok-config/src/config_layers.rs`; the project tier is
`xai-grok-permission-rules/src/project_config.rs`; the overlay allowlist is
`config_override.rs` (`OVERLAY_ALLOW_PATHS`). `$GROK_AUTH_PATH` (`$GROK_HOME/auth.json`)
is read through the same helper as `authStatus()`, and only to decide whether a provider
has a credential.

### Projection

| Canonical field | Native source |
|---|---|
| `defaultModel` | `[models].default` from the merged layers; environment `GROK_DEFAULT_MODEL` overrides every file, the order grok resolves (`CLI > env > config`) |
| `models[].id` | `[model.<id>]` section key (what `-m` accepts), or an `allowed_models` entry |
| `models[].displayName` | `[model.<id>].name` |
| `models[].providerId` | `[model.<id>].model_provider` |
| `models[].contextWindow` | `[model.<id>].context_window` |
| `models[].reasoningEfforts` | `[model.<id>].reasoning_efforts` (bare strings or `{value = "…"}` tables); the deprecated `reasoning_effort` when the list is absent |
| `models[].isDefault` | the id equal to `defaultModel` |
| `providers[]` | the built-in `grok` provider, plus one per `[model_providers.<id>]` |
| `providers[].baseUrl` | `[endpoints].models_base_url` ?? `$GROK_MODELS_BASE_URL`, else `[endpoints].cli_chat_proxy_base_url` ?? `$GROK_CLI_CHAT_PROXY_BASE_URL`, else `[endpoints].xai_api_base_url` ?? `$GROK_XAI_API_BASE_URL`, else `https://cli-chat-proxy.grok.com/v1` |
| `providers[].apiKeyEnv` | `XAI_API_KEY` for the built-in provider, else the first `[model_providers.<id>].env_key` name |
| `providers[].credentialPresent` | that variable is present, or an inline `api_key` is set (presence only), or the credential store has an entry with key material |
| `providers[].wireApi` | `[model_providers.<id>].api_backend` verbatim (`chat_completions`, `responses`, `messages`) |

`source` is `builtin` for the built-in endpoint and `config` for everything a file
declared. A config value wins over a same-named endpoint environment variable, because
grok merges the `[endpoints]` table over its env-derived defaults
(`xai-grok-config/src/endpoints.rs`). No secret is read: `env_key` contributes variable
*names*, `api_key` contributes only the fact that it is set, and `extra_headers`, `env`
and credential-store values are never retained.

### Declared losses

- **The endpoint is authoritative.** `grok models` and `/v1/models` are never queried,
  so a model the endpoint offers but no configuration file mentions is absent here —
  deliberately, because a catalog read makes no network call (ADR-0012).
- macOS MDM `ai.x.grok` requirements are not read (declared on darwin).
- An absent file contributes nothing and says nothing, which is its expected state; a
  file the bounded read truncated, or that failed to parse, carries its reason on the
  `sources` entry and a `sources` note. An empty file is grok's "unset".
- Project-tier `[models]`, `[model.*]`, `[model_providers.*]` and `[endpoints]` are
  reported on the source entry and in a note, and never merged — grok ignores them too.
- An overlay's `$VAR` references are kept verbatim (grok expands them), and an overlay's
  `version_overrides` and campaign patches are not applied.
- `[models].disabled_models` removes those ids from `models[]` and names them in a note;
  `hidden_models` and `[model.<id>].hidden` only hide from the picker, so the row stays,
  with a note, because `-m` still selects it.
- An `allowed_models` glob (`*`, `?`, `[...]`) is a picker pattern, not a model id: no
  row is derived from it and a note names the globs. A declared `[model.<id>]` outside a
  non-empty allowlist stays in the catalog with a note — the list restricts selection,
  not the catalog.
- `[model.<id>].model` different from the section key: `id` is the section key, and the
  mismatch is named in a note, because the wire model id has no canonical field.
- `[models]` pins (`web_search`, `session_summary`, `image_description`,
  `prompt_suggestion`) name models the canonical catalog has no slot for and are named
  in a note; `[subagents.models]` is not read at all.
- Per-model fields with no canonical slot — `base_url`, a model-level `api_backend`,
  sampling defaults, `query_params`, `env_http_headers`, `notice`, `description` — are
  not projected.

## Adapter settings

| Key | Meaning |
|---|---|
| `probeCli` | `false` disables the `grok models` banner probe in `authStatus` |
| `sandbox` | default `--sandbox` profile and `GROK_SANDBOX` for children |
| `approval` | default approval mode for runs |
| `reasoningEffort` | `--reasoning-effort` value (`low`…`max`) |
| `maxTurns` | `--max-turns` value |
| `noPlan`, `noSubagents`, `disableWebSearch` | pass the corresponding flags (see the headless caveat above) |

Standard adapter config still applies: `binaryPath`, `homeDir`, `env`, `envMode`,
`timeoutMs`, `model`.

## Environment

Read: `GROK_HOME` (verbatim, no XDG fallback), `GROK_AUTH_PATH`, `XAI_API_KEY`,
`GROK_CODE_XAI_API_KEY`, `GROK_AUTH`, `GROK_DEPLOYMENT_KEY`, `GROK_SANDBOX`, and for the
model catalog `GROK_CONFIG`, `GROK_CONFIG_PATH`, `GROK_DEFAULT_MODEL`,
`GROK_MODELS_BASE_URL`, `GROK_MODELS_LIST_URL`, `GROK_CLI_CHAT_PROXY_BASE_URL` and
`GROK_XAI_API_BASE_URL` (endpoint variables contribute a URL only; credential variables
contribute only presence).

Set for children: `GROK_HOME` (resolved), `GROK_AUTH_PATH` (only when it is an override),
`GROK_SANDBOX` (when a sandbox is configured), plus the credential variables the
`envMode` allows through (`GROK_MANAGED_ENV_KEYS` is passed as the runner's `inheritKeys`).

## Files

| File | Contents |
|---|---|
| `src/index.ts` | `GROK_ID`, `GrokAdapter`, `createGrokAdapter`, run dispatch |
| `src/sessions.ts` | session discovery, cwd-dir decode, transcript reader, native task reader |
| `src/events.ts` | streaming-json line → `AgentRunEvent`, plus exit classification |
| `src/auth.ts` | credential status and login/logout delegation |
| `src/models.ts` | model/provider catalog: config precedence, TOML/JSON overlay parsing, projection |
