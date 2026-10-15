# MutiAgent Architecture

MutiAgent turns DeepSeek Harness (`dsh`) into a **multi-agent control plane**: it makes
heterogeneous CLI coding agents — OpenAI Codex, Grok Build, Pi, and future additions —
first-class citizens of one GUI, one tool surface and one orchestration runtime.

- Product name: **MutiAgent** (repository `Zorker-Tech/Deepseek_Muti_Agent`)
- Installable artifact: `@zorker/muti-agent-plugin` (a `dsh` bundle)
- Target harness: DeepSeek Harness `0.2.1-alpha.3` (`engines.dsh` pins the supported range)
- Status: v0.1 framework + Codex/Grok/Pi adapters

> Scope note. MutiAgent is an **orchestrator and integrator**. It drives the agents'
> own binaries and reads their own session stores. It does not re-implement their
> inference, tool execution, sandboxing or approval engines, and it never rewrites an
> agent's session files (ADR-0008, ADR-0012).

## 1. Problem

DeepSeek Harness runs its own agent, with its own session store, sidebar and tools.
Meanwhile a developer's real work is spread across other agent CLIs, each with:

- a different session/transcript format and directory layout,
- a different authentication mechanism and credential file,
- a different control protocol (or none),
- its own todo/plan model, worktree story and approval model.

Consequences today: sessions are invisible to each other, the GUI shows one agent's
history, there is no way to hand a task to another agent, and parallel agents collide in
the same working tree with no integration progress signal.

## 2. Design goals

| # | Goal | Where it lives |
|---|---|---|
| G1 | Unified schema so every UI feature works against every agent | `docs/adr/0002`, `packages/contracts` |
| G2 | Detect installed agents and one-click import their sessions | `packages/core/src/discovery`, ADR-0012 |
| G3 | Sidebar partitioned per agent, so each agent's sessions are distinguishable | ADR-0007, `packages/plugin/src/client` |
| G4 | Multi-agent parallelism with delegated runs | ADR-0003, `packages/core/src/orchestration` |
| G5 | Built-in collaboration: todo sharing and plan sharing | ADR-0009 |
| G6 | Code isolation per agent via git worktrees, with cross-agent progress follow-up | ADR-0008 |
| G7 | Credential management (login/logout/status) inside plugin settings | ADR-0010 |
| G8 | Control plane exposed as MCP server **and** as native harness tools | ADR-0011 |
| G9 | Extensible to agents beyond the first three | ADR-0002, ADR-0003 |

## 3. Layers

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ L5  Client (browser, inside the dsh Web GUI)                                  │
│     packages/plugin/src/client                                                │
│     agent-partitioned session browser · mesh panel · auth settings page ·     │
│     command-palette entries · run/todo/plan live views                        │
└───────────────▲───────────────────────────────────────────────────────────────┘
                │ fetch + SSE over the authenticated /api channel (ADR-0004)
┌───────────────┴───────────────────────────────────────────────────────────────┐
│ L4  Control plane (host)                                                      │
│     packages/control-plane                                                    │
│     HTTP gateway · SSE event bus · MCP server (stdio + streamable HTTP) ·     │
│     tool definitions (harness tools + MCP tools from one source)              │
└───────────────▲───────────────────────────────────────────────────────────────┘
                │ in-process service calls (ctx.provide('mutiAgent', …))
┌───────────────┴───────────────────────────────────────────────────────────────┐
│ L3  Domain services (host)   packages/core                                    │
│     discovery · session-index · run-manager · orchestration · todo/plan       │
│     sharing · worktree isolation · progress watch · credentials               │
└───────────────▲───────────────────────────────────────────────────────────────┘
                │ AgentAdapter SPI (ADR-0003)
┌───────────────┴───────────────────────────────────────────────────────────────┐
│ L2  Adapters          packages/adapter-codex · adapter-grok · adapter-pi       │
│     detect · capabilities · auth · sessions read · run (headless/stream) ·    │
│     resume · launch native TUI · native todo/plan extraction                  │
└───────────────▲───────────────────────────────────────────────────────────────┘
                │ process spawn + filesystem reads (never writes)
┌───────────────┴───────────────────────────────────────────────────────────────┐
│ L1  Canonical schema   packages/contracts                                     │
│     types + Standard-Schema validators + projection/loss rules (ADR-0002)      │
└───────────────────────────────────────────────────────────────────────────────┘
```

Dependencies point **downward only**. L1 depends on nothing. L2 depends on L1. L3
depends on L1+L2. L4 depends on L1..L3. L5 depends on L1 and on L4's HTTP contract only
(the client never imports host code — different build face, different runtime).

Cross-cutting: `docs/adr/` (decisions), `tests/` (contract tests per adapter + integration
tests against recorded native fixtures).

## 4. Package inventory

| Package | Responsibility | Runtime deps |
|---|---|---|
| `@zorker/muti-agent-contracts` | Canonical schema, id branding, Standard-Schema validators, event catalog, error taxonomy | none (pure) |
| `@zorker/muti-agent-core` | Adapter SPI + registry, discovery, session index, run manager, orchestration, todo/plan sharing, worktree isolation, progress watch, credentials | contracts, node builtins |
| `@zorker/muti-agent-adapter-codex` | Codex integration | contracts, core SPI |
| `@zorker/muti-agent-adapter-grok` | Grok Build integration | contracts, core SPI |
| `@zorker/muti-agent-adapter-pi` | Pi integration | contracts, core SPI |
| `@zorker/muti-agent-control-plane` | HTTP gateway, SSE bus, MCP server, tool catalog | contracts, core, adapters |
| `@zorker/muti-agent-plugin` | **The installable bundle**: host plugin entry, client bundle, `cordis.patch.yml`, locale, icon | bundles all of the above |

Only the last one is installed into a harness profile. The rest exist for separation,
review and unit testing.

## 5. Canonical schema (summary)

Full field-level reference: [`reference/schema.md`](reference/schema.md).

- `AgentDescriptor` — `id`, `displayName`, `summary`, `capabilities`, `detection`,
  `transports`, `environmentKeys`, `sessionRoot`, `credentialPath`.
- `AgentCapabilities` — declared booleans/enums; consumers branch on these, never on id.
- `AgentAuthState` — `status` ∈ `authenticated | unauthenticated | expired |
  misconfigured | unknown`, plus `source`, `method`, `account`, `plan`, `expiresAt`,
  `credentialPath`, `environmentKeys`, `detail`, `observedAt`.
- `AgentSession` — canonical session summary: `key` (`<agentId>:<nativeId>`), `agentId`,
  `nativeId`, `nativePath`, `title`, `cwd`, `repoRoot`, `branch`, `model`, `createdAt`,
  `updatedAt`, `status`, `messageCount`, `parentNativeId`, `source`, `usage`, `binding`,
  `notes`.
- `AgentMessage` — normalized transcript item: `role`, `kind`, `text`, `tool`, `usage`,
  `timestamp`, `native`.
- `AgentTodo` / `AgentPlan` — normalized task list and plan document.
- `AgentRunEvent` — streaming run lifecycle, one union across all agents.
- `MeshTask`, `MeshWorkspace`, `WorktreeProgress`, `ConflictReport`, `SharedTodoDoc`,
  `RunRecord`, `Collaboration` — orchestration entities. The shared plan document is an
  `AgentPlan`.

The schema version travels on the wire envelope (`schemaVersion`) rather than on every
object, and a lossy projection declares it locally as `notes: ProjectionNote[]`.

## 6. Adapters at a glance

| | Codex | Grok Build | Pi |
|---|---|---|---|
| Detection | `codex --version`, `$CODEX_HOME` | `grok --version`, `$GROK_HOME` | `pi --version`, `$PI_CODING_AGENT_DIR` |
| Headless run | `codex exec --json` (JSONL `ThreadEvent`) | `grok -p --output-format streaming-json` | `pi --mode json` |
| Rich/duplex run | `codex app-server --stdio` (JSON-RPC v2) | `grok agent stdio` (ACP) | `pi --mode rpc` (JSONL commands) |
| Resume | `codex exec resume <id>` | `grok -p --resume <id>` | `pi --session-id <id>` |
| Session read | rollout JSONL (`rollout-*.jsonl`) | `summary.json` + `updates.jsonl` | session JSONL tree (v3) |
| Native todos | plan items in stream / turn plan | `plan.json` | extension-defined |
| Native plan mode | `TurnItem::Plan` | `plan_mode.json` | extension-defined |
| Auth | `auth.json` (api key / ChatGPT OAuth) | `auth.json` (scoped map) | `auth.json` (per provider) |
| Native TUI launch | `codex resume <id>` | `grok --resume <id>` | `pi --session <id>` |
| Worktree | `--worktree` | `-w/--worktree` | none → MutiAgent-managed |

Details, including which flags were verified in source: [`reference/agents.md`](reference/agents.md).

## 7. Runtime behaviour

### 7.1 Activation

1. The bundle's patch inserts two rows: the host plugin and the client row.
2. The host plugin probes for each adapter binary and constructs only the adapters whose
   capability probe succeeds; a missing binary is a *diagnostic*, never a load failure
   (a machine without Grok must still boot MutiAgent).
3. Services are published on the Cordis context under `mutiAgent` (ADR-0006).
4. When the Web host is present, the HTTP gateway registers exact fetch routes on the
   shared, authenticated `/api` channel (ADR-0004). In the headless profile the same
   service graph loads without the gateway.
5. The session index starts a background warm scan; the UI is usable immediately and
   fills in as scans complete.

### 7.2 One delegated run

```
GUI / dsh agent / external MCP client
  → mutiagent tool or POST /api/mutiagent/rpc  { method: 'run.start', … }
  → orchestration.prepare()  : resolve agent, create/locate worktree, snapshot shared
                              todos+plan, compose the injected context block
  → adapter.run(request)     : spawn native binary in the worktree cwd
  → AgentRunEvent stream     : normalized events → SSE + session log + todo/plan sync
  → run.finished             : finalize worktree diff, publish progress record
