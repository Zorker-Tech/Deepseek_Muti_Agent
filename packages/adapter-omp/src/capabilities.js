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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRecord, readArray, readBoolean, readRecord, readString, resolveOmpStore, } from "./sessions.js";
import { parse as parseYaml } from 'yaml';
/**
 * OMP's built-in tool names, verbatim from `src/tools/builtin-names.ts`. A session offers
 * these unless `--tools`/`--no-tools` or the `tools.xdev` presentation mode changes the set.
 */
export const OMP_BUILTIN_TOOL_NAMES = [
    'read',
    'bash',
    'edit',
    'ast_grep',
    'ast_edit',
    'ask',
    'debug',
    'ida',
    'eval',
    'github',
    'glob',
    'grep',
    'find',
    'lsp',
    'checkpoint',
    'rewind',
    'context_notes',
    'new_context',
    'security_scan',
    'task',
    'wait',
    'todo',
    'web_search',
    'write',
    'memory_edit',
    'retain',
    'recall',
    'reflect',
    'learn',
    'manage_skill',
];
/** Built-in names whose class pins `loadMode = "essential"` (`src/tools/essential-tools.ts`). */
export const OMP_ESSENTIAL_TOOL_NAMES = [
    'read',
    'write',
    'bash',
    'edit',
    'glob',
    'find',
    'eval',
    'task',
    'wait',
    'learn',
    'manage_skill',
    'context_notes',
    'new_context',
];
/** Names OMP keeps out of the visible tool catalogue (`yield`, `goal`, `think`). */
export const OMP_HIDDEN_TOOL_NAMES = ['yield', 'goal', 'think'];
/**
 * The approval tier each built-in declares as a constant. OMP's vocabulary is
 * `read` | `write` | `exec`, and an undeclared or invalid tier resolves to `exec`; several
 * built-ins compute their tier per call (for example `read` consults the internal-URL
 * router, `bash` matches its safety patterns), so those are deliberately left undeclared
 * here rather than reported as if the tier were static.
 */
const OMP_STATIC_APPROVAL_TIERS = {
    ask: 'read',
    ast_grep: 'read',
    checkpoint: 'read',
    eval: 'exec',
    glob: 'read',
    manage_skill: 'write',
    memory_edit: 'read',
    security_scan: 'exec',
    todo: 'read',
    wait: 'read',
};
/** How deep the ancestor walk for project config directories goes. */
const MAX_PROJECT_WALK = 40;
/** Bytes read from one skill or command file to reach its frontmatter. */
const MAX_TEXT_HEAD_BYTES = 64 * 1024;
/**
 * Read OMP's capability inventory. Read-only, and never throwing: a category that cannot
 * be enumerated returns an empty list with a {@link ProjectionNote} saying why.
 *
 * @param ctx - Ambient services (configuration and read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment and project directory; injected for testability.
 * @returns The inventory, with every declared gap.
 */
export async function readOmpCapabilities(ctx, agent, options = {}) {
    const env = options.env ?? process.env;
    const layout = await resolveOmpStore(ctx, env);
    const cwd = ctx.files.resolvePath(options.cwd ?? process.cwd());
    const home = contractHome(ctx, env);
    const sources = [];
    const notes = [];
    const project = await nearestNonEmptyProjectDir(ctx, cwd, home);
    const tools = await readTools(ctx, layout.agentDir, cwd, project, sources, notes);
    const skills = await readSkills(ctx, layout.agentDir, cwd, home, sources, notes);
    const mcpServers = await readMcpServers(ctx, layout.agentDir, cwd, sources, notes);
    const commands = await readCommands(ctx, layout.agentDir, project, sources, notes);
    const contextFiles = await readContextFiles(ctx, layout.agentDir, project, sources, notes);
    return {
        agentId: agent,
        tools,
        skills,
        mcpServers,
        commands,
        contextFiles,
        sources,
        notes,
        observedAt: new Date().toISOString(),
    };
}
/** The home directory as a contract, so the ancestor walk has a ceiling. */
function contractHome(ctx, env) {
    const raw = env.HOME ?? env.USERPROFILE;
    return ctx.files.resolvePath(raw === undefined || raw === '' ? homedir() : raw);
}
/**
 * The nearest non-empty `.omp/` directory walking from `cwd` toward the filesystem root.
 *
 * OMP stops at the first non-empty `.omp/` and reads `AGENTS.md`, `RULES.md`, `commands/`
 * and `rules/` from that directory only; home is the user scope and never a project.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param cwd - Absolute project directory.
 * @param home - Absolute home directory.
 * @returns The directory, or `undefined` when no non-empty `.omp/` exists.
 */
