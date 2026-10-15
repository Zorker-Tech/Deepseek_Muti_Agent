# ADR-0006 — Zero mandatory harness imports; capability probes instead of assumptions

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

An out-of-tree bundle is loaded by the harness's Cordis loader in the profile process.
The launcher computes an immutable `RuntimeResolution` and installs `ctx.pluginPackages`
interception so that bundle dependency specifiers resolve to the CLI installation's
closure or the bundle's own closure. In principle a plugin may therefore
`import { defineTool } from '@deepseek-ai/dsh-tools'`.

In practice that couples us to:

- the harness throwing a **hard load failure** if a named export is renamed or removed —
  we would break the user's whole profile boot, not just our feature;
- the pre-stable API caveat in the harness's own `AGENTS.md`
  ("Public APIs are pre-stable; update every consumer");
- a version-skew window: our published bundle against a user's older/newer harness.

The harness gives us one object that is stable by construction: the Cordis `Context`
and the service-first protocol (`ctx.tools`, `ctx.commands`, `ctx.effect`, `ctx.on`,
`ctx.provide`, `ctx.get`, `ctx.inject`). Registries are reached as *services*, and
presence is queryable.

## Decision

1. **No mandatory runtime import of any `@deepseek-ai/*` package.** The host bundle's
   only runtime dependencies are Node builtins. Harness packages appear as **type-only
   imports** (`import type { Context } from '@deepseek-ai/cordis'`), which are erased.
2. **Every harness capability is probed, then used.** A capability probe is a small
   function that asks the live context whether the seam exists and what it accepts:
   - `ctx.get('tools')` present → register tools; absent → skip, add a diagnostic
     (`harness/tools-unavailable`).
   - `ctx.get('connection')` with a `fetch.register` function → register routes; absent →
     run headless-only.
   - `ctx.get('webServer')` → optional raw routes for the MCP HTTP listener.
   - `ctx.get('commands')`, `ctx.get('settings')`, `ctx.get('workspaceRegistry')`,
     `ctx.get('sessions')` → each optional.
3. **Harness helpers are not imported at all when the shape is small enough to build
   structurally.** Building a tool definition (`{ name, description, parameters, output }`
   with plain JSON Schema and a pure `render`) is less code than probing for the in-tree
   helper and maintaining two paths, and it removes a boot failure mode rather than
   managing it. We therefore declare tool definitions structurally and let the harness's
   `tools.register` validate them. Where a helper would genuinely replace non-trivial
   logic, the rule is a dynamic `import()` inside `apply`, wrapped in a classified catch,
   with a documented fallback — not a static import.
4. **Version reporting is diagnostic, never gating.** The plugin reports the detected
   harness version (`ctx.get('host')?.… version` or `ctx.cmdlineArgs`) and the adapters'
   binary versions in `mutiagent.diagnostics`. Only an explicit `dsh.bundle` peer/engine
   declaration blocks installation, and the harness enforces that itself.
5. **Fail loud, fail contained.** A probe that throws downgrades one capability and
   records a diagnostic; it never throws out of `apply`. A missing agent binary is a
   capability absence, not an activation error — a machine without Codex must still boot
   MutiAgent and serve the other agents.

## Consequences

**Positive**

- The plugin boots on a range of harness revisions; a renamed export costs a degraded
  feature, not a broken profile — a materially better failure mode than a load crash.
- Our host bundle has no resolution dependency on the harness closure, so the same
  artifact works from a linked checkout, a tarball, or a git install.
- Diagnostics become a first-class product surface: "MutiAgent is running, native tools
  unavailable, reason: tools service absent" is actionable.

**Negative / accepted costs**

- Structural typing of harness seams: we hand-maintain minimal interfaces for the ctx
  services we call. Mitigated by keeping them in one module
  (`packages/plugin/src/host/harness.ts`) and by integration tests that assert our calls
  are accepted by the real services when a harness is present.
- We lose some type-checking strength relative to in-tree code: the compiler cannot prove
  a hand-written seam interface matches the real one. The integration test tier (ADR-0013)
  is what actually proves it.
- Two code paths for tool definition (native helper, fallback). Bounded to one function.

## Alternatives considered

- **Import `@deepseek-ai/dsh-tools` and siblings directly.** Rejected: converts every
  upstream rename into a profile-boot failure for our users, and contradicts the
  "pre-stable APIs" warning in the harness's own contributor guide.
- **Vendor the harness packages we need.** Rejected: harvesting the `tools` registry
  contract would not give us the live registry object, which only the host process can
  provide; and vendoring would pin us to a snapshot while pretending otherwise.
- **Require a specific harness version via `engines.dsh`.** Done anyway as a guard rail,
  but not as the strategy: a version gate answers "may I install" and not "what works
  here", and a user on an untested-but-compatible revision would be blocked for no reason.
