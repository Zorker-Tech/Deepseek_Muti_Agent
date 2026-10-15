# Architecture Decision Records

| # | Title | Status | Area |
|---|---|---|---|
| [0001](0001-distribution-as-a-dsh-bundle.md) | Ship as a DeepSeek Harness bundle (out-of-tree plugin set) | Accepted | distribution |
| [0002](0002-unified-agent-schema.md) | A canonical agent schema with lossy, declared projections | Accepted | schema |
| [0003](0003-per-agent-transport-strategy.md) | Per-agent transport strategy: headless exec first, duplex when needed | Accepted | adapters |
| [0004](0004-host-client-transport.md) | Host↔client transport: authenticated fetch routes + SSE, not Typert RPC | Accepted | wire |
| [0005](0005-client-bundle-format.md) | Client bundle format and build face | Accepted | build/UI |
| [0006](0006-zero-mandatory-harness-imports.md) | Zero mandatory harness imports; capability probes instead of assumptions | Accepted | integration |
| [0007](0007-sidebar-session-partitioning.md) | Sidebar session partitioning: an additive Agent Sessions panel | Accepted | UI |
| [0008](0008-worktree-isolation-and-progress.md) | Code isolation with git worktrees, and cross-agent progress follow-up | Accepted | isolation |
| [0009](0009-todo-plan-sharing.md) | Collaborative todo and plan sharing across agents | Accepted | collaboration |
| [0010](0010-credentials-delegation.md) | Credential management by delegation plus read-only inspection | Accepted | credentials |
| [0011](0011-mcp-control-plane.md) | MCP control plane: one tool catalog, three surfaces | Accepted | surface |
| [0012](0012-session-import-link-only.md) | Foreign sessions are indexed by link, never imported by copy | Accepted | sessions |
| [0013](0013-verification-strategy.md) | Verification strategy: fixtures, contract tests, and a real harness run | Accepted | quality |
| [0014](0014-managed-process-execution.md) | Managed process execution: explicit environment, process groups, classified exits | Accepted | runtime |

## How to add one

Write the decision you actually made, in the tense of a decision, and record what you
gave up. An ADR that lists only benefits is a press release: the *Consequences* section
must name the accepted costs and the alternatives considered, because those are what a
future reader needs when the trade-off stops looking obvious.

Format: `NNNN-short-slug.md`, with **Status**, **Date**, **Deciders**, **Context**,
**Decision**, **Consequences** (positive and negative), **Alternatives considered**.

Superseding an ADR: leave the old file in place, change its status to
`Superseded by ADR-NNNN`, and write the new one. Never rewrite a decision's history —
it is the only record of why the current state is the way it is.
