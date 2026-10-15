# ADR-0009 — Collaborative todo and plan sharing across agents

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

The requirement: when agents collaborate they share todos and share the plan. Each agent's
native model differs sharply:

| Agent | Todos | Plan |
|---|---|---|
| Codex | plan items in the exec stream / `turn/plan/updated` | plan mode items |
| Grok | `plan.json` in the session dir (`IndexMap<TodoId, TodoItem>`) | `plan_mode.json` |
| Pi | not built in (an example extension provides plan mode) | extension-defined |
| Harness (dsh) | `todo_write` → `todo/write` events, read via the `todos` session projection | `plan/mode` event + the `plan` projection |

There is no shared brain and no common storage. Crucially, **the foreign agents cannot be
made to read our storage**: they are separate processes with their own state and no plugin
API that would inject a todo list every turn.

An honest design has to distinguish what is *possible* from what is *desirable*:

- We **can** read each agent's todos/plan (where they exist) and normalize them.
- We **can** write a shared document and feed it into each agent's context **at dispatch
  time** (as injected instruction text), and refresh it on each subsequent dispatch.
- We **cannot** live-stream a mid-turn todo mutation *into* a foreign agent's context.
- We **can** fully stream the harness's own agent in both directions (its todo/plan are
  events in a session we own a projection for).

## Decision

1. **One shared document pair, owned by MutiAgent.** A *collaboration* (a mesh task group)
   owns a `SharedTodoDoc` (list of `AgentTodo` with an `owner` field) and a `SharedPlanDoc`
   (objective, ordered phases, current phase, decisions log). Stored durably in
   `$DSH_HOME/mutiagent/collaborations/<id>.json`, appended to as a journal, and published
   to the mesh event stream on every change.
2. **Todos are a union with per-item ownership.** Items are keyed by a canonical id;
   each is `{ id, content, status, owner: agentId | 'shared', blockedBy[], updatedAt }`.
   Agents may only mutate items they own plus shared items; a conflicting mutation of a
   foreign item is rejected with `schema/todo-conflict` rather than last-write-wins.
3. **Two directions, both declared.**
   - **Ingest (read):** after each turn and on a schedule, the adapter's
     `readNativeTasks(sessionId)` is polled; the normalized list is merged into the shared
     doc as *descriptive* items attributed to that agent. Native readings never overwrite
     an agent's own authored items (they update status only).
   - **Egress (write):** before each dispatch, the shared doc is rendered into a compact,
     deterministic **Context Block** and passed to the agent through the channel it
     actually supports: `--rules`/`--append-system-prompt`-equivalent flags where they
     exist (Grok: `--rules`; Pi: `--append-system-prompt`; Codex: instruction file
     injection in the worktree), and always as a leading section of the prompt itself so
     no agent depends on a flag. The render is idempotent and carries a content hash so
     re-dispatch does not duplicate it.
4. **Plan sharing is the stronger guarantee.** The `SharedPlanDoc` is *authoritative input*
   to every delegated agent (it is injected as above) and *observational output* from them
   (their plan-mode state is read and recorded as a phase proposal, never auto-applied).
   A phase transition requires `mesh_plan_set` or an explicit approval.
5. **The harness-side agent gets the real thing.** For dsh sessions we register a session
   projection and mirror todo/plan changes into the shared doc through the session event
   log — this is the only agent where collaboration is bidirectional in real time, and it
   is also where collaboration is most often initiated.
6. **Every operation is a tool and an RPC.** `mesh_todos_get`, `mesh_todos_set`,
   `mesh_todos_claim`, `mesh_plan_get`, `mesh_plan_set`, `mesh_plan_advance`. Also exposed
   over MCP (ADR-0011) so an external orchestrator, or one of the agents itself, can drive
   the shared board.
7. **No hidden prompting.** The Context Block is *visible*: it is stored with the run
   record, shown in the mesh panel under the run, and included in exports. An agent's
   behavior change caused by sharing must be inspectable after the fact.

## Consequences

**Positive**

- One board that humans and agents read the same way; "who is doing what" is answerable.
- Progress from non-cooperating agents is still captured, because ingest is read-only
  polling of their own stores.
- Deterministic injection means a delegated run is reproducible from its recorded inputs.

**Negative / accepted costs**

- Mid-turn egress is impossible for foreign agents; effective sharing latency is one turn.
  Documented in `reference/harness-gaps.md`; the UI labels foreign todos as
  "observed at turn boundary".
- Injecting a plan changes agent behavior by construction — it is a prompt. Mitigated by
  keeping the block small, factual, and inspectable, and by making its inclusion a
  per-collaboration setting (`share.plan: 'inject' | 'observe'`).
- We parse native todo formats that are not contractually stable (Grok's `plan.json`
  shape, Codex's plan items). Treated as best-effort: an unrecognized shape yields a
  `ProjectionNote` and no items, never fabricated ones.

## Alternatives considered

- **Single global todo list, last-write-wins.** Rejected: parallel agents would clobber
  each other's items and the loss would be invisible.
- **Let each agent keep its own list and only display them side by side.** Rejected as
  "not sharing": the requirement is that collaboration genuinely shares one plan, which
  implies a single authoritative document.
- **Write directly into each agent's native todo store** (e.g. Grok's `plan.json`, Codex's
  session records). Rejected: it means writing another product's private state; formats
  are versioned and unowned by us, and a malformed write could corrupt a real session.
  Contradicts ADR-0012.
- **Drive sharing through each agent's MCP support** so the agent pulls the board itself.
  Rejected as the *primary* path (only Grok and Pi have MCP clients configured by the user,
  Codex's is fork-dependent), but kept as an **optional accelerator**: an agent configured
  with MutiAgent's MCP server can pull the shared board mid-turn. This is why the MCP
  server exists in addition to the injection channel.
