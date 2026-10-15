/**
 * The proxy plugin a MutiAgent agent preset mounts.
 *
 * Why this exists: the harness derives what a conversation "can do" from the composition it
 * runs under. The Trajectory Tools tab renders the tool catalog the agent loop logged in a
 * `request/header`, and the `/` menu resolves skills from the session's agent preset. So the
 * only way to make those surfaces describe an external agent — without writing fabricated
 * events into the session log — is to give the session a composition that actually carries
 * that agent's tools. This plugin is that composition's contribution: it registers the tools
 * the named agent declares, so the loop logs them honestly and every derived surface follows.
 *
 * Execution is a **delegation**, not a protocol-level tool call: the harness's duplex
 * transports (Codex app-server, Pi/omp RPC) are still deferred (ADR-0003), so a call forwards
 * the work to the agent as a task and returns its answer. That is slower than a native call
 * and it is stated in every tool description, because a caller should know it is asking the
 * other agent to do something rather than doing it here.
 *
 * Self-contained on purpose: this is a separate bundle entry mounted by a preset, so it
 * imports nothing from the plugin's host entry and probes the harness itself.
 *
 * @module @zorker/muti-agent-plugin/agent-proxy
 */

import { s } from '@zorker/muti-agent-contracts'

/** Deployment config for one proxy instance: which agent it stands in for. */
export interface Config {
  /** Canonical agent id whose tools this preset exposes. */
  agentId: string
  /**
   * Maximum tools to register.
   *
   * A cap rather than an unbounded list because every proxied tool is one more entry in the
   * harness agent's prompt; the agents here declare up to thirty, and a preset that quietly
   * tripled the tool catalog would cost tokens on every request.
   */
  maxTools: number
}

/** Validated configuration shape. */
export const Config = s
  .objectOpt(
    { agentId: s.string().min(1).describeAs('Agent whose tools this preset exposes.') },
    { maxTools: s.number().int().min(1).max(64).describeAs('Maximum tools to register.') },
  )
  .describeAs('Expose one external agent\'s tools to the harness agent.')

/** Where the proxy reaches MutiAgent's own control plane. */
interface MeshService {
  invoke(method: string, params: object, options: { actor: { id: string, trusted: boolean } }): Promise<
    { ok: true, result: unknown } | { ok: false, error: { code: string, message: string, remediation?: string } }
  >
}

/** One inventory row as this plugin reads it. */
interface ToolRow {
  name: string
  description?: string
  source: string
  discoverable?: boolean
}

/** The structural slice of a Cordis context this plugin uses. */
interface ProxyContext {
  get(name: string): unknown
  inject?(deps: readonly string[], callback: () => void): unknown
  effect?(callback: () => () => void, label?: string): () => void
  logger?: { debug?(line: string): void, warn?(line: string): void }
}

/**
 * Register one proxied tool.
 *
 * @param tools - The harness tool registry.
 * @param mesh - MutiAgent's control plane.
 * @param agentId - The agent this preset stands in for.
 * @param row - The declared tool.
 * @returns The tool's disposer.
 */
function registerProxyTool(
  tools: { register(definition: unknown): () => void },
  mesh: MeshService,
  agentId: string,
  row: ToolRow,
): () => void {
  const description = [
    `Ask ${agentId} to use its own "${row.name}" tool.`,
    row.description === undefined ? '' : row.description,
    `The call is delegated: ${agentId} runs it in its own environment and this tool returns its answer, so it is slower than a native tool and it is not executed here.`,
  ]
    .filter(part => part !== '')
    .join(' ')
  return tools.register({
    name: `agent_${agentId}_${row.name}`,
    description,
    // The arguments are the other agent's business: they are passed through as a task rather
    // than validated against a schema this plugin does not own.
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', description: 'What to accomplish, in plain words.' } },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      }],
    },
    execute: async (args: unknown, exec: { signal?: AbortSignal }): Promise<unknown> => {
      const task = typeof args === 'object' && args !== null && typeof (args as { task?: unknown }).task === 'string'
        ? (args as { task: string }).task
        : ''
      const prompt = [
        `${task}`,
        '',
        `Use your "${row.name}" tool to accomplish the above. Report what you did and the result.`,
      ].join('\n')
      // The caller's cancellation stops this tool's wait. It does **not** kill the delegated
      // run: that is a separate process tree the run manager owns, and it stays visible in the
      // Mesh panel where `runs.cancel` can stop it. Said here rather than left to be discovered.
      const outcome = await mesh.invoke(
        'runs.start',
        { agentId, prompt, wait: true, isolation: 'shared-cwd', requestedBy: 'harness-agent' },
        {
          actor: { id: 'harness-agent', trusted: true },
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        },
      )
      if (!outcome.ok) {
        throw new Error(`${outcome.error.code}: ${outcome.error.message}${outcome.error.remediation === undefined ? '' : ` — ${outcome.error.remediation}`}`)
      }
      return outcome.result
    },
  })
}

/**
 * Register the named agent's tools in the scope this plugin is mounted under.
 *
 * @param ctx - The scope's context (a preset-mounted context, so registrations land in that
 *   preset's layer and therefore appear only for sessions bound to it).
 * @param config - The agent to stand in for and the tool cap.
 */
export async function apply(ctx: ProxyContext, config: Config): Promise<void> {
  const run = async (): Promise<void> => {
    const tools = ctx.get('tools') as { register(definition: unknown): () => void } | undefined
    const mesh = ctx.get('mutiAgent') as MeshService | undefined
    if (tools === undefined || mesh === undefined) {
      ctx.logger?.warn?.(
        `muti-agent: the ${config.agentId} proxy preset could not register its tools (tools service: ${tools === undefined ? 'absent' : 'present'}, control plane: ${mesh === undefined ? 'absent' : 'present'})`,
      )
      return
    }
    const read = await mesh.invoke(
      'capabilities.get',
      { agentId: config.agentId },
      { actor: { id: 'agent-proxy', trusted: true } },
    )
    if (!read.ok) {
      ctx.logger?.warn?.(`muti-agent: could not read ${config.agentId}'s tools: ${read.error.code}: ${read.error.message}`)
      return
    }
    const inventory = read.result as { tools?: readonly ToolRow[] }
    const rows = (inventory.tools ?? []).slice(0, config.maxTools)
    const disposers: (() => void)[] = []
    for (const row of rows) disposers.push(registerProxyTool(tools, mesh, config.agentId, row))
    const disposeAll = (): void => { for (const dispose of disposers.reverse()) dispose() }
    if (typeof ctx.effect === 'function') ctx.effect(() => disposeAll, `mutiagent: ${config.agentId} proxy tools`)
    const truncated = (inventory.tools ?? []).length - rows.length
    ctx.logger?.debug?.(
      `muti-agent: ${String(rows.length)} ${config.agentId} tool(s) proxied into this preset${truncated > 0 ? ` (${String(truncated)} beyond the cap of ${String(config.maxTools)} were not registered)` : ''}`,
    )
  }
  if (typeof ctx.inject === 'function') {
    // The control plane is published by the host plugin and may activate after this preset
    // row does, so waiting for it is what makes the tools appear deterministically.
    ctx.inject(['tools', 'mutiAgent'], () => { void run() })
    return
  }
  await run()
}
