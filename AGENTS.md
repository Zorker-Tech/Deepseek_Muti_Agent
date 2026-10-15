# AGENTS.md

MutiAgent is a multi-agent control plane for DeepSeek Harness: one canonical schema, one GUI and one orchestration runtime across Codex, Grok Build and Pi. Read [docs/architecture.md](docs/architecture.md) before changing `packages/`, and the [ADRs](docs/adr/README.md) for why anything is the way it is — they are the decision record, and this file only carries what a contributor must not break.

## Layering

Dependencies point downward, and only downward:

```
contracts  →  core / adapter-*  →  control-plane  →  plugin
```

- `packages/contracts` imports nothing outside Node builtins and has no runtime dependency.
- `packages/core` implements the adapter SPI and the domain services; `packages/adapter-*` depend on contracts and core only.
- `packages/control-plane` owns the operation catalog and the three surfaces; it depends on core and contracts, never on an adapter package.
- `packages/plugin` is the only installable artifact and bundles everything else; `packages/plugin/src/client` imports contracts only and talks to the host over the HTTP/SSE surface, never host code (different build face, different runtime).
- A layering violation is a review blocker, not a style note: upward imports are what make an out-of-tree bundle break the user's profile boot.

## Engineering rules

These seven come from the ADRs and are enforced in code. A change that bends one needs an ADR that says why.

1. **Declared, not detected** ([ADR-0002](docs/adr/0002-unified-agent-schema.md)). Consumers branch on `AgentCapabilities`, never on an agent id. `capabilities()` is synchronous and must not depend on detection; only `describe().detection` reports what is on this machine. An unsupported feature renders as an explanation, never a dead control. A fourth agent is one package plus one registry entry, and no consumer changes.
2. **Read-only toward other products** ([ADR-0012](docs/adr/0012-session-import-link-only.md)). Never write into another agent's session or credential store. Import means link: MutiAgent owns an index, not a copy.
3. **No credentials stored** ([ADR-0010](docs/adr/0010-credentials-delegation.md)). Inspect credential state read-only, delegate login/logout to the agent's own CLI, redact on the way out. A credential value never reaches a projection, a log line, an argv element or a run record.
4. **One isolation model** ([ADR-0008](docs/adr/0008-worktree-isolation-and-progress.md)). MutiAgent owns the worktree for every delegated run and tells the agent where to work; no agent's own worktree flag is ever passed, so isolation is decided in exactly one place (`RunManager.dispatch`) and behaves the same for every agent.
5. **No mandatory harness imports** ([ADR-0006](docs/adr/0006-zero-mandatory-harness-imports.md)). Reach the harness only through the probed seams declared in `packages/plugin/src/host/harness.ts`. An absent seam is a diagnostic that disables one capability, never a load failure.
6. **Honest limits** ([ADR-0003](docs/adr/0003-per-agent-transport-strategy.md)). Where something is impossible out of tree — mid-turn injection into a foreign agent, steering a live turn over a one-shot transport — document it in the adapter README and [docs/reference/harness-gaps.md](docs/reference/harness-gaps.md), and surface it as an unavailable capability. Never approximate it silently.
7. **Registration only through effects** ([ADR-0011](docs/adr/0011-mcp-control-plane.md); the harness's own rule, reached through the `ctx.effect` seam named in [ADR-0006](docs/adr/0006-zero-mandatory-harness-imports.md)). Every contribution — tools, commands, routes, services — goes through `registerEffect`/`ctx.effect`, so unloading the plugin leaves nothing behind. A registry's `register()` returns the disposer.

## Verification: no claim without its tier

[ADR-0013](docs/adr/0013-verification-strategy.md) defines four tiers, and a claim is only made at the tier that actually proves it:

| Tier | What it proves |
|---|---|
| 1 — unit tests (`node:test`, no network, no processes) | Logic is correct for given inputs. |
| 2 — fixture replay per adapter | The recorded native format parses correctly for the recorded revision, losses included. |
| 3 — capability probes against an installed binary | Detection, version parsing, auth status and session enumeration work against the real CLI. Self-skips without the binary, and prints the skip. |
| 4 — integration in a real harness | The product works in the environment it ships into. The release gate. |

A feature is not "working" because tier 1–2 pass, and a rendered screenshot is not tier 4 evidence. Redaction is tested, not assumed: a submitted API key must never appear in an emitted envelope, a log line or a tool result. The dangerous-operation gate is tested on all three surfaces with the same expectation.

```sh
pnpm install
pnpm run typecheck   # tsc -b across all seven packages
pnpm run build       # emits the host bundle, client bundle and MCP entry into packages/plugin/lib
node scripts/verify-plugin.mjs   # loads the built bundle against a stub Cordis context and exercises all three surfaces
```

One naming correction: the README and `docs/operations/install.md` call the last check `pnpm run verify:plugin`, but `package.json` defines no such script (its `verify` entry points at a `scripts/verify.mjs` that does not exist). The runnable command is `node scripts/verify-plugin.mjs` until the script entries are fixed.

## Operation ids are a public surface

The catalog holds 38 operations; their ids appear in every surface, in recorded run context and in user scripts, so renaming one is a breaking change. Every id must match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` (`METHOD_PATTERN` in `packages/contracts/src/version.ts`); `OperationCatalog.register` throws at load for a violation or a duplicate id. New capabilities are declared once in `packages/control-plane/src/operations/register.ts`, and `mutiagent.methods` is how a client discovers the live set. Never add a second place that defines a tool, a route or a method name.

## Code style

- ESM everywhere (`"type": "module"`); relative imports carry the `.ts` extension; type-only imports use `import type`.
- Everything compiles under `strict: true`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (`tsconfig.base.json`). An optional property is added conditionally (`...(value === undefined ? {} : { value })`), never as `key: undefined`.
- No `any`, no new `as unknown` (or `as X as Y`) assertions, and no non-null assertions. Nine `as unknown` casts exist today: five at `JSON.parse` boundaries and four where a generic operation is erased into the catalog's internal map. They are the documented exceptions; do not add a tenth.
- Checked accesses over guesses: `array[0]` is `T | undefined` under `noUncheckedIndexedAccess`, and the code reads it as such (`matches.at(-1)?.[0]`, `?? undefined`, explicit guards).
- Every module and export has concise JSDoc; function-like exports carry `@param` and `@returns`. Module headers name the `@module`.
- Comments state the constraint that is not visible in the code — a native quirk, a reason an option must be in one position, a loss that must stay declared. They never narrate control flow or restate the next line.
- One home per fact: behavior shared by agents lives in `packages/core` or `@zorker/muti-agent-contracts`, not copied into three adapters. When two adapters need the same helper, extract it before the third copy.
- Error messages name the agent, the operation and the remediation; failures use `MutiAgentError` with a code from `ErrorCodes`, never a bare `Error`.

## Documentation duties

- A decision that changes a compatibility promise, a public surface or an operation id gets an ADR: `docs/adr/NNNN-short-slug.md`, with Status, Date, Deciders, Context, Decision, Consequences (including the accepted costs) and Alternatives considered. An ADR that lists only benefits is a press release.
- Never rewrite an ADR's history. Supersede it: set the old file's status to `Superseded by ADR-NNNN` and write the new one.
- `docs/reference/*` changes in the same commit as the code it describes: `schema.md` for the canonical types, `agents.md` for per-agent facts, `tools.md` for the catalog, `wire.md` for the envelope.
- Anchor claims in real file paths and, for another product's format, the revision it was verified against. If a document and the code disagree, fix the document and say which one was wrong.
- The `docs/reference/agents.md` "Verified against" block names the agent versions the facts are true for; update it when an adapter is re-verified.

## File layout

```
docs/
  architecture.md            layers, goals, runtime behavior, security posture
  adr/                       decision records
  reference/                 schema.md, agents.md, tools.md, wire.md, harness-gaps.md
  operations/install.md      install, configure, verify, uninstall
packages/
  contracts/                 canonical schema, validators, error codes, version constants
  core/                      adapter SPI, discovery, session index, runs, worktrees,
                             orchestration, credentials, process runner, state store
  adapter-codex/             Codex integration (src/{index,sessions,events,auth}.ts)
  adapter-grok/              Grok Build integration (same four files)
  adapter-pi/                Pi integration (same four files)
  control-plane/             operation catalog, dispatch, HTTP gateway, MCP server, native tools
  plugin/                    the installable bundle: host entry, client bundle, locales, patch
scripts/                     build and verification helpers
tests/                       fixture and integration tests
```

One adapter is four files with one job each: `index.ts` (detection, capabilities, run dispatch, launch command), `sessions.ts` (store reading and projection), `events.ts` (native stream to `AgentRunEvent`), `auth.ts` (credential inspection and delegation). Keep that split when extending one.
