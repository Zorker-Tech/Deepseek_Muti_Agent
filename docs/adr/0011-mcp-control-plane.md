# ADR-0011 — MCP control plane: one tool catalog, three surfaces

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

The stated idea was: MutiAgent acts as the console, exposing its capabilities either as an
MCP service (MCP tools) or by injecting native tools directly.

Facts:

- The harness **consumes** MCP (`@deepseek-ai/dsh-mcp-client`: stdio and streamable HTTP,
  tools named `mcp__<server>__<tool>`). It has **no MCP server package** and no
  extension point to register one; exposing the harness itself is done through ACP or the
  JSON-RPC SDK instead.
- The harness **injects** tools natively through `ctx.tools.register(...)`, which is what
  makes them available to the harness's own agent and to the Web UI's tool cards.
- Grok and Pi both have MCP *client* support configured by the user, and Codex has
  `mcp_servers` — so a MutiAgent MCP server is also a way for one of the *agents* to pull
  the shared board mid-turn (ADR-0009), or for an unrelated orchestrator (Claude Code,
  an IDE, a CI job) to drive the mesh.

So MCP does not replace native tools; the two serve different consumers, and both are
worth having — but they must never diverge into two implementations.

## Decision

**One ordered catalog, three surfaces, generated from a single declaration.**

1. **A single operation registry.** Every capability is declared once as a
   `MeshOperation`: `{ id, summary, paramsSchema, resultSchema, scope, danger, handler }`.
   `scope` is `read | mutate | dangerous`; `danger` describes reversibility
   (`safe | needs-confirm | irreversible`). Adapters and services register operations as
   effects; nothing else defines a tool.
2. **Surface A — native harness tools** (`ctx.tools.register`). Each operation with
   `scope !== 'read' || exposeRead` becomes a tool named `mutiagent_<id with _>`. This is
   how the harness's own agent drives the mesh, and it gets the harness's permission
   prompts, cards and logging for free.
3. **Surface B — MCP server** exposing the *same* operations:
   - **stdio** — the transport every MCP client supports; started as
     `<node> <bundle>/lib/mcp-stdio.js` with no arguments.
   - **streamable HTTP** — mounted on the harness's own web server when available, on a
     configurable path (default `/mutiagent/mcp`), so an agent or IDE that speaks HTTP
     MCP needs no process spawn.
   The MCP server is implemented in-tree against the MCP wire format for the subset we
   need (initialize, tools/list, tools/call, ping) rather than vendoring an SDK, because
   the dependency would be shipped into a harness host process and the required surface is
   small and stable. The implementer is isolated behind `src/mcp/server.ts` so an SDK can
   replace it without touching the catalog.
4. **Surface C — HTTP JSON gateway** for the GUI (ADR-0004). Same operations, envelope
   `{ method, params }`, and the same schemas — the client's TypeScript types are derived
   from the contracts package, so a schema change breaks the build rather than the wire.
5. **Naming and discoverability.** Operation ids are stable, dotted lower snake case
   (`session.list`, `run.start`, `todos.set`, `worktree.create`). `mutiagent.methods`
   (`GET`-shaped) and MCP `tools/list` both return the catalog including `scope`, `danger`
   and the JSON schemas, so an agent can plan before acting.
6. **Confirmation discipline.** Operations whose `danger` is `needs-confirm` or
   `irreversible` (integrating worktrees, deleting a worktree with unmerged commits,
   cancelling a run, logging out) return a `confirmation` object instead of acting when
   `params.confirm !== true`. This holds on all three surfaces identically — an MCP client
   does not get a weaker gate than the GUI.
7. **External MCP egress is optional.** MutiAgent can register the harness's
   `mcp-client` implicitly? No: we never auto-install harness plugins. Instead the plugin
   publishes a ready-to-paste MCP server configuration (`mutiagent.mcpConfig`) for Grok,
   Pi and Codex, and documents it. Wiring another agent to our MCP server is the user's
   explicit act.
8. **Degradation.** If `ctx.tools` is absent, Surface A is skipped and diagnosed; if the
   web server is absent, only the HTTP MCP listener is skipped; the stdio MCP server is
   always available because it needs nothing from the harness.

## Consequences

**Positive**

- A new capability is added in exactly one place and appears in the GUI, to the harness
  agent, and to external MCP clients at once — with identical validation and gating.
- The harness agent can orchestrate other agents using the same tools a human uses in the
  GUI, and the transcript shows it.
- External orchestrators are not second-class: they get the whole control plane.

**Negative / accepted costs**

- We own a small MCP protocol implementation (framing, initialize negotiation, tool
  listing/calling). It is deliberately minimal; no resources, prompts, sampling or
  notifications beyond what we need. Risk accepted and isolated in one module.
- Three surfaces mean three places to enforce confirmation/redaction. Mitigated by
  enforcing both in the shared dispatch layer, not per surface; a test asserts that a
  dangerous operation is gated identically on all three.
- Tool-name surface in the harness grows with the catalog. Mitigated by keeping the
  catalog deliberately small (see `docs/reference/tools.md`) and read-only operations
  compact.

## Alternatives considered

- **MCP server only.** Rejected: the harness agent would have to be configured as an MCP
  client of ourselves, and MCP tools bypass the harness's native tool cards/logging, so
  the work would be invisible in the transcript.
- **Native tools only.** Rejected: closes the door on external orchestrators and on agents
  pulling the shared board through MCP, which is a design goal.
- **Use `@modelcontextprotocol/sdk` for the server.** Deferred, not rejected: it is the
  right move if our surface grows (resources, prompts, notifications). For the current
  subset it would add a shipped dependency and an SDK-version coupling into every user's
  host process for little benefit. `src/mcp/server.ts` is written so the swap is local.
- **Expose the mesh through ACP** (which the harness does support, and which Grok speaks).
  Deferred: ACP is designed for driving a coding agent with a TUI client, not for
  orchestrating a fleet; and harness ACP is documented as automation-only with a fixed
  session model. Revisit if a target agent only speaks ACP.