async function nearestNonEmptyProjectDir(ctx, cwd, home) {
    let directory = cwd;
    for (let depth = 0; depth < MAX_PROJECT_WALK; depth += 1) {
        if (directory === home)
            return undefined;
        const candidate = join(directory, '.omp');
        if (await isNonEmptyDirectory(ctx, candidate))
            return candidate;
        const parent = dirname(directory);
        if (parent === directory)
            return undefined;
        directory = parent;
    }
    return undefined;
}
/**
 * Whether a path is a directory holding at least one entry.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param path - Absolute path.
 * @returns `true` when the directory exists and is non-empty.
 */
async function isNonEmptyDirectory(ctx, path) {
    if (!(await ctx.files.isDirectory(path)))
        return false;
    return (await ctx.files.listDir(path)).length > 0;
}
/**
 * The tool catalogue: OMP's built-ins plus the custom tool modules the two documented
 * directories hold.
 */
async function readTools(ctx, agentDir, cwd, project, sources, notes) {
    const tools = [];
    for (const name of OMP_BUILTIN_TOOL_NAMES) {
        const approval = OMP_STATIC_APPROVAL_TIERS[name];
        tools.push({
            name,
            source: 'builtin',
            ...(approval === undefined ? {} : { approval }),
            discoverable: !OMP_ESSENTIAL_TOOL_NAMES.includes(name),
        });
    }
    notes.push({
        field: 'tools',
        reason: `${OMP_HIDDEN_TOOL_NAMES.join(', ')} are hidden built-in tools and are not listed; ` +
            '`--tools`/`--no-tools` filter the set at run time, and a built-in whose approval tier is ' +
            'computed per call (read, bash, grep, lsp, task, write, edit, debug, ida, learn, ' +
            'context_notes, ast_edit, github) declares none statically here',
    });
    const roots = [
        { path: `${agentDir}/tools`, level: 'config' },
        ...(project === undefined ? [] : [{ path: join(project, 'tools'), level: 'project' }]),
    ];
    if (project !== undefined && join(project, 'tools') !== `${cwd}/.omp/tools`) {
        // The custom-tool provider documents `<cwd>/.omp/tools`; a farther non-empty `.omp`
        // directory is read for the other categories, so its tools directory is read too and
        // named here rather than silently preferred.
        notes.push({
            field: 'tools',
            reason: `custom tools were also read from ${join(project, 'tools')}, the nearest non-empty .omp directory`,
        });
    }
    for (const root of roots) {
        const present = await ctx.files.isDirectory(root.path);
        sources.push({ path: root.path, present });
        if (!present)
            continue;
        for (const module of await listToolModules(ctx, root.path)) {
            tools.push({ name: module.name, source: root.level, discoverable: true, path: module.path });
        }
    }
    notes.push({
        field: 'tools',
        reason: "a custom tool's description lives in the module's factory, which this read never imports " +
            '(importing it would run the code), so custom entries carry a name and a path only',
    });
    return tools;
}
/**
 * List the custom tool modules one directory holds: `.ts`/`.js` files, plus immediate
 * subdirectories that hold an `index.ts`, matching OMP's own scan.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param root - Absolute tools directory.
 * @returns The modules, files first in directory order.
 */
