# MutiAgent

**A multi-agent control plane for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —
one canonical schema, one GUI and one orchestration runtime for the coding agents you
already use.

```
Codex  ·  Grok Build  ·  Pi          (more agents are one package each)
   └──────────┬──────────┘
              │  unified schema + adapter SPI
      ┌───────▼────────┐
      │   MutiAgent    │  session index · worktree isolation · shared plan & todos
      │  (dsh plugin)  │  credential surface · run orchestration
      └───────┬────────┘
              │  three surfaces, one catalog
   ┌──────────┼──────────────┐
   │          │              │
native     MCP server    HTTP + SSE
tools      (stdio/HTTP)  (for the GUI)
```

## What it does

- **One schema across agents.** Every agent's sessions, transcripts, todos, plans,
  capabilities and credential state are projected onto one canonical model, with every
  loss declared rather than silently dropped. The GUI and every tool work against that
  model, so adding an agent needs no UI work.
- **Agent-partitioned sessions in the sidebar.** A dedicated *Agents* panel browses every
  agent's own session store, grouped per agent, filterable, with one-click tracking of
  discovered sessions. Native harness session UX is untouched.
- **Delegated runs in isolated worktrees.** Dispatch a task to any agent; MutiAgent
  creates a git worktree, runs the agent there, and streams normalized events back.
- **Cross-agent progress and conflict warnings.** Every worktree is sampled for changed
  files, commit position and clean/dirty state, and pairs are compared for same-file,
  same-hunk and same-feature-area conflicts *while agents are still working*.
- **Shared plan and todo board.** A collaboration owns one authoritative plan and one
  todo board; each delegated agent's context is built from them, and each agent's own
  todo state is folded back in.
- **Sign-in management in settings.** Status, login and logout for every agent, without
  leaving the harness — by delegating to each agent's own CLI. MutiAgent stores no
  credentials.
- **Three surfaces from one catalog.** 38 declared operations exposed as native harness
  tools, an MCP server (stdio and streamable HTTP) and an authenticated HTTP+SSE gateway,
  with identical validation and identical confirmation gates on all three.

## Install

```sh
# from a checkout of this repository
dsh plugin --profile <your-profile> add /absolute/path/to/Muti_Agent/packages/plugin

# or, from an agent or the Web UI, via the harness's own plugin manager
#   plugin_manager { action: "install_bundle", source: "/absolute/path/to/packages/plugin" }
```

Then boot the profile and open the **Agents** row in the sidebar. Full procedure,
including verification steps: [`docs/operations/install.md`](docs/operations/install.md).

Run the standalone MCP server (for another agent, an IDE, or a CI job):

```sh
MUTI_AGENT_STATE_DIR=~/.dsh/mutiagent node packages/plugin/lib/mcp-stdio.js
```

## Repository layout

```
docs/
  architecture.md            layers, goals, runtime behaviour, security posture
  adr/                       14 decision records — read these to understand why
  reference/                 schema, per-agent integration facts, tools, wire protocol,
                             and the harness gaps this plugin works around
  operations/install.md      install, configure, verify, uninstall
packages/
  contracts/                 canonical schema (types, validators, capability declaration)
  core/                      adapter SPI, process runner, session index, worktrees,
                             orchestration, credentials
  adapter-codex/             Codex integration
  adapter-grok/              Grok Build integration
  adapter-pi/                Pi integration
  control-plane/             operation catalog, MCP server, HTTP gateway, native tools
  plugin/                    THE INSTALLABLE BUNDLE (host entry + browser bundle + patch)
scripts/                     build, verify, install helpers
```

Only `@zorker/muti-agent-plugin` is installed; the rest are bundled into it.

## Documentation map

| Read this | To understand |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | The whole design in one pass |
| [`docs/adr/`](docs/adr/README.md) | Each decision, its consequences and what was rejected |
| [`docs/reference/schema.md`](docs/reference/schema.md) | The canonical schema field by field |
| [`docs/reference/agents.md`](docs/reference/agents.md) | What was verified about each agent, with sources |
| [`docs/reference/tools.md`](docs/reference/tools.md) | Every operation, its authority and its result |
| [`docs/reference/wire.md`](docs/reference/wire.md) | The HTTP, SSE and MCP contracts |
| [`docs/reference/harness-gaps.md`](docs/reference/harness-gaps.md) | Where the harness has no seam, and our workaround |

## Design commitments

These are enforced by the code and by the ADRs; they are what makes the project
maintainable rather than a pile of integrations.

1. **Declared, not detected.** Consumers branch on declared `AgentCapabilities`, never on
   an agent id. An unsupported feature renders as an explanation, never a dead control.
2. **Read-only toward other products.** MutiAgent never writes into another agent's
   session or credential store. Import means link, not copy.
3. **No credentials stored.** Status is read; login and logout are delegated to the
   agent's own CLI. Secrets are redacted at the boundary, tested.
4. **One isolation model.** MutiAgent owns worktrees for every agent; no agent's own
   worktree flag is used, so behaviour is uniform and there is one place to look.
5. **No mandatory harness imports.** Every harness seam is probed and every absence is a
   diagnostic, so a harness rename degrades one capability instead of breaking boot.
6. **Honest limits.** Where something is impossible out-of-tree (mid-turn injection into a
   foreign agent, contributing to the native session tree), it is documented and surfaced
   in the UI rather than approximated silently.

## Development

```sh
pnpm install
pnpm run typecheck      # tsc -b across all seven packages
pnpm run build          # emit host, client and MCP artifacts into packages/plugin/lib
pnpm run verify:plugin  # registration + all three surfaces, against a stub context
```

`pnpm run verify:plugin` is the fast gate: it loads the built bundle, exercises the RPC
gateway, a full MCP handshake, and asserts the dangerous-operation gates hold on both.

## Status

v0.1.0. Framework and the three adapters are complete and verified against the installed
binaries (Codex `codex-cli 0.156.1`, Grok Build `1.0.34`, Pi `1.2.0`) on the tested
harness revision. The duplex transport per agent (Codex app-server, Grok ACP, Pi RPC) is
scoped but not implemented; resumes, streaming and cancellation run over each agent's
headless mode ([ADR-0003](docs/adr/0003-per-agent-transport-strategy.md)).

## License

MIT.
