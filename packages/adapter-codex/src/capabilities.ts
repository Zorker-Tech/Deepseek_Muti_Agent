/**
 * Codex's capability inventory: the MCP servers its configuration declares, the skills and
 * context files it will load, and the tools it carries.
 *
 * The configuration facts come from the same pass that builds the model catalog — the reader
 * exposes a `collect` sink for exactly this — so an inventory can never describe a
 * configuration the catalog does not. Codex declares no tool list in configuration, so the
 * built-ins are reported as unavailable with a note naming the module that defines them rather
 * than being invented.
 *
 * @module @zorker/muti-agent-adapter-codex/capabilities
 */

import { dirname, join } from 'node:path'
import type { FileProbe, Logger } from '@zorker/muti-agent-core'
import type {
  AgentCapabilityInventory,
  AgentId,
  AgentMcpServerInfo,
  AgentSkillInfo,
  ModelSourceFile,
  ProjectionNote,
} from '@zorker/muti-agent-contracts'
import { readCodexModelCatalog, type CodexCapabilityFacts } from './models.ts'

/** A parsed TOML table as this module reads it; the models reader's own alias is not exported. */
type TomlTable = Record<string, unknown>

/** Options for {@link readCodexCapabilities}. */
export interface CodexCapabilityRead {
  /** Read-only filesystem helpers. */
  files: FileProbe
  /** Resolved Codex home layout, as the catalog reader receives it. */
  home: Parameters<typeof readCodexModelCatalog>[0]['home']
  /** Canonical agent id. */
  agentId: AgentId
  /** Environment used only to decide whether a provider's credential variable is set. */
  env?: NodeJS.ProcessEnv
  /** Directory whose project layers stand in for Codex's `$PWD`. */
  projectDir?: string
  /** Logger for diagnostics. */
  log?: Logger
}

/** Read a nested table entry, or `undefined` when it is not an object. */
function tableOf(value: unknown): TomlTable | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined
}

/**
 * Read Codex's capability inventory.
 *
 * @param read - Filesystem probe, resolved home, and the directory whose project layers apply.
 * @returns The inventory, with every gap declared.
 */
export async function readCodexCapabilities(read: CodexCapabilityRead): Promise<AgentCapabilityInventory> {
  const sources: ModelSourceFile[] = []
  const notes: ProjectionNote[] = []
  const mcpServers: AgentMcpServerInfo[] = []
  const skills: AgentSkillInfo[] = []
  const contextFiles: string[] = []

  let facts: CodexCapabilityFacts | undefined
  const catalog = await readCodexModelCatalog({
    files: read.files,
    home: read.home,
    agentId: read.agentId,
    ...(read.env === undefined ? {} : { env: read.env }),
    ...(read.projectDir === undefined ? {} : { projectDir: read.projectDir }),
    collect: captured => { facts = captured },
  })
  sources.push(...catalog.sources)
  notes.push(...catalog.notes)

  const layers = facts?.layers ?? []
  for (const layer of layers) {
    sources.push({ path: layer.path, present: true, note: `${layer.kind} layer` })
    // Later layers win, which is why the loop assigns rather than skipping a seen name.
    for (const [name, raw] of Object.entries(tableOf(layer.table['mcp_servers']) ?? {})) {
      const entry = tableOf(raw)
      if (entry === undefined) continue
      const command = typeof entry['command'] === 'string' ? entry['command'] : undefined
      const url = typeof entry['url'] === 'string' ? entry['url'] : undefined
      const server: AgentMcpServerInfo = {
        name,
        transport: command !== undefined ? 'stdio' : url !== undefined ? 'http' : 'unknown',
        enabled: entry['enabled'] !== false,
        source: layer.kind === 'project' || layer.kind === 'local' ? 'project' : 'config',
      }
      if (command !== undefined) server.command = command
      if (url !== undefined) server.url = url
      const at = mcpServers.findIndex(candidate => candidate.name === name)
      if (at === -1) mcpServers.push(server)
      else mcpServers[at] = server
    }
  }

  // The home directory is the user layer's own directory, which avoids depending on the shape
  // of the resolved-home type beyond what the reader already used.
  const userLayer = layers.find(layer => layer.kind === 'user')
  const homeDir = userLayer === undefined ? undefined : dirname(userLayer.path)
  if (homeDir !== undefined) {
    for (const root of [
      { dir: join(homeDir, 'skills'), source: 'user' as const },
      { dir: read.projectDir === undefined ? undefined : join(read.projectDir, '.codex', 'skills'), source: 'project' as const },
    ]) {
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
    for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
      const candidate = join(homeDir, name)
      if (await read.files.isFile(candidate)) contextFiles.push(candidate)
    }
  } else {
    notes.push({ field: 'skills', reason: 'no user configuration layer was read, so the skills root is unknown' })
  }

  if (read.projectDir !== undefined) {
    // Codex walks up from the working directory to the repository root looking for AGENTS.md.
    let dir = read.projectDir
    for (let depth = 0; depth < 32; depth += 1) {
      const candidate = join(dir, 'AGENTS.md')
      if (await read.files.isFile(candidate)) contextFiles.push(candidate)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  notes.push({
    field: 'tools',
    reason:
      "Codex declares no tool list in configuration: its built-in tools live in the binary (`codex-rs/tools/src/`), so they are not listed here rather than guessed",
  })
  notes.push({
    field: 'commands',
    reason: "Codex's slash commands are built into its terminal UI and are not declared in configuration, so they are not listed",
  })

  read.log?.debug('codex capability inventory read', {
    mcpServers: mcpServers.length,
    skills: skills.length,
    contextFiles: contextFiles.length,
    layers: layers.length,
  })

  return {
    agentId: read.agentId,
    tools: [],
    skills,
    mcpServers,
    commands: [],
    contextFiles,
    sources,
    notes,
    observedAt: new Date().toISOString(),
  }
}