async function listToolModules(ctx, root) {
    const modules = [];
    for (const entry of await ctx.files.listDir(root)) {
        if (entry.isFile && /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            modules.push({ name: entry.name.replace(/\.(ts|js)$/, ''), path: entry.path });
            continue;
        }
        if (!entry.isDirectory)
            continue;
        const index = join(entry.path, 'index.ts');
        if (await ctx.files.isFile(index))
            modules.push({ name: entry.name, path: index });
    }
    return modules;
}
/**
 * The skill catalogue, in OMP's provider order: native (user and project), Claude's user
 * root, GitHub's project layout, then OMP's own managed (auto-learn) store.
 *
 * A skill that OMP would skip — `enabled: false`, or a native/Claude entry with no
 * description where that provider requires one — is skipped here for the same reason and
 * counted in the note.
 */
async function readSkills(ctx, agentDir, cwd, home, sources, notes) {
    const skills = [];
    const skipped = [];
    for (const ancestor of ancestorDirs(cwd, home)) {
        const projectRoot = join(ancestor, '.omp', 'skills');
        const present = await ctx.files.isDirectory(projectRoot);
        if (!present)
            continue;
        sources.push({ path: projectRoot, present: true });
        for (const skill of await scanSkills(ctx, projectRoot, 'project', true, skipped))
            skills.push(skill);
    }
    const userRoot = `${agentDir}/skills`;
    sources.push({ path: userRoot, present: await ctx.files.isDirectory(userRoot) });
    for (const skill of await scanSkills(ctx, userRoot, 'user', true, skipped))
        skills.push(skill);
    const claudeRoot = `${home}/.claude/skills`;
    sources.push({ path: claudeRoot, present: await ctx.files.isDirectory(claudeRoot) });
    for (const skill of await scanSkills(ctx, claudeRoot, 'user', false, skipped))
        skills.push(skill);
    if (await ctx.files.isDirectory(claudeRoot)) {
        notes.push({
            field: 'skills',
            reason: 'the Claude skill root is read only when OMP opts that provider in (enabledProviders contains ' +
                '`claude`, or CLAUDE_CONFIG_DIR is set); this read reports the files without knowing the toggle',
        });
    }
    const githubRoot = `${cwd}/.github/skills`;
    sources.push({ path: githubRoot, present: await ctx.files.isDirectory(githubRoot) });
    for (const skill of await scanSkills(ctx, githubRoot, 'project', true, skipped))
        skills.push(skill);
    const managedRoot = `${agentDir}/managed-skills`;
    sources.push({ path: managedRoot, present: await ctx.files.isDirectory(managedRoot) });
    for (const skill of await scanSkills(ctx, managedRoot, 'bundled', true, skipped))
        skills.push(skill);
    if (skipped.length > 0) {
        notes.push({
            field: 'skills',
            reason: `OMP would skip ${skipped.length} skill directories and they are not listed: ${skipped.slice(0, 8).join(', ')}`,
        });
    }
    notes.push({
        field: 'skills',
        reason: 'skill discovery for extension-package and plugin roots (omp-plugins, claude-plugins, agent-plugins, ' +
            'skillshare, opencode, .agent[s]) needs the plugin registries and is not read here',
    });
    return skills;
}
/**
 * The project ancestors a skill scan walks, closest first.
 *
 * OMP walks from cwd toward the repository root; home is the user scope and stops the
 * walk, and an absent git repository makes the walk end at home or the filesystem root.
 *
 * @param cwd - Absolute project directory.
 * @param home - Absolute home directory.
 * @returns The ancestor directories, including `cwd`.
 */
