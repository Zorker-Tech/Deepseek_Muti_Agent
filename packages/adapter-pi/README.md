# `@zorker/muti-agent-adapter-pi`

MutiAgent's adapter for **Pi** (`@earendil-works/pi-coding-agent`, bin `pi`,
verified against pi 1.2.0). It implements the `AgentAdapter` SPI from
`@zorker/muti-agent-core` and maps pi's own session store, event stream and credential
store onto the canonical schema (ADR-0002, ADR-0003, ADR-0010, ADR-0012).

```ts
import { createPiAdapter } from '@zorker/muti-agent-adapter-pi'

const adapter = createPiAdapter(ctx)
await adapter.describe()
await adapter.listSessions({ cwd: '/repo', limit: 20 })
await adapter.listModels()
await adapter.run({ runId, cwd: '/repo', prompt, isolation: 'shared-cwd' })
```

## Capability declaration

```ts
{
  runModes: ['headless-exec'],
  streaming: true,
  resume: true,
  interrupt: false,
  listSessions: true,
  readTranscript: true,
  nativeTodos: false,
  nativePlan: false,
  externalWorktree: false,
  mcpClient: true,
  listModels: true,
  sandboxProfiles: [],
  approvalModes: ['default', 'approve'],
  credentials: { status: true, login: ['interactive'], logout: false },
}
```

Transports: `headless-exec` → `pi --mode json` (available). `duplex-protocol` →
`pi --mode rpc` (declared, **not implemented**): it needs a long-lived duplex session,
which ADR-0003 makes a per-adapter opt-in, so it will land as its own change with
correlation ids and lifecycle handling rather than as a second code path here.

## Store layout, as this adapter resolves it

| Concern | Source | Precedence |
|---|---|---|
| Agent dir | `config.homeDir`, `$PI_CODING_AGENT_DIR`, `~/.pi/agent` | 1, 2, 3 |
| Session directory override | adapter `settings.sessionDir`, `$PI_CODING_AGENT_SESSION_DIR`, `sessionDir` in pi's `settings.json` | 1, 2, 3 |
| Default root | `<agent-dir>/sessions` | — |
| Session file | `<root>/--<flattened-cwd>--/<ISO timestamp with `:` and `.` as `-`>_<sessionId>.jsonl`, or directly in the override directory | — |

One verified subtlety that shapes the code: `--session-dir` /
`$PI_CODING_AGENT_SESSION_DIR` / pi's `sessionDir` is **not** a second root. It is the
directory that directly holds session files, replacing the per-cwd subdirectory for every
project, and pi's `listAll` reads it flat. This adapter therefore reads the override
directory flat *and* the default root's subdirectories, because a machine that switched
layouts keeps sessions in both places; pi's own listing with an override hides the
default-root ones.

There is no session index: enumeration is a directory scan. Scans are bounded
(200 directories, 400 files per directory, 1500 files per scan) and the caps that were hit
are reported as `ProjectionNote`s on the newest session.

## Projection table

### Session (`AgentSession`)

| Canonical field | Pi source | Loss / note |
|---|---|---|
| `nativeId` | header `id` | none |
| `key` | `pi:<id>` | none |
| `nativePath` | the `.jsonl` file | none |
| `title` | latest `session_info.name` (an empty name clears it) | a tail-only read can miss a title set earlier, because pi's own listing reads the whole file |
| `titleIsNative` | `true` whenever `title` is set | a title-less session carries no `title` at all: deriving one from the first user message is the caller's choice, and this adapter never invents a native name |
| `cwd` | header `cwd`, **authoritative** | the directory name is only a hint; a disagreement is noted |
| `repoRoot` | — | not inferred: it needs a git call per session, so the orchestrator infers it once per distinct cwd |
| `branch` | — | pi records no git branch |
| `model` | latest `model_change.modelId`, else the last assistant message's `model` | pi also records a `provider`, which `AgentSession` has no field for |
| `createdAt` | header `timestamp` | file mtime only when the header is unreadable |
| `updatedAt` | latest user/assistant message time → header time → file mtime | exactly pi's own fallback order, restricted to the read window |
| `status` | `idle`, `unreadable` (header unreadable) | `running` is MutiAgent's, `missing` is handled by the caller |
| `messageCount` | `message` entries on the live branch | omitted when the file exceeded the read window |
| `parentNativeId` | header `parentSession`, id recovered from the path | a path that yields no id is kept verbatim |
| `source` | `pi`, or `pi:fork` when `parentSession` is set | pi records no explicit source |
| `usage` | summed assistant-message usage plus standalone `usage` entries | pi keeps no session total; a truncated window makes it partial, and cache-write tokens have no canonical field |
| `binding.runIds` | — | always empty: that is MutiAgent-side state |

### Transcript (`AgentMessage`)

| Native record | Canonical | Loss / note |
|---|---|---|
| `message` role `user`, content string or blocks | one `user`/`user` message, text blocks joined | image blocks are counted in a note; the canonical message has no image field |
| `message` role `assistant`, content blocks | one message per block: `text` → `assistant`/`assistant`, `thinking` → `assistant`/`reasoning`, `toolCall` → `assistant`/`tool-call` with `input` = serialized arguments | multi-block entries get derived ids `entryId:blockIndex`; unknown block types are counted |
| `message` role `toolResult` | `tool`/`tool-result` with `tool.output` and `failed` from `isError` | `id` is the native `toolCallId` |
| `message` role `bashExecution` | `tool`/`tool-result`, tool `bash`, `input` = command | pi-only message kind |
| `message` role `custom` / entry `custom_message` | `user` when `display` is true, else `system`; `nativeType` keeps the extension's `customType` | — |
| `compaction`, `branch_summary` entries and their summary messages | `system`/`system` with the summary text | pi hides messages before `firstKeptEntryId` in its own context; the transcript shows the branch as recorded |
| `context_edit` | **not applied** | recorded content is shown; edits are counted in a note |
| `thinking_level_change`, `model_change`, `usage`, `label`, `session_info` | no message | state, folded into the session summary where canonical fields exist |
| an entry type this reader does not model | no message | named in a note; a format revision degrades into a visible gap |
| image blocks | — | counted and noted, never invented into text |

Reading is branch-aware: the file is an append-only tree, so the live conversation is the
chain that ends at the *last line* (that is where the next entry attaches). Entries on
abandoned branches are excluded from the linear reading and counted in a note;
`compaction` semantics are not applied, so the transcript stays a faithful record.

### Auth (`AgentAuthState`)

| Canonical field | Pi source | Loss / note |
|---|---|---|
| `status` | `auth.json`: usable `oauth` (`expires` in the future) or `api_key` entry → `authenticated`; only expired OAuth → `expired`; provider env var set → `authenticated`/`source: 'env'`; unparsable file → `misconfigured`; otherwise `unauthenticated` | pi refreshes an expired OAuth credential on the next request, so `expired` is not "logged out" |
| `source` | `file`, `env`, `none` | `cli-probe` is unused: `pi auth check` costs a process start for what the file already says |
| `method` | provider names and kinds, e.g. `anthropic(oauth), openai(api_key)` | a `!command` key is reported as `<provider>(command)`, never executed and never read |
| `expiresAt` | latest OAuth `expires` among the classified entries | — |
| `credentialPath` | `<agent-dir>/auth.json` | — |
| `environmentKeys` | names from `PI_PROVIDER_ENV_VARS` that are set | names only; ambient sources pi resolves at request time (AWS IAM profiles, Google ADC) are intentionally absent, matching pi's own `findEnvKeys` |
| `account`, `plan` | — | pi's store holds no such field; `pi auth check --json` is provider-dependent and is not called |
| `detail` | which condition was observed, and that an env credential is only forwarded under the adapter's env rules | — |

No credential value is ever read into a projection, logged, or placed in argv.

## Model and provider catalog (`listModels`)

`listModels()` implements the SPI's catalog method by reading Pi's own configuration files
(ADR-0002). It is read-only, needs no process and makes no network call: a missing file, a
missing agent directory or a malformed `models.json` degrades into a `sources` entry plus a
`ProjectionNote`, never an error.

Files read for one catalog:

