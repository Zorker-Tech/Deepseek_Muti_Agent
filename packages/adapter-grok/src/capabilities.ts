/**
 * Grok Build's capability inventory: its built-in tools, its skills, the MCP servers its
 * configuration declares, and the rule files it loads.
 *
 * The configuration tiers come from the same pass that builds the model catalog — the reader
 * exposes a `collectCapabilities` sink for exactly this — so the inventory and the catalog can
 * never describe different configurations.
 *
 * @module @zorker/muti-agent-adapter-grok/capabilities
 */

import { dirname, join } from 'node:path'
import type { FileProbe, Logger } from '@zorker/muti-agent-core'
import type {
  AgentCapabilityInventory,
  AgentMcpServerInfo,
  AgentSkillInfo,
  AgentToolInfo,
  ModelSourceFile,
  ProjectionNote,
} from '@zorker/muti-agent-contracts'
import {
  readGrokModelCatalog,
  type GrokCapabilityFacts,
  type GrokModelReaderOptions,
} from './models.ts'

/**
 * Grok Build's model-facing tools, from the registry and Claude-alias tables in
 * `crates/codegen/xai-grok-tools/src/types/claude_alias.rs`.
 *
 * A constant because Grok declares them in code. The two MCP meta-tools are included: Grok
 * reaches a remote MCP server's tools through `search_tool`/`use_tool` rather than exposing
 * them directly, which is why an MCP server's own tools are not listed individually here.
 */
const BUILTIN_TOOLS: readonly string[] = [
  'read_file', 'write', 'search_replace', 'hashline_read', 'hashline_edit', 'hashline_grep',
  'grep', 'list_dir', 'run_terminal_cmd', 'web_search', 'web_fetch', 'todo_write',
  'spawn_subagent', 'get_command_or_subagent_output', 'kill_command_or_subagent',
  'ask_user_question', 'enter_plan_mode', 'exit_plan_mode', 'search_tool', 'use_tool',
  'lsp', 'image_gen', 'image_edit', 'video_gen', 'deploy_app',
]

