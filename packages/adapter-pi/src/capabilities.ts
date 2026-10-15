/**
 * Pi's capability inventory: the tools, skills, commands, MCP servers and context files it
 * will offer in a session.
 *
 * Read from pi's own resource directories. The built-in tool list is a constant because pi
 * declares it in code, not in configuration; everything else is discovered, so a skill the
 * user adds shows up without this adapter changing. Nothing here is written, and a directory
 * that cannot be read is a declared gap rather than an error.
 *
 * @module @zorker/muti-agent-adapter-pi/capabilities
 */

import { join } from 'node:path'
import type { FileProbe } from '@zorker/muti-agent-core'
import type {
  AgentCapabilityInventory,
  AgentCommandInfo,
  AgentMcpServerInfo,
  AgentSkillInfo,
  AgentToolInfo,
  CapabilitySource,
  ModelSourceFile,
  ProjectionNote,
} from '@zorker/muti-agent-contracts'

/**
 * Pi's built-in tools, as `docs/cli.md` names them.
 *
 * A constant rather than a scan: pi declares these in code, and reporting them as
 * "unavailable" would be less useful than the truth that they are always present.
 * `codemode` and `tool_search` are built-in *extension* tools and are inactive unless an
 * extension enables them, so they are reported as discoverable.
 */
const BUILTIN_TOOLS: readonly { name: string; discoverable?: true }[] = [
  { name: 'read' },
  { name: 'bash' },
  { name: 'powershell' },
  { name: 'edit' },
  { name: 'write' },
  { name: 'grep' },
  { name: 'find' },
  { name: 'ls' },
  { name: 'codemode', discoverable: true },
  { name: 'tool_search', discoverable: true },
]

/** Context file names pi loads, in its own precedence order. */
const CONTEXT_FILE_NAMES: readonly string[] = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
]

/** Options for {@link readPiCapabilities}. */
export interface PiCapabilitiesOptions {
  /** Resolved agent directory (`~/.pi/agent`, or the configured override). */
  agentDir: string
  /** Directory whose project resources and ancestors are scanned. */
  cwd: string
  /** Environment the run will see, used only to detect whether project trust is answerable. */
  env?: NodeJS.ProcessEnv
}

/** One `SKILL.md` frontmatter field set, read shallowly for display only. */
interface SkillFrontmatter {
  description?: string
  /** Present when the skill is hidden from the user but still offered to the model. */
  modelOnly: boolean
}

/**
 * Read one `SKILL.md` directory.
 *
 * @param files - Read-only filesystem probe.
 * @param dir - Directory holding a `SKILL.md`.
 * @param name - Skill name to report.
 * @param source - Where the directory came from.
 * @returns The skill, or `undefined` when the directory holds no readable `SKILL.md`.
 */
async function readSkill(
  files: FileProbe,
  dir: string,
  name: string,
  source: CapabilitySource,
): Promise<AgentSkillInfo | undefined> {
  const skillFile = join(dir, 'SKILL.md')
  const head = await files.readHead(skillFile, 8 * 1024)
  if (head.missing) return undefined
  const frontmatter = readFrontmatter(head.text)
  const skill: AgentSkillInfo = { name, source, path: skillFile, userInvocable: !frontmatter.modelOnly }
  if (frontmatter.description !== undefined) skill.description = frontmatter.description
  return skill
}

/**
 * Extract the two frontmatter fields this inventory displays.
 *
 * A deliberately shallow read of the block between the opening and closing `---` fences: the
 * inventory shows a description and whether the skill is user-invocable, and pulling in a YAML
 * parser for two fields would be a dependency for display text. An unparsable block yields no
 * fields rather than a failure.
 *
 * @param text - The head of a `SKILL.md`.
 * @returns The fields found.
 */
function readFrontmatter(text: string): SkillFrontmatter {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { modelOnly: false }
  const out: SkillFrontmatter = { modelOnly: false }
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const at = line.indexOf(':')
    if (at === -1) continue
    const key = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '')
    if (key === 'description' && value !== '') out.description = value
    if (key === 'disable-model-invocation') out.modelOnly = value !== 'false'
  }
  return out
}

/**
 * Discover the skills under one root.
 *
 * @param files - Read-only filesystem probe.
 * @param root - Directory holding `<name>/SKILL.md` entries.
 * @param source - Where the root came from.
 * @param out - Collector for the skills found.
 */
async function scanSkillRoot(
  files: FileProbe,
  root: string,
  source: CapabilitySource,
  out: AgentSkillInfo[],
): Promise<void> {
  for (const entry of await files.listDir(root)) {
    if (!entry.isDirectory) continue
    const skill = await readSkill(files, entry.path, entry.name, source)
    if (skill !== undefined) out.push(skill)
  }
}

