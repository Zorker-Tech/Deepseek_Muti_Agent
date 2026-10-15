/**
 * An agent's capability inventory: the tools, skills, MCP servers and commands it will
 * actually offer in a session, read from that agent's own configuration.
 *
 * Why this is part of the canonical schema: the harness's own capability surfaces are
 * derived from the session's composition — the Trajectory "Tools" tab renders the tool
 * catalog the *harness* agent loop logged, and the `/` menu resolves skills from the
 * session's agent preset. To make those surfaces describe the agent a conversation is
 * actually bound to, the composition has to be built from what that agent declares, so the
 * declarations must be readable in one canonical shape first (ADR-0002, ADR-0015).
 *
 * Reading is read-only, like every other foreign store this project touches, and a parse
 * failure is a declared gap rather than an error.
 *
 * @module @zorker/muti-agent-contracts/capabilities-inventory
 */

import type { AgentId } from './ids.ts'
import type { ProjectionNote } from './session.ts'
import type { ModelSourceFile } from './models.ts'

/** Where one declared capability came from. */
export type CapabilitySource = 'builtin' | 'config' | 'project' | 'user' | 'extension' | 'mcp' | 'plugin' | 'bundled'

/** One tool an agent will offer. */
export interface AgentToolInfo {
  /** Name as the agent's model sees it, verbatim — what a call row would be named. */
  name: string
  /** Description, when the agent's own declaration carries one. */
  description?: string
  /** Where the tool is declared. */
  source: CapabilitySource
  /**
   * The approval tier the agent assigns it, when it has one.
   *
   * Codex calls this sandbox/approval behaviour, Grok a permission rule, omp an approval
   * tier (`read`|`write`|`exec`); the values are per-agent strings because the vocabularies
   * genuinely differ and flattening them would invent a taxonomy no agent uses.
   */
  approval?: string
  /** Whether the agent loads it only on demand rather than always. */
  discoverable?: boolean
  /** Absolute path of the declaring file, for a custom or extension tool. */
  path?: string
}

/** One skill an agent will offer. */
export interface AgentSkillInfo {
  /** Name, namespaced when the agent resolves collisions (`<namespace>/<name>`). */
  name: string
  /** Description from the skill's frontmatter, when present. */
  description?: string
  /** Where the skill was discovered. */
  source: CapabilitySource
  /** Absolute path of the `SKILL.md`, when it has one. */
  path?: string
  /**
   * Whether a user can invoke it directly (a slash command).
   *
   * False for a skill the agent hides from the user but still offers the model, which is a
   * distinction every one of these agents makes.
   */
  userInvocable?: boolean
}

/** One MCP server an agent is configured to reach. */
export interface AgentMcpServerInfo {
  /** Server name as the agent names it; its tools appear as `<prefix><name>_<tool>`. */
  name: string
  /** Transport. `unknown` when the configuration does not say. */
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  /** Command line for a stdio server. */
  command?: string
  /** Endpoint for an http or sse server. */
  url?: string
  /** Whether the agent's configuration enables it. */
  enabled: boolean
  /** Where this server was declared. */
  source: CapabilitySource
}

/** One command an agent exposes to the user. */
export interface AgentCommandInfo {
  /** Name without its leading slash. */
  name: string
  /** Description, when declared. */
  description?: string
  /** Where it came from: the agent's own set, a config file, or a plugin. */
  source: CapabilitySource
}

/**
 * Everything one agent declares it can do, gathered in one read.
 *
 * Consumers must read the declared flags rather than assume a list is complete: an agent
 * that cannot enumerate its own built-ins returns an empty `tools` list with a note
 * explaining why, which is a different fact from "this agent has no tools".
 */
export interface AgentCapabilityInventory {
  /** The agent this inventory describes. */
  agentId: AgentId
  /** Tools the agent offers. */
  tools: readonly AgentToolInfo[]
  /** Skills the agent will load. */
  skills: readonly AgentSkillInfo[]
  /** MCP servers the agent is configured to reach. */
  mcpServers: readonly AgentMcpServerInfo[]
  /** Commands the agent exposes to a user. */
  commands: readonly AgentCommandInfo[]
  /**
   * Instruction or rule files the agent loads into context, in its own precedence order.
   *
   * Paths only: these files are the user's own text and are never read into the plugin.
   */
  contextFiles: readonly string[]
  /** Files read, so a user can see where the answer came from. */
  sources: readonly ModelSourceFile[]
  /** Declared gaps: what could not be read, and why. */
  notes: readonly ProjectionNote[]
  /** When the inventory was read. */
  observedAt: string
}
