# ADR-0007 — Sidebar session partitioning: an additive Agent Sessions panel, not a replacement

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

The requirement is that after installing the plugin the sidebar is **partitioned per
agent**, so that Codex sessions, Grok sessions, Pi sessions and harness sessions are
visually separated.

What the harness actually offers (verified in source):

- `sidebar` is a **single** slot owned by `ui-layout`; the sidebar content is provided by
  `ui-sidebar`, which declares inner seats: `sidebar.panellist` (a **list** of panel
  icon rows), `sidebar.workspaces` (**single**, the session browser), `sidebar.settings`
  (single), `sidebar.footer.action` (list), `sidebar.brand.mark/name` (single).
- Session **grouping** is implemented inside `ui-workspace`: `deriveGroups()` builds
  sections from the Host workspace list plus one "Ungrouped" bucket. Ordering is
  `manual | updated`; archived/pinned come from the workspaces snapshot.
- `ui-workspace` declares row-level **additive** seats that any plugin may contribute to:
  `sidebar.workspaces.session.menu.item`, `sidebar.workspaces.session.row.action`,
  `sidebar.session.row.leading`, `sidebar.session.row.hover`.
- There is **no** extension point to add a new group/section to the session list, and no
  way to inject a foreign session source into it.

So "partition the sidebar per agent" has exactly three possible implementations:

1. **Replace `sidebar.workspaces`** with our own browser. Registering into a `single` slot
   replaces the shipped occupant, and the row seats *it* declared disappear with it. That
   removes pin/rename/fork/archive from every harness session and makes us responsible for
   reimplementing the workspace browser — and for tracking its changes on every harness
   upgrade.
2. **Decorate rows** via `sidebar.session.row.leading`. Additive and safe, but it only
   annotates sessions the harness already knows about. It cannot show Codex/Grok/Pi
   sessions, because those are not harness sessions and must not be (ADR-0012).
3. **Add our own panel** row to `sidebar.panellist` plus a `main` page, giving a
   full-window **Agent Sessions** browser with per-agent partitions.

## Decision

Adopt **(3) as the primary surface, plus (2) as a light enhancement**:

- **`sidebar.panellist` row + `main` page (`mutiagent.sessions`)** — the Agent Sessions
  browser. Its top level is **one partition per agent** (`Codex`, `Grok Build`, `Pi`,
  plus any future adapter), each expandable into that agent's sessions grouped by
  workspace/repository, with per-row metadata (model, branch, updated time, message
  count, auth/health badge). Partitions are collapsible and their open/closed state
  persists. Filters (agent, workspace, free text, needs-attention) and sorting
  (`updated`, `created`, `title`) apply across partitions.
- **A second panel row (`mutiagent.mesh`)** — the orchestration view: active delegated
  runs, their worktrees, cross-agent progress and conflict warnings, shared todo/plan
  board (ADR-0008, ADR-0009).
- **Row decoration on harness sessions** (`sidebar.session.row.leading`) showing a small
  agent badge — useful for worktrees and for harness sessions launched *by* MutiAgent on
  behalf of another agent, and harmless otherwise.
- **We do not register into `sidebar.workspaces`, `sidebar`, or `sidebar.brand.*`.**
  Those are "replace the app's identity/UX" moves; an integration plugin must be additive
  and removable.
- **Partition state and identity are canonical-schema objects**, so the browser view is
  driven by `AgentSession[]` grouped by `agentId` and never by native shapes (ADR-0002).

## Consequences

**Positive**

- Harness-native session UX is untouched: pin, rename, fork, archive, workspaces and the
  workspace tree keep working exactly as before.
- We can show sessions the harness does not own, which is the entire point of the feature.
- Uninstalling removes both rows and leaves no residue in the native browser.

**Negative / accepted costs**

- The agent partitions live one click away (a sidebar icon row) rather than inside the
  native session tree. This is a deliberate UX trade: it is the only additive placement
  the harness supports, and it keeps native and foreign sessions conceptually distinct.
- We own the whole Agent Sessions view: its layout, virtualization and search. Bounded by
  rendering a flat filtered list with the tokens of the host theme; no attempt to
  reproduce workspace drag-reordering.
- Cross-linking a foreign session into the harness's own tree (so it appears in
  `sidebar.workspaces`) is impossible, so "open" means *our* view's detail page or the
  native TUI launch — not the harness conversation view. Stated in the UI.

## Alternatives considered

- **Replace `sidebar.workspaces` and render a unified tree (workspaces → sessions, with an
  agent dimension).** This is the most literal reading of "sidebar is partitioned", and it
  was rejected for three reasons: it silently removes native session actions, it makes the
  plugin responsible for the workspace browser's evolution, and `single`-slot replacement
  is a hostile interaction between two plugins that both want it. Recorded here so the
  trade-off is not re-litigated; revisit only if the harness grows a *list* slot for
  sidebar browsers.
- **Only decorate rows (option 2).** Rejected as insufficient: foreign sessions would
  remain invisible, which fails the core requirement.
- **File foreign sessions into harness workspaces as pseudo-sessions.** Rejected: it would
  require writing harness session files for transcripts we do not own, which ADR-0012
  forbids and which would corrupt harness session semantics (projections, compaction,
  model-visible ⟺ logged).
