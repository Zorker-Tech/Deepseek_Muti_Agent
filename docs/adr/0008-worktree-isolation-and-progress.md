# ADR-0008 — Code isolation with git worktrees, and cross-agent progress follow-up

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

Parallel agents editing one working tree corrupt each other: two agents rewrite the same
file, one reverts the other's change, and `git status` becomes unreadable. The requirement
is explicit — when agents collaborate they must be code-isolated (worktrees are named as
the mechanism), and there must be a constraint that follows each agent's
workspace/worktree progress so functional and code conflicts are reduced.

What the agents themselves do:

| Agent | Native worktree support |
|---|---|
| Codex | `--worktree` on the CLI (fork-specific), plus `codex_worktrees` internal MCP tools |
| Grok | first-class: `-w/--worktree[=name]`, `--worktree-ref`, and a rich `x.ai/git/worktree/*` ACP surface |
| Pi | none |

They also differ in *when* they create it and whether it is tracked in their own session
metadata. Relying on each agent's native flag would give three different behaviors, three
different directory layouts, and no way to see all of them together.

## Decision

**MutiAgent owns the worktree lifecycle** for every delegated run, uniformly:

1. **Creation.** Before a run, the orchestration layer resolves whether isolation is
   required. If yes, it creates a worktree with `git worktree add` from the task's
   repository, on a new branch, under a managed root:
   `<repo>/.mutiagent/worktrees/<agentId>/<runId>` (configurable root; `.mutiagent/` is
   added to `.git/info/exclude`, never to the user's tracked `.gitignore`).
   The managed root is inside the repo so relative tooling keeps working, and excluded so
   the user's `git status` stays clean. Fallback to `$DSH_HOME/mutiagent/worktrees` when
   the repository cannot host it (read-only tree, submodule, bare-ish checkout).
2. **Runs are dispatched with `cwd = worktree`.** We never pass an agent's own
   worktree flag, so behavior is identical across agents and there is exactly one place
   that decides isolation. A native flag remains available through the adapter extension
   escape hatch for users who want it.
3. **Ownership is recorded** in a `MeshWorkspace` record: worktree path, branch, base
   commit, owning agent, run id, lock state, and the session(s) bound to it.
   Records persist in `$DSH_HOME/mutiagent/state.json` (plus an append-only journal), so
   they survive a harness restart; a worktree present on disk but absent from state is
   reported as `orphan` and never adopted silently.
4. **Progress follow-up is a first-class, continuous mechanism.** A watcher samples each
   active worktree on a schedule and on run events, recording per worktree:
   - `head` commit and branch, ahead/behind its base, commits added;
   - `git status --porcelain` → changed/added/deleted/untracked file sets;
   - per-file insertions/deletions via `git diff --numstat <base>...HEAD` plus the working
     tree diff;
   - last activity timestamp and whether the agent process is still alive.
   The watcher emits `progress.changed` events (ADR-0004) and updates `MeshWorkspace`.
5. **Conflict detection is explicit and early.** Because every active worktree's changed
   file set is known, the coordinator computes, for every pair of worktrees sharing a base
   repository:
   - **code conflicts**: identical paths touched by both (graded `same-file`, and
     `same-hunk` when the diff hunk ranges overlap within the file);
   - **functional conflicts**: both touched files that belong to the same configured
     "feature boundary" (directory/module globs from settings), even when the paths differ;
   - **base drift**: worktree created from an older commit than a sibling's, so a
     three-way merge would be non-trivial.
   Warnings are surfaced in the mesh panel and returned from the tools *before* a merge is
   attempted. Detection is advisory: it never blocks a run unless
   `worktree.conflictPolicy = 'block'` is configured.
6. **Integration is not automatic.** MutiAgent reports and proposes a merge order
   (`mesh_integrate_plan`); actually merging/rebasing is an explicit, confirmed action
   (`mesh_integrate`), performed with plain `git` in a clean state, and it refuses when
   the target worktree has uncommitted changes.
7. **Cleanup is explicit.** `mesh_worktree_remove` frees a worktree; the default policy
   for a worktree with unmerged commits is `retain` (report, do not delete), because
   silently discarding an agent's work is unrecoverable. `auto` removes only clean,
   merged worktrees after the run ends.

## Consequences

**Positive**

- One isolation model for all agents; a fourth agent needs no worktree code.
- Conflict risk becomes visible while agents are still running, not at merge time.
- Nothing is written into the user's tracked files; `.git/info/exclude` is local-only.
- Worktrees are ordinary git worktrees, so the user can inspect, commit and merge them
  with their normal tools.

**Negative / accepted costs**

- We depend on `git` being present and the target being a git repository. A non-repo task
  degrades to shared-cwd execution with an explicit `worktree/isolation-unavailable` note
  on the run — never a silent fall back to shared state.
- Sampling is polling, so progress lags by up to one interval (default 5 s, relaxed to
  30 s when idle). Disk-watching was rejected as disproportionate for the benefit.
- Filesystem-level conflict detection is heuristic: two agents can still conflict
  semantically in different files. The tool output says so rather than implying certainty.
- Disk usage grows with parallel worktrees; the cleanup policy and a size report
  (`mesh_worktree_list` includes bytes changed) keep it manageable.

## Alternatives considered

- **Use each agent's native worktree flag.** Rejected: no uniform layout, no unified
  progress view, Pi has none at all, and we would be unable to correlate a worktree with
  the run that owns it.
- **One shared tree, lock files per path.** Rejected: agents do not honor advisory locks,
  and a partially locked tree produces exactly the interleaved edits isolation prevents.
- **A container or VM per agent.** Correct and heavy: neither Codex, Grok nor Pi is
  container-first, and it would break local caches, credential files and the user's
  editor integration. Noted as a future isolation tier behind the same `MeshWorkspace`
  abstraction.
- **Copy the tree instead of a worktree.** Rejected: not a git repository (loses history
  for diffing/merging), degenerate hard-link semantics, and much more expensive.