| File | Read for | Tier |
|---|---|---|
| `<agent-dir>/models.json` | `providers`: each provider's `name`, `baseUrl`, `api`, `apiKey` shape, `models`, and `modelOverrides` | agent |
| `<agent-dir>/settings.json` | `defaultProvider`, `defaultModel`, `enabledModels`, `defaultProjectTrust`; `defaultThinkingLevel`, `modelThinkingLevels` and `thinkingBudgets` are read only to declare their loss | agent |
| `<agent-dir>/auth.json` | which providers hold a stored credential (classified by `auth.ts`; no value is read) | agent |
| `<agent-dir>/trust.json` | whether the project tier is trusted, so Pi would load it | agent |
| `<cwd>/.pi/settings.json` | the same settings keys, merged over the agent values when the project is trusted | project |
| `<cwd>/.pi/models.json` | nothing: Pi reads `models.json` from the agent directory only, so a project-tier file is checked, reported and deliberately not projected | project |

Projection:

| Canonical field | Pi source | Loss / note |
|---|---|---|
| `AgentProvider.id` | the `providers` key | none |
| `name`, `baseUrl`, `wireApi` | provider `name`, `baseUrl`, `api` | none |
| `apiKeyEnv` | the single `$NAME`/`${NAME}` an `apiKey` references; for a provider that declares none, the variable Pi resolves for a well-known provider (the map from Pi's `env-api-keys.ts`, mirrored here) | a literal or `!command` `apiKey` names no variable, so this is absent |
| `credentialPresent` | the referenced variable is set, or `auth.json` holds a credential for the provider, or a literal/`!command` `apiKey` is declared | an expired stored OAuth credential still counts as present: Pi refreshes it on the next request |
| `AgentModel.id` | `models[].id`, or a `modelOverrides` key, **verbatim** | `--model` accepts `provider/id` with an optional `:<thinking>` suffix; the catalog never rewrites an id |
| `displayName` | `name` (the `modelOverrides` entry wins) | Pi defaults the display name to the id; the catalog leaves it absent rather than restating the id |
| `providerId` | the provider the entry sits under | none |
| `isDefault` | `settings.defaultModel` (+ `defaultProvider`) | set only while the saved default is inside an `enabledModels` scope; Pi otherwise starts from that scope's first model, which may be a built-in model this reader cannot identify |
| `contextWindow` | `contextWindow` (override wins) | Pi defaults an omitted value to 128000; the default is not restated |
| `reasoningEfforts` | `reasoning` and `thinkingLevelMap` through Pi's `getSupportedThinkingLevels` | reported only when the configuration says something about thinking (`reasoning` false → `off`; `xhigh`/`max` only when mapped) |
| `source` | `config` for a `models` entry and a settings-only default; `catalog` for a `modelOverrides`-only entry | no entry is ever `builtin` or `env`: the built-in catalog is not read, and a credential is not a model |
| `AgentModelCatalog.defaultModel` | `settings.defaultModel`, merged project-over-agent | reported from settings; when an `enabledModels` scope excludes it, Pi starts from that scope's first model instead, which a note records |
| `providers`, `models`, `sources`, `notes`, `observedAt` | this reader | — |

Every declared loss, gathered:

- **Pi's built-in catalog is not read.** Pi ships a generated model list and can overlay a
  newer one from pi.dev; neither is imported or fetched. The catalog is therefore the
  configured subset — exactly what a user's own `models.json` and `settings.json` change —
  and every read states this in `notes`.
- **`enabledModels` is a scope, not availability.** When it is configured, the model list
  is filtered to it and the note says Pi still accepts an excluded id passed explicitly.
  Pi also starts from the scope's first model when the saved default falls outside it, so
  `isDefault` follows that rule and a default outside the scope is reported as a note.
- **Fuzzy pattern matching is not reproduced.** Pi resolves `--models`/`enabledModels`
  entries as exact ids, fuzzy partial names and case-insensitive globs; this reader supports
  exact ids and globs (`*`, `?`, `[…]`), stripping an optional `:<thinking>` suffix. When
  nothing matches, the note says the patterns most likely name built-in models.
- **`models.json` is parsed as strict JSON.** Pi strips `//` comments before parsing; this
  reader uses the probe's JSON parse, so a commented file becomes a parse-failure note and
  contributes nothing (the rest of the catalog is still returned).
- **Pi rejects a schema-invalid `models.json` whole; this reader recovers.** A malformed
  provider or model entry is skipped and counted in a note, and the valid entries are still
  projected, because a declared gap is more useful than an empty catalog.
- **Keys with no canonical field are declared, not dropped.** Provider `headers`, `compat`,
  `oauth`, `authHeader`; model `api`, `baseUrl`, `input` (the image capability), `inputLimits`,
  `cost`, `promptCache`, `maxTokens`, `samplingParams`, `samplingParamsByThinkingLevel`,
  `headers`, `compat`; settings `defaultThinkingLevel`, `modelThinkingLevels`,
  `thinkingBudgets`. Each is named in a note only when it is configured.
- **A `modelOverrides`-only model is `source: 'catalog'`.** It patches a model Pi ships,
  which this reader cannot enumerate, so the entry carries only the metadata the override
  itself declares.
- **Secrets never appear.** An `apiKey` is classified by shape only (`$NAME`/`${NAME}`
  references, Pi's `$$`/`$!` escapes, a literal, or a leading `!command`): a reference sets
  `apiKeyEnv` and `credentialPresent` from whether that variable is set, and a literal or
  `!command` form is reported as *declared* in a note. The command is never run, and a
  `!command` key in `auth.json` is reported the same way. `auth.json` is read through the
  same classifier as `authStatus()`; only provider names and kinds are projected.
- **Project trust mirrors Pi.** `trust.json`'s nearest entry for an ancestor of the cwd wins,
  else `defaultProjectTrust` (whose `ask` cannot be answered by a read-only caller, so an
  unrecorded project is treated as untrusted). Pi canonicalizes trust paths; this reader
  compares resolved paths, so a symlinked cwd may not match an entry.
- **A default model that no entry declares is added from settings alone** (`source: 'config'`,
  `providerId` from `defaultProvider`, `isDefault` while no `enabledModels` scope excludes it),
  with a note: it is normally a built-in model, and only the id is known here.

## Harness LLM routes (`registerPiLlm`)

`registerPiLlm(ctx, options)` makes the providers `models.json` declares selectable **and
runnable** from the harness's own model selector, instead of only describing them to the
MutiAgent GUI. It reads the configuration once, through the same
`readPiModelCatalogWithRoutes` call this adapter's `listModels()` uses, and then:

- `ctx.llm.registerAdapter(routes, adapter)` registers one adapter for the routes below;
- `ctx.llm.registerConfigurableProviders(entries)` declares the same routes so the harness
  lists them (live or dormant) beside its own providers.

The returned `dispose()` releases both; `providers` lists the registered route keys, and
`notes` carries every refusal and every catalog gap as a string.

| Concern | This adapter |
|---|---|
| Route key | `pi:<providerId>` — e.g. `pi:local-qwen`, `pi:bifrost` |
| Why the prefix | a `models.json` entry may be named after a provider the harness ships; `pi:` keeps it from shadowing that route |
| Selector grouping | one provider per `models.json` entry, displayed as `Pi · <providerId>` |
| Models offered | the provider's `models` entries as the catalog projects them (id, `name`, `contextWindow`, `reasoningEfforts`), after `settings.enabledModels` scoping |
| Directory entry | `declared: true`, `settingsPath: []`, `defaultBaseURL` = `baseUrl` + `/chat/completions` |
| Credential | `$NAME`/`${NAME}` resolved from the environment per request, a literal sent as it stands; never logged, reported or persisted |
| Request | `POST <baseUrl>/chat/completions`, `stream: true`, `stream_options.include_usage` |
| Settings namespace | `muti-agent` unless the host passes its own plugin entry id |

`settingsPath` is empty because the profile is Pi's own `models.json` entry, not a section of
harness settings: the route is a read of that file, and the harness settings UI is not where
it is edited.

### Deliberately not supported, and why

- **Any `api` other than `openai-completions`.** A provider whose `api` is absent, or names
  another protocol, is *not registered*: this adapter cannot speak it, and declaring the
  route anyway would put a model in the selector that fails on use. The note names the value
  it refused.
- **A `!command` `apiKey`.** Running the user's command as part of a model call needs a
  decision of its own (what runs, under which environment, what its output means), so the
  route is refused with a note rather than executed.
- **A per-model `api` or `baseUrl`.** Pi lets a model entry override the provider's endpoint
  or protocol; a route with one fixed endpoint cannot follow that, so those models are not
  offered and the note names them.
- **Model-level `headers`.** Only a provider entry's `headers` are sent; a per-model override
  is not carried, so a provider that authenticates one model differently is not supported.
- **Credentials that exist only in `auth.json`.** `authStatus()` reports them, but a route
  authenticates from the declared `apiKey` (or the ambient variable Pi resolves for a
  well-known provider id) only. A provider with neither declaration nor ambient variable sends
  no `Authorization` header, which is what a self-hosted endpoint usually wants.
- **Image input.** Every route reports `inputModalities: ['text']`, so the harness projects
  images to text for it; the bridge refuses an image block outright if one still arrives.
- **Reasoning dialects beyond `reasoning_effort`.** A model's `thinkingLevelMap` decides which
  levels are *offered* (its `xhigh`/`max` rules; `off` is never offered, because it means "send
  nothing"), but the offered level's own name is sent as OpenAI's `reasoning_effort` string. A
  provider that wants another spelling or another field (a `chat_template_kwargs` object, an
  Anthropic thinking budget) is not reproduced — declare no `thinkingLevelMap` for such a model.
- **`tool_choice`.** The harness request carries no such field, so the provider's own default
  applies. Tool declarations are sent complete on every request: this route declares no
  `toolUpdate` mode, so the harness strips `deferLoading` and the developer messages itself.

### Variables read (names only)

| Variable | Read for |
|---|---|
| `PI_CODING_AGENT_DIR` | the agent directory, when `options.agentDir` is not passed |
| the single variable a provider's `apiKey` references | that request's `Authorization` header |
| the ambient variable Pi resolves for a well-known provider id (the map in `models.ts`) | the same, for a provider that declares no `apiKey` |

### Verifying it

```sh
node --test packages/adapter-pi/tests/registration.test.ts
```

The test bundles `src/llm.ts` with esbuild (the same tool `scripts/build.mjs` uses, because
by-name workspace imports resolve to each package's built `lib/`), points a stub endpoint at
it, and asserts the registered routes, the directory entries, the refusal notes, the model
listing and the exact `StreamChunk` sequence one request produces.

## Why five things are absent

- **Todos (none).** Pi has no todo tool: its built-in tools are `read`, `bash`,
  `powershell`, `edit`, `write`, `grep`, `find`, `ls`. `readNativeTasks()` returns
  `undefined` rather than pattern-matching extension `custom` entries: a list scraped out
  of some third-party extension's private entry is not a native task model, and pretending
  otherwise would make the shared board lie.
- **Plan mode (none).** Pi's README says it "skips features like sub-agents and plan mode";
  `--plan` exists only as an example extension flag.
- **Sandbox (none).** Pi's README: "Pi does not include a built-in permission system"; it
  runs with the launching user's permissions, and pi's answer is containerization.
  `sandboxProfiles` is therefore empty, and a run request that names a profile is warned
  about and ignored rather than silently dropped.
- **Login / logout (unsupported, with guidance).** `/login` and `/logout` are TUI commands;
  there is no non-interactive credential command, and this adapter never drives a TUI
  (ADR-0003). Both operations return `ok: false` with instructions and a freshly observed
  state — the settings page shows what to do instead of a dead button (ADR-0010). `pi auth
  print-api-key` / `print-bearer-token` exist and are deliberately never called.
- **Interrupt (`false`).** `cancel()` kills the managed process group; pi's `--mode json`
  transport has no way to abort one turn and keep the session, so `interrupt` stays false
  until the `--mode rpc` transport lands.

## Running pi

- **argv**: `pi --mode json`, plus `--session-id <id>` for a new run (MutiAgent generates a
  uuid-v7-shaped id), `--session <file>` when resuming a session whose file was resolved,
  `--session <id>` when only the id is known (pi's own lookup), `--provider`/`--model` when
  a model is configured, and `--approve` when `approval` is `approve`. `default` approval
  passes no flag, so pi's own trust store decides. A requested resume never silently turns
  into a new session.
- **Prompt on stdin.** `AdapterRunRequest.prompt` (with the orchestrator's injected context
  already composed into it) is written to the child's stdin, never to argv, and
  `--append-system-prompt` is deliberately unused: the context block is part of the task
  text, which keeps the run reproducible from the prompt alone and avoids a second
  injection channel.
- **Resume by path.** With a bare id, pi resolves the session and asks an interactive
  "fork this session into another project?" question when the session's project differs
  from the process cwd; with stdin closed that question is never answered and **pi exits 0
  having done nothing**. Passing the session file path skips resolution. A resume whose
  recorded `cwd` differs from the requested `cwd` is refused before spawning, as a
  classified `run/context-unavailable` failure with remediation, because pi cannot continue
  it non-interactively.
- **Events**: `run.started` → `session.bound` (from the stream's first header record) →
  mapped events → exactly one `run.finished`. `--mode json` emits delta-only content, so
  `message_update` maps to `message.delta`/`reasoning.delta`/`tool.started`, and
  `tool_execution_start` is deduplicated by call id so one call yields one `tool.started`.
  Records with no content, and records whose content repeats on a boundary the mapper
  already uses, are deliberate no-ops; anything unrecognized becomes `unknown`, never a
  silent drop.
- **Idle** is `agent_settled`, not `agent_end` (a turn can retry after `agent_end`). The
  managed process exit is the terminal boundary; if the stream ends without `agent_settled`,
  the result carries a note saying the turn may not have finished.
- **Exit classification.** Pi's JSON mode exits 0 even when the last assistant response
  failed, so the terminal result also reads the stream's own `stopReason`/`errorMessage`. A
  non-zero exit is classified from stderr (`session/not-found`, `auth/not-configured`,
  `run/rate-limited`, else `run/agent-crashed`); a process that never reported an exit is
  `run/start-failed`; a timeout is `run/timeout`; a cancellation is `run/cancelled`. An exit
  with **no session header at all** is `run/context-unavailable`: that is the signature of
  an unanswerable interactive question.
- **Environment** (ADR-0014): `PI_CODING_AGENT_DIR` always, `PI_CODING_AGENT_SESSION_DIR`
  whenever a session-directory override is in force, then `config.env`, then the request's
  `env`. Provider credentials are **not** forwarded by default: with `envMode: 'minimal'`
  they never reach the child, and with `'inherit-agent'`/`'inherit-all'` the runner's secret
  filter drops them unless the adapter setting `inheritCredentialEnv` is enabled. That is
  the explicit opt-in ADR-0014 requires; pi's own `auth.json` is the default path.
- **Interactive launch**: `nativeLaunchCommand(id)` returns `pi [--session-dir <dir>]
  [--session <id>]`, never `--resume` (it opens a picker). A launcher must export
  `PI_CODING_AGENT_DIR` when a `homeDir` override is set, because argv cannot carry it.

## Adapter settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `sessionDir` | `string` | unset | Session directory override, as pi's `--session-dir` defines it (the directory that directly holds session files). |
| `inheritCredentialEnv` | `boolean` | `false` | Forward the host's provider credential variables (`PI_PROVIDER_ENV_VARS`) to a run, even though the child environment is derived. |

## Extra beyond the SPI

`PiAdapter.listNativeModels(search?)` is an adapter-specific extra for models no configuration
file declares: it runs `pi --offline --list-models [search]` and parses the table into
`{ provider, id, contextWindow, maxOutput, thinking, images }` rows. Rows are accepted only
after pi's `provider  model  …` header, so the credential guidance pi prints when it has no
usable provider is reported as a note instead of being parsed as models. `--offline` keeps the
probe from refreshing catalogs or blocking on the network. The SPI's `listModels()` is the
file-based catalog above and needs no process at all.