/**
 * Read pi's capability inventory.
 *
 * @param files - Read-only filesystem probe from the adapter context.
 * @param agentId - The canonical agent id to stamp on the inventory.
 * @param options - Resolved agent directory and working directory.
 * @returns The inventory, with every gap declared.
 */
export async function readPiCapabilities(
  files: FileProbe,
  agentId: AgentCapabilityInventory['agentId'],
  options: PiCapabilitiesOptions,
): Promise<AgentCapabilityInventory> {
  const sources: ModelSourceFile[] = []
  const notes: ProjectionNote[] = []
  const tools: AgentToolInfo[] = []
  const skills: AgentSkillInfo[] = []
  const mcpServers: AgentMcpServerInfo[] = []
  const commands: AgentCommandInfo[] = []
  const contextFiles: string[] = []

  for (const entry of BUILTIN_TOOLS) {
    const tool: AgentToolInfo = { name: entry.name, source: 'builtin' }
    if (entry.discoverable === true) tool.discoverable = true
    tools.push(tool)
  }
  notes.push({
    field: 'tools',
    reason:
      'pi declares its built-in tools in code rather than in configuration, so the list here is the documented set (`docs/cli.md`); a tool an extension registers at run time cannot appear without running pi',
  })

  const skillRoots: readonly { root: string; source: CapabilitySource }[] = [
    { root: join(options.agentDir, 'skills'), source: 'user' },
    { root: join(options.cwd, '.pi', 'skills'), source: 'project' },
    { root: join(options.cwd, '.agents', 'skills'), source: 'project' },
  ]
  for (const entry of skillRoots) {
    const present = await files.isDirectory(entry.root)
    sources.push({ path: entry.root, present, ...(present ? {} : { note: 'not present' }) })
    if (present) await scanSkillRoot(files, entry.root, entry.source, skills)
  }
  notes.push({
    field: 'skills',
    reason:
      'the ancestor scan pi performs down to the repository root is not reproduced: only the working directory and its `.pi`/`.agents` roots are read, so a skill declared in a parent directory is absent here',
  })

  for (const name of ['prompts'] as const) {
    const dir = join(options.agentDir, name)
    const present = await files.isDirectory(dir)
    sources.push({ path: dir, present, ...(present ? {} : { note: 'not present' }) })
    if (!present) continue
    for (const entry of await files.listDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith('.md')) continue
      const head = await files.readHead(entry.path, 2 * 1024)
      const firstLine = head.text.split('\n').find(line => line.trim() !== '' && line.trim() !== '---')
      const command: AgentCommandInfo = { name: entry.name.replace(/\.md$/, ''), source: 'user', }
      if (firstLine !== undefined) command.description = firstLine.replace(/^#+\s*/, '').trim()
      commands.push(command)
    }
  }
  notes.push({
    field: 'commands',
    reason:
      "pi's built-in slash commands are declared in code, so they are not listed; only prompt templates found as files appear here",
  })

  const mcpPath = join(options.agentDir, 'mcp.json')
  const mcp = await files.readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(mcpPath)
  sources.push({ path: mcpPath, present: mcp.ok })
  if (mcp.ok) {
    for (const [name, raw] of Object.entries(mcp.value.mcpServers ?? {})) {
      const command = typeof raw['command'] === 'string' ? raw['command'] : undefined
      const url = typeof raw['url'] === 'string' ? raw['url'] : undefined
      const server: AgentMcpServerInfo = {
        name,
        transport: command !== undefined ? 'stdio' : url !== undefined ? 'http' : 'unknown',
        enabled: raw['enabled'] !== false,
        source: 'config',
      }
      if (command !== undefined) server.command = command
      if (url !== undefined) server.url = url
      mcpServers.push(server)
    }
  } else {
    notes.push({
      field: 'mcpServers',
      reason: mcp.missing ? 'no mcp.json in the agent directory' : `mcp.json could not be read: ${mcp.error}`,
    })
  }

  for (const name of CONTEXT_FILE_NAMES) {
    const candidate = join(options.agentDir, name)
    if (await files.isFile(candidate)) contextFiles.push(candidate)
  }
  for (const name of ['SYSTEM.md', 'APPEND_SYSTEM.md']) {
    const candidate = join(options.agentDir, name)
    if (await files.isFile(candidate)) contextFiles.push(candidate)
  }
  notes.push({
    field: 'contextFiles',
    reason:
      'only the agent directory is scanned; the ancestor walk pi performs for AGENTS.md and CLAUDE.md is not reproduced',
  })

  return {
    agentId,
    tools,
    skills,
    mcpServers,
    commands,
    contextFiles,
    sources,
    notes,
    observedAt: new Date().toISOString(),
  }
}
