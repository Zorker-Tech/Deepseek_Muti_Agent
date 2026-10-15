# ADR-0001 — Ship as a DeepSeek Harness bundle (out-of-tree plugin set)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture
- **Supersedes:** —

## Context

MutiAgent must add a multi-agent control plane to DeepSeek Harness (`dsh`): unified
schema across heterogeneous CLI agents, per-agent sidebar partitions, multi-agent
orchestration, worktree isolation, credential management, and an MCP surface.

DeepSeek Harness is an all-plugin Cordis application. Two distribution shapes exist:

1. **In-tree package** — a workspace package under `packages/<group>/<pkg>/`, added to a
   bundle patch, `tsconfig` references, and `apps/cli/package.json` dependencies. Requires
   forking or upstreaming into `deepseek-ai/deepseek-harness`.
2. **Out-of-tree bundle** — a package declaring `dsh.bundle.patch`, installed into a
   profile by `dsh plugin --profile <name> add <path|spec>`. The launcher stacks the
   bundle's patch document onto the profile's composition; `ClientModuleRegistry`
   incrementally picks up `dsh.client` rows and serves the prebuilt browser bundle.

The project must live in its own repository (`Zorker-Tech/Deepseek_Muti_Agent`) and
must be installable by users who have a stock `dsh` installation.

## Decision

Ship MutiAgent as an **out-of-tree bundle**, authored in its own pnpm monorepo, and
distribute exactly **one installable package**: `@zorker/muti-agent-plugin`.

- The monorepo carries separated domain packages (`contracts`, `core`, `adapter-*`,
  `control-plane`) for testability and review.
- The plugin package **bundles** those workspace dependencies into self-contained
  `lib/` artifacts at build time (esbuild, CJS for the client face, ESM for the host
  face). Consumers install one package and never resolve our internal packages.
- The bundle owns its own `cordis.patch.yml`, `locale/*.json`, and `icon.svg`, matching
  the harness's Host-plugin checklist.

We do **not** modify DeepSeek Harness. Where a required extension point does not exist,
we extend through the harness's documented public seams (see ADR-0004, ADR-0007) or
record the gap explicitly.

## Consequences

**Positive**

- Independent release cadence; no harness fork to rebase.
- `dsh plugin add` is the entire install path, and `plugin_manager` can install it from
  the Web UI or from an agent.
- Removing the bundle returns the harness to stock behavior.

**Negative / accepted costs**

- We are consumers of a **pre-stable** harness API surface (harness `0.2.1-alpha.3`).
  Upstream renames will break us; we pin the supported range via `engines.dsh` and probe
  capabilities at runtime rather than assuming them (ADR-0006).
- The browser bundle must emit the harness's CJS closure-factory format
  (`window.__ModuleLoader__.load({id, factory})`) with the module-table baseline
  externalized. We own that build step (ADR-0005).
- We cannot land changes in harness packages; anything genuinely impossible out-of-tree
  is raised as an upstream request and recorded in `docs/reference/harness-gaps.md`.

## Alternatives considered

- **Fork DeepSeek Harness and develop in-tree.** Rejected: couples the product to one
  harness revision, contradicts the stated goal of plugging into *any* harness
  installation, and makes upgrades a merge conflict exercise.
- **Build a separate application that drives `dsh` and the other agents as subprocesses
  only (no GUI integration).** Rejected: the requirement is explicitly that the
  partitioned session sidebar, command palette entries and settings pages appear inside
  the harness GUI.
- **Distribute many packages and let the profile install all of them.** Rejected: each
  extra package is another resolver-manifest row, another version to pin, and another
  chance for the profile's `pnpm` graph to drift. One facade artifact, internal
  modularity.