```

### 7.3 Failure model

Structured `MutiAgentError` with a code namespace (`detection/*`, `auth/*`, `session/*`,
`run/*`, `worktree/*`, `schema/*`, `harness/*`). Every failure surfaced to a human names
the agent, the operation, and the remediation. Adapters never swallow a native non-zero
exit; they classify it (`auth-required`, `rate-limited`, `cancelled`, `policy-blocked`,
`agent-crashed`) and preserve the tail of native stderr for diagnosis.

## 8. Security posture

- **Trust boundary** is the harness's own: our HTTP routes ride the authenticated
  `/api` channel, so an unauthenticated or cross-site browser request never reaches us
  (ADR-0004, ADR-0013).
- **We never write into another agent's store.** Session reads are read-only; imports
  create *links* in our own index (ADR-0012). The only files MutiAgent writes are its own
  state directory and the git worktrees it creates.
- **Credentials are never copied.** MutiAgent inspects credential files to *report*
  status and delegates login/logout to the native CLI. Secrets are redacted before
  leaving the host process and are never rendered into a transcript (ADR-0010).
- **Processes are spawned with an explicit environment**: only the variables an agent
  needs, never the harness's whole environment, and never MutiAgent's own tokens.

## 9. Repository layout

```
docs/                     architecture, ADRs, reference, operations
packages/contracts/       canonical schema (L1)
packages/core/            domain services (L3) + adapter SPI (L2 boundary)
packages/adapter-*/       one package per agent (L2)
packages/control-plane/   HTTP + SSE + MCP + tool catalog (L4)
packages/plugin/          the installable dsh bundle (L4 host entry + L5 client)
  src/host/               cordis plugin: services, tools, routes
  src/client/             browser bundle: slots, views, styles, locales
  cordis.patch.yml        loader rows
  locale/                 plugin display metadata (en, zh)
  icon.svg
scripts/                  build, verify, install helpers
tests/                    contract, fixture-replay, integration
```

## 10. Related documents

- [`adr/`](adr) — decision records, each with context, decision, consequences.
- [`reference/schema.md`](reference/schema.md) — field-level canonical schema.
- [`reference/agents.md`](reference/agents.md) — verified per-agent integration facts.
- [`reference/harness-gaps.md`](reference/harness-gaps.md) — what the harness does not
  let an out-of-tree plugin do, and our workaround.
- [`operations/install.md`](operations/install.md) — install, configure, verify.