/** Rule-file names Grok loads, in its own documented order. */
const CONTEXT_FILE_NAMES: readonly string[] = ['Agents.md', 'Claude.md', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENT.md', 'AGENTS.md']

/** Options for {@link readGrokCapabilities}. */
export interface GrokCapabilityRead {
  /** Read-only filesystem helpers. */
  files: FileProbe
  /** Resolved Grok locations, as the catalog reader receives them. */
  paths: GrokModelReaderOptions['paths']
  /** Host environment, inspected for variable names only. */
  hostEnv: NodeJS.ProcessEnv
  /** Directory whose project tier applies. */
  cwd: string
  /** Logger for diagnostics. */
  log: Logger
}

/** Read a nested table entry, or `undefined` when it is not an object. */
function tableOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Read Grok's capability inventory.
 *
 * @param read - Filesystem probe, resolved paths, and the directory whose project tier applies.
 * @returns The inventory, with every gap declared.
 */
export async function readGrokCapabilities(read: GrokCapabilityRead): Promise<AgentCapabilityInventory> {
  const sources: ModelSourceFile[] = []
  const notes: ProjectionNote[] = []
  const mcpServers: AgentMcpServerInfo[] = []
  const skills: AgentSkillInfo[] = []
  const contextFiles: string[] = []

  let facts: GrokCapabilityFacts | undefined
  const catalog = await readGrokModelCatalog({
    files: read.files,
    paths: read.paths,
    hostEnv: read.hostEnv,
    cwd: read.cwd,
    log: read.log,
    collectCapabilities: captured => { facts = captured },
  })
  sources.push(...catalog.sources)
  notes.push(...catalog.notes)

  // Tiers ascend in precedence, so a later assignment replaces an earlier one; project files
  // are the lowest effective tier for the keys Grok reads from them.
  const tables: Record<string, unknown>[] = [
    ...(facts?.configTiers ?? []).map(tier => tier.table).filter((table): table is Record<string, unknown> => table !== undefined),
    ...(facts?.projectConfigs ?? []).map(project => project.table).filter((table): table is Record<string, unknown> => table !== undefined),
  ]
  for (const table of tables) {
    for (const [name, raw] of Object.entries(tableOf(table['mcp_servers']) ?? {})) {
      const entry = tableOf(raw)
      if (entry === undefined) continue
      const command = typeof entry['command'] === 'string' ? entry['command'] : undefined
      const url = typeof entry['url'] === 'string' ? entry['url'] : undefined
      const type = typeof entry['type'] === 'string' ? entry['type'] : undefined
      const server: AgentMcpServerInfo = {
        name,
        transport: command !== undefined ? 'stdio' : type === 'sse' ? 'sse' : url !== undefined ? 'http' : 'unknown',
        enabled: entry['enabled'] !== false,
        source: 'config',
      }
      if (command !== undefined) server.command = command
      if (url !== undefined) server.url = url
      const at = mcpServers.findIndex(candidate => candidate.name === name)
      if (at === -1) mcpServers.push(server)
      else mcpServers[at] = server
    }
  }

  const tools = BUILTIN_TOOLS.map((name): AgentToolInfo => ({ name, source: 'builtin' }))
  notes.push({
    field: 'tools',
    reason:
      'Grok declares its tools in code, so the list here is the registry and alias set from `xai-grok-tools`; a per-tool approval tier is declared in that same table and is not projected',
  })
  notes.push({
    field: 'tools',
    reason:
      "a remote MCP server's tools are reached through `search_tool`/`use_tool` rather than being registered individually, so only the servers appear below",
  })

  const userTier = (facts?.configTiers ?? []).find(tier => tier.path.includes('config.toml') && !tier.path.includes('managed'))
  const homeDir = userTier === undefined ? undefined : dirname(userTier.path)
  const skillRoots: readonly { dir: string | undefined; source: 'user' | 'project' }[] = [
    { dir: homeDir === undefined ? undefined : join(homeDir, 'skills'), source: 'user' },
    { dir: join(read.cwd, '.grok', 'skills'), source: 'project' },
    { dir: join(read.cwd, '.agents', 'skills'), source: 'project' },
    { dir: join(read.cwd, '.claude', 'skills'), source: 'project' },
    { dir: join(read.cwd, '.cursor', 'skills'), source: 'project' },
  ]
  for (const root of skillRoots) {
    if (root.dir === undefined) continue
    const present = await read.files.isDirectory(root.dir)
    sources.push({ path: root.dir, present, ...(present ? {} : { note: 'not present' }) })
    if (!present) continue
    for (const entry of await read.files.listDir(root.dir)) {
      if (!entry.isDirectory) continue
      const skillFile = join(entry.path, 'SKILL.md')
      const head = await read.files.readHead(skillFile, 4 * 1024)
      if (head.missing) continue
      const skill: AgentSkillInfo = { name: entry.name, source: root.source, path: skillFile }
      const description = /^description:\s*(.+)$/mu.exec(head.text)?.[1]?.trim()
      if (description !== undefined && description !== '') skill.description = description
      skills.push(skill)
    }
  }
  notes.push({
    field: 'skills',
    reason:
      'the configured `[skills] paths`, `ignore` and `disabled` keys are not applied here, and the repository-root-to-cwd walk is not reproduced',
  })

  if (homeDir !== undefined) {
    for (const name of CONTEXT_FILE_NAMES) {
      const candidate = join(homeDir, 'rules', name)
      if (await read.files.isFile(candidate)) contextFiles.push(candidate)
    }
  }
  let dir = read.cwd
  for (let depth = 0; depth < 32; depth += 1) {
    for (const name of CONTEXT_FILE_NAMES) {
      const candidate = join(dir, name)
      if (await read.files.isFile(candidate)) contextFiles.push(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  notes.push({
    field: 'contextFiles',
    reason:
      'the `.grok/rules`, `.claude/rules` and `.cursor/rules` directories and the configured extra rule dirs are not scanned',
  })
  notes.push({
    field: 'commands',
    reason: "Grok's slash commands are declared in its user interface code rather than in configuration, so they are not listed",
  })

  read.log.debug('grok capability inventory read', {
    mcpServers: mcpServers.length,
    skills: skills.length,
    contextFiles: contextFiles.length,
  })

  return {
    agentId: 'grok' as AgentCapabilityInventory['agentId'],
    tools,
    skills,
    mcpServers,
    commands: [],
    contextFiles,
    sources,
    notes,
    observedAt: new Date().toISOString(),
  }
}