function ancestorDirs(cwd, home) {
    const dirs = [];
    let directory = cwd;
    for (let depth = 0; depth < MAX_PROJECT_WALK; depth += 1) {
        dirs.push(directory);
        if (directory === home)
            break;
        const parent = dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    return dirs;
}
/**
 * Scan one skill root: `<root>/<name>/SKILL.md`, one level, non-recursively.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param root - Absolute skills directory.
 * @param source - Canonical origin for the entries.
 * @param requireDescription - Whether a skill without a description is skipped, as OMP's providers do.
 * @param skipped - Accumulator for the directories OMP would skip, as names.
 * @returns The skills found.
 */
async function scanSkills(ctx, root, source, requireDescription, skipped) {
    if (!(await ctx.files.isDirectory(root)))
        return [];
    const skills = [];
    for (const entry of await ctx.files.listDir(root)) {
        if (!entry.isDirectory)
            continue;
        const file = join(entry.path, 'SKILL.md');
        if (!(await ctx.files.isFile(file)))
            continue;
        const frontmatter = await readFrontmatter(ctx, file);
        if (frontmatter === undefined) {
            skipped.push(`${entry.name} (unreadable frontmatter)`);
            continue;
        }
        if (frontmatter.enabled === false) {
            skipped.push(`${entry.name} (enabled: false)`);
            continue;
        }
        if (requireDescription && (frontmatter.description === undefined || frontmatter.description === '')) {
            skipped.push(`${entry.name} (no description)`);
            continue;
        }
        const hidden = frontmatter.hide === true || frontmatter.disableModelInvocation === true;
        skills.push({
            name: frontmatter.name ?? entry.name,
            ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
            source,
            path: file,
            userInvocable: !hidden,
        });
    }
    return skills;
}
/**
 * Read the YAML frontmatter of a skill file.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param path - Absolute `SKILL.md` path.
 * @returns The fields, or `undefined` when the file is unreadable or has no frontmatter block.
 */
async function readFrontmatter(ctx, path) {
    const read = await ctx.files.readHead(path, MAX_TEXT_HEAD_BYTES);
    if (read.missing || read.truncated)
        return undefined;
    const text = read.text;
    if (!text.startsWith('---'))
        return undefined;
    const end = text.indexOf('\n---', 3);
    if (end === -1)
        return undefined;
    let decoded;
    try {
        decoded = parseYaml(text.slice(text.indexOf('\n') + 1, end));
    }
    catch {
        return undefined;
    }
    if (!isRecord(decoded))
        return undefined;
    const name = readString(decoded, 'name');
    const description = readString(decoded, 'description');
    const disable = readBoolean(decoded, 'disableModelInvocation') ?? readBoolean(decoded, 'disable-model-invocation');
    return {
        ...(name === undefined || name === '' ? {} : { name }),
        ...(description === undefined ? {} : { description: description.trim() }),
        ...(readBoolean(decoded, 'hide') === undefined ? {} : { hide: readBoolean(decoded, 'hide') === true }),
        ...(disable === undefined ? {} : { disableModelInvocation: disable }),
        ...(readBoolean(decoded, 'enabled') === undefined ? {} : { enabled: readBoolean(decoded, 'enabled') === true }),
    };
}
/**
 * The MCP servers the two documented OMP-native files declare.
 *
 * A project entry precedes its same-named user entry (so a project `enabled: false`
 * suppresses the user server), and `disabledServers` hides a name regardless of its
 * entry's own `enabled`.
 */
async function readMcpServers(ctx, agentDir, cwd, sources, notes) {
    const projectPath = `${cwd}/.omp/mcp.json`;
    const userPath = `${agentDir}/mcp.json`;
    const disabled = new Set();
    const servers = new Map();
    // Project first: OMP keeps the higher-precedence entry when names collide.
    for (const file of [
        { path: projectPath, source: 'project' },
        { path: userPath, source: 'user' },
    ]) {
        const read = await ctx.files.readJson(file.path);
        sources.push({
            path: file.path,
            present: read.ok || !read.missing,
            ...(read.ok || read.missing ? {} : { note: `could not be parsed as JSON (${read.error})` }),
        });
        if (!read.ok || !isRecord(read.value))
            continue;
        for (const name of readArray(read.value, 'disabledServers') ?? []) {
            if (typeof name === 'string' && name !== '')
                disabled.add(name);
        }
        const rawServers = readRecord(read.value, 'mcpServers');
        if (rawServers === undefined)
            continue;
        for (const [name, rawServer] of Object.entries(rawServers)) {
            if (!isRecord(rawServer) || servers.has(name))
                continue;
            servers.set(name, projectServer(name, rawServer, file.source));
        }
    }
    notes.push({
        field: 'mcpServers',
        reason: 'a server’s tools exist as `mcp__<server>_<tool>` only once a session connects, so they are ' +
            'not enumerated here; OMP also translates configs from other tools (.claude.json, ' +
            '.codex/config.toml, .cursor/mcp.json, opencode.json, …) and from installed plugin packages, ' +
            'which this read does not follow',
    });
    return [...servers.values()].map(server => disabled.has(server.name) ? { ...server, enabled: false } : server);
}
/** Project one `mcpServers` entry, without reading any credential the entry may carry. */
function projectServer(name, raw, source) {
    const type = readString(raw, 'type');
    const transport = type === 'stdio' || type === 'http' || type === 'sse' ? type : 'unknown';
    const command = readString(raw, 'command');
    const url = readString(raw, 'url');
    return {
        name,
        transport,
        ...(command === undefined || command === '' ? {} : { command }),
        ...(url === undefined || url === '' ? {} : { url }),
        enabled: readBoolean(raw, 'enabled') !== false,
        source,
    };
}
/** The commands the agent directory and the nearest non-empty `.omp/` expose. */
async function readCommands(ctx, agentDir, project, sources, notes) {
    const commands = [];
    const userRoot = `${agentDir}/commands`;
    sources.push({ path: userRoot, present: await ctx.files.isDirectory(userRoot) });
    for (const command of await scanCommands(ctx, userRoot, 'user'))
        commands.push(command);
    if (project !== undefined) {
        const projectRoot = join(project, 'commands');
        sources.push({ path: projectRoot, present: await ctx.files.isDirectory(projectRoot) });
        for (const command of await scanCommands(ctx, projectRoot, 'project'))
            commands.push(command);
    }
    notes.push({
        field: 'commands',
        reason: "OMP's native command files carry no parsed frontmatter, so a command is listed by name and " +
            'path-less origin; plugin, Claude and Codex command roots are not read here',
    });
    return commands;
}
/** Scan one non-recursive `commands/*.md` directory. */
async function scanCommands(ctx, root, source) {
    if (!(await ctx.files.isDirectory(root)))
        return [];
    const commands = [];
    for (const entry of await ctx.files.listDir(root)) {
        if (!entry.isFile || !entry.name.endsWith('.md'))
            continue;
        commands.push({ name: entry.name.slice(0, -'.md'.length), source });
    }
    return commands;
}
/**
 * The instruction and rule files OMP loads into context, paths only.
 *
 * The native scopes are the active agent directory (user) and the nearest non-empty
 * `.omp/` directory (project); `RULES.md` is the sticky rule file and `rules/*.md` are the
 * ordinary rule files.
 */
async function readContextFiles(ctx, agentDir, project, sources, notes) {
    const files = [];
    const fixed = [join(agentDir, 'AGENTS.md'), join(agentDir, 'RULES.md')];
    if (project !== undefined)
        fixed.push(join(project, 'AGENTS.md'), join(project, 'RULES.md'));
    for (const file of fixed) {
        if (await ctx.files.isFile(file))
            files.push(file);
    }
    for (const root of [`${agentDir}/rules`, ...(project === undefined ? [] : [join(project, 'rules')])]) {
        const present = await ctx.files.isDirectory(root);
        sources.push({ path: root, present });
        if (!present)
            continue;
        for (const entry of await ctx.files.listDir(root)) {
            if (entry.isFile && /\.(md|mdc)$/.test(entry.name))
                files.push(entry.path);
        }
    }
    notes.push({
        field: 'contextFiles',
        reason: 'only the native OMP locations are listed: standalone AGENTS.md/CLAUDE.md/GEMINI.md files, ' +
            'copilot-instructions.md, `.claude` and `.agent[s]` context files, and `contextFiles.extra` ' +
            'names are providers this read does not enumerate; the files themselves are never read',
    });
    return files;
}
//# sourceMappingURL=capabilities.js.map