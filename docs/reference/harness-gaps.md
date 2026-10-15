# DeepSeek Harness gaps for an out-of-tree multi-agent plugin

Verified against `deepseek-ai/deepseek-harness` `0.2.1-alpha.3` (`571902028a`).
Each entry states what is missing, the evidence, what MutiAgent does instead, and what a
harness change would let us do better. Nothing here is a complaint for its own sake: these
are the seams where our design carries extra weight because the harness does not provide
one, and they are what to revisit on a harness upgrade.

## G1 — No MCP server package or extension point

**What is missing.** The harness consumes MCP (`@deepseek-ai/dsh-mcp-client`, stdio and
streamable HTTP) but ships no MCP server and no registry for one. `@modelcontextprotocol/server`
appears only as a devDependency of the client's tests. Exposing the harness to other tools
is done through ACP (automation-only) or the JSON-RPC SDK.

**Evidence.** `packages/mcp/` contains only `mcp-client`, `mcp-resources`; there is no
server-side transport or handler registration.

**What MutiAgent does.** Implements the MCP server subset it needs itself
(`packages/control-plane/src/mcp/`): `initialize`, `tools/list`, `tools/call`, `ping`, over
stdio and streamable HTTP. This is ADR-0011.

**What would help.** A `ctx.mcpServers` (or similar) registry accepting a server handler,
so plugins expose tools without each vendor shipping a protocol implementation and an SDK
version.

## G2 — No extension point for session-list grouping or foreign session sources

**What is missing.** The sidebar's session browser is a `single` slot
(`sidebar.workspaces`) owned by `ui-workspace`; grouping is internal
(`deriveGroups()` over the Host workspace list plus an "Ungrouped" bucket). There is no
list slot for additional session sections and no way to contribute a session source.

**Evidence.** `packages/client/ui-sidebar/src/client/contract/slots.ts` (sidebar seats),
`packages/client/ui-workspace/src/client/tree.ts` (`deriveGroups`, `UNGROUPED_KEY`), and
the `single` kind on `sidebar.workspaces` in `ui-layout`'s `AppFrame` registration.

**What MutiAgent does.** Adds its own `sidebar.panellist` row plus a `main` page rendering
per-agent partitions, and decorates native rows additively via
`sidebar.session.row.leading`. It does not replace the native browser. This is ADR-0007.

**What would help.** A `list`-kind slot for sidebar browsers, or a documented
"session group provider" so a plugin can contribute sections into the native list.

## G3 — Event forwarding to the client is allowlisted in-tree

**What is missing.** Browser event delivery uses a fixed allowlist
(`API_REMOTE_FORWARDED_EVENTS` in `packages/api/remotes/src/remote-events.ts`). An
out-of-tree plugin cannot add its own events to it.

**What MutiAgent does.** Owns an SSE endpoint on the authenticated `/api` channel with the
same cookie, so live updates flow without touching the allowlist (ADR-0004).

**What would help.** A registration API for forwarded events (with the same scope
filtering), which would remove our need for a second streaming mechanism.

## G4 — Typed RPC requires in-tree participation

**What is missing.** `@Remote`/Typert services need the in-tree generator and
`@deepseek-ai/dsh-api-remotes` client assembly. `@deepseek-ai/dsh-api-remotes` (and friends)
are workspace packages, not published for third parties.

**What MutiAgent does.** Uses `ctx.connection.fetch.register` for both the RPC envelope and
SSE, inheriting the harness's browser-trust fence, and derives client types from our own
contracts package (ADR-0004).

**What would help.** Publishing the Typert generator/registry for out-of-tree consumers, or
documenting the exact-route + admission path as a supported public seam (today it is only
visible by reading the source).

## G5 — No provider registry for "external agent CLIs"

**What is missing.** `ctx.subagents.registerProvider` exists and ships providers for Codex,
Claude Code, ACP and the dsh SDK — but the contract is a **delegated one-shot child**
(`SubagentProvider`), not "another product whose sessions I enumerate, authenticate,
isolate and display".

**Evidence.** `packages/subagent/subagent/src/types.ts` (`SubagentProvider`,
`ResolvedSubagentStartRequest`, `NO_START_CAPABILITIES`), and
`packages/subagent/README.md`'s provider table.

**What MutiAgent does.** Defines its own `AgentAdapter` SPI in `@zorker/muti-agent-core`
covering detection, capabilities, auth, session reading, native task extraction, run
dispatch and native launch — a superset of what `SubagentProvider` expresses (ADR-0002,
ADR-0003). Where a harness subagent provider exists for the same agent (Codex), the two
are complementary: the harness's provider serves in-harness delegation, ours serves the
control plane.

**What would help.** Nothing strictly required. If the harness ever generalizes
`SubagentProvider` into a full agent-integration seam with session enumeration and auth,
we would implement it as an *additional* adapter output rather than replacing ours.

## G6 — No worktree/workspace isolation seam

**What is missing.** `ctx.workspaceRegistry` models workspace *entities* (id, path, title,
session membership) — it does not create or track git worktrees, and there is no
"execution sandbox" abstraction a plugin can register.

**What MutiAgent does.** Owns worktree lifecycle with plain `git`, records `MeshWorkspace`
state, and follows progress by sampling (ADR-0008). We deliberately keep git commands in
one module so the harness can take over if a seam appears.

**What would help.** A worktree/isolation provider seam, especially one that already
handles Windows path and lock edge cases.

## G7 — Client bundle envelope is an in-tree build detail

**What is missing.** The `window.__ModuleLoader__.load({id, factory})` CJS-closure format
and the externals/purity rules come from `packages/client/tsdown.client.ts` and
`packages/client/AGENTS.md`. There is no published schema or helper for third-party
bundlers.

**What MutiAgent does.** Reproduces the envelope byte-for-byte with esbuild and verifies it
with `scripts/verify-client-bundle.mjs` (ADR-0005).

**What would help.** A published `dsh-client-manifest` schema or a small
`@deepseek-ai/dsh-client-plugin-build` package, so the contract is checked rather than
copied.

## G8 — Foreign sessions cannot appear in the harness's own session search

**What is missing.** `ctx.sessionQuery` indexes harness session generations only.

**What MutiAgent does.** Keeps its own index and search over linked foreign sessions, and
never writes harness session files (ADR-0012).

**What would help.** A documented way to contribute an external session *source* to
`sessionQuery`, which would unify search without violating the harness's session-format
obligations.

## G9 — Tool presentation is documented but tool registration is not versioned

**What is missing.** Our tools are registered structurally (ADR-0006) because importing
`@deepseek-ai/dsh-tools`'s `defineTool` would couple the plugin to a pre-stable API. The
*shape* of `ToolDefinition` (including `presentCall`, `output.render`, projection rules)
is documented in `docs/cookbook/adding-a-tool.md` but not published as a versioned schema.

**What MutiAgent does.** Probes for the tools service, attempts an optional dynamic import
of the helper, and falls back to a structurally equivalent definition. A harness change to
tool definitions therefore degrades one feature with a diagnostic instead of failing boot
(ADR-0006).

**What would help.** A published JSON Schema (or a `tool-contract` package version) for
tool definitions, so third-party tools can be validated at install time.
