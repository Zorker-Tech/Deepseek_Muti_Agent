/**
 * OMP's capability inventory: the built-in and custom tools, skills, MCP servers,
 * commands and context files a session will offer, read from OMP's own configuration and
 * resource directories (ADR-0002, ADR-0015).
 *
 * Nothing here executes OMP: the read is file-based and read-only, so a custom tool
 * module is listed by path and never imported (importing it would run the user's code),
 * and an MCP server's tools are listed as the `<server>` they will hang off rather than
 * enumerated, because the `mcp__<server>_<tool>` names exist only once a session
 * connects.
 *
 * Sources, in OMP's own precedence order, verified against oh-my-pi 18.11.0
 * (`docs/skills.md`, `docs/mcp-config.md`, `docs/custom-tools.md`,
 * `docs/context-files.md`, `docs/slash-command-internals.md`,
 * `src/tools/builtin-names.ts`, `src/tools/essential-tools.ts`,
 * `src/discovery/builtin.ts`):
 *
 * | Category | Sources |
 * |---|---|
 * | Tools | built-ins from `builtin-names.ts`; `tools` capability skills — read under `ctx.files` only |
 * | Custom tools | `<agent-dir>/tools`, `<cwd>/.omp/tools` |
 * | Skills | native `<agent-dir>/skills` and ancestor `.omp/skills`; `~/.claude/skills`; `<cwd>/.github/skills`; managed `<agent-dir>/managed-skills` |
 * | MCP | `<agent-dir>/mcp.json`, `<cwd>/.omp/mcp.json` |
 * | Commands | `<agent-dir>/commands/*.md`, nearest non-empty `.omp/commands/*.md` |
 * | Context files | `<agent-dir>/AGENTS.md`, nearest `.omp/AGENTS.md`, `RULES.md` and `rules/*.md` at both scopes |
 *
 * @module @zorker/muti-agent-adapter-omp/capabilities
 */
import { type OmpReadContext } from './sessions.ts';
import type { AgentCapabilityInventory, AgentId } from '@zorker/muti-agent-contracts';
/**
 * OMP's built-in tool names, verbatim from `src/tools/builtin-names.ts`. A session offers
 * these unless `--tools`/`--no-tools` or the `tools.xdev` presentation mode changes the set.
 */
export declare const OMP_BUILTIN_TOOL_NAMES: readonly string[];
/** Built-in names whose class pins `loadMode = "essential"` (`src/tools/essential-tools.ts`). */
export declare const OMP_ESSENTIAL_TOOL_NAMES: readonly string[];
/** Names OMP keeps out of the visible tool catalogue (`yield`, `goal`, `think`). */
export declare const OMP_HIDDEN_TOOL_NAMES: readonly string[];
/** Options for {@link readOmpCapabilities}. */
export interface OmpCapabilityOptions {
    /** Environment the store layout resolves from; defaults to the host's. */
    env?: NodeJS.ProcessEnv;
    /** Directory whose project tier is read; defaults to the process working directory. */
    cwd?: string;
}
/**
 * Read OMP's capability inventory. Read-only, and never throwing: a category that cannot
 * be enumerated returns an empty list with a {@link ProjectionNote} saying why.
 *
 * @param ctx - Ambient services (configuration and read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment and project directory; injected for testability.
 * @returns The inventory, with every declared gap.
 */
export declare function readOmpCapabilities(ctx: OmpReadContext, agent: AgentId, options?: OmpCapabilityOptions): Promise<AgentCapabilityInventory>;
//# sourceMappingURL=capabilities.d.ts.map