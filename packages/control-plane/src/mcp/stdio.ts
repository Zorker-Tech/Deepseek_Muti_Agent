/**
 * The stdio MCP entry: a standalone process that speaks MCP over stdin/stdout so any
 * MCP client — one of the integrated agents, an IDE, or another orchestrator — can
 * drive MutiAgent without the harness running (ADR-0011).
 *
 * It builds the same domain layer the host plugin builds, from environment variables,
 * so a stdio client and the GUI see one shared state directory rather than two
 * divergent ones. Failing loudly when the state directory is unset is deliberate: a
 * second, empty world is worse than a clear error.
 *
 * @module @zorker/muti-agent-control-plane/mcp/stdio
 */

import { createInterface } from 'node:readline'
import { MutiAgentService, type AdapterSettings } from '@zorker/muti-agent-core'
import { registerOperations, type RegistrationContext } from '../operations/register.ts'
import { OperationCatalog } from '../operations/catalog.ts'
import { Dispatcher } from '../dispatch.ts'
import { McpServer } from './server.ts'

/** Environment keys the stdio entry understands. */
export const ENV = {
  /** Absolute state directory. Required. */
  stateDir: 'MUTI_AGENT_STATE_DIR',
  /** Comma-separated agent ids to enable; omitted enables every adapter that is installed. */
  agents: 'MUTI_AGENT_AGENTS',
  /** Log level for the diagnostic channel on stderr. */
  logLevel: 'MUTI_AGENT_LOG_LEVEL',
  /** Disable worktree isolation for this server. */
  noWorktree: 'MUTI_AGENT_NO_WORKTREE',
} as const

/** A stdio server: MCP on stdout, diagnostics on stderr. */
export interface StdioServerHandle {
  /** Stop reading and close the server. */
  close(): Promise<void>
  /** The dispatcher, exposed so an embedder can call operations in-process. */
  dispatcher: Dispatcher
}

/**
 * Build the domain layer for a standalone MCP server.
 *
 * @param env - Environment to read configuration from.
 * @returns The service and its catalog.
 * @throws {Error} when the required state directory is missing.
 */
export async function createStdioService(env: NodeJS.ProcessEnv = process.env): Promise<{
  service: MutiAgentService
  catalog: OperationCatalog
  context: RegistrationContext
}> {
  const stateDir = env[ENV.stateDir]
  if (stateDir === undefined || stateDir === '') {
    throw new Error(
      `${ENV.stateDir} must be set so the MCP server shares the harness's MutiAgent state; refusing to start with a private, empty state directory`,
    )
  }
  const enabled = (env[ENV.agents] ?? '').split(',').map(name => name.trim()).filter(name => name !== '')
  const adapterSettings: Record<string, AdapterSettings> = {}
  for (const agentId of enabled) adapterSettings[agentId] = { enabled: true }

  const service = new MutiAgentService({
    stateDir,
    adapters: adapterSettings,
    logLevel: (env[ENV.logLevel] as 'silent' | 'error' | 'warn' | 'info' | 'debug' | undefined) ?? 'warn',
    ...(env[ENV.noWorktree] === '1' ? { worktree: { enabled: false } } : {}),
  })

  const { registerDefaultAdapters } = await import('../adapters.ts')
  await registerDefaultAdapters(service, {
    ...(enabled.length === 0 ? {} : { enabled }),
  })
  await service.start()

  const catalog = new OperationCatalog()
  const context: RegistrationContext = {
    pluginVersion: '0.1.0',
    // The standalone server has no harness at all, so every surface is absent by
    // construction rather than by failure.
    surfaces: () => ({
      services: [],
      missing: [
        { service: 'tools', disables: 'native tools (this is the standalone MCP server)' },
        { service: 'commands', disables: 'slash commands (this is the standalone MCP server)' },
        { service: 'connection', disables: 'the browser gateway (this is the standalone MCP server)' },
      ],
      failed: [],
    }),
    // The standalone server registers no model routes: it has no harness LLM layer to
    // register them into, and saying so is more useful than an empty list.
    modelRoutes: () => [{
      agentId: '*',
      providers: [],
      notes: ['the standalone MCP server has no harness LLM layer, so no model routes are registered'],
    }],
    ...(process.argv[1] === undefined ? {} : { mcpEntry: process.argv[1] }),
  }
  registerOperations(catalog, context)
  return { service, catalog, context }
}

/**
 * Start the server on stdin/stdout.
 *
 * @param env - Configuration environment.
 * @returns A handle whose `close` stops the server.
 */
export async function startStdioServer(env: NodeJS.ProcessEnv = process.env): Promise<StdioServerHandle> {
  const { service, catalog } = await createStdioService(env)
  const dispatcher = new Dispatcher(service, catalog)
  const server = new McpServer(dispatcher)

  const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  const write = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }

  let closed = false
  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch (cause) {
      // A malformed frame is answered rather than ignored, because a client waiting on
      // a response would otherwise hang forever.
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `parse error: ${cause instanceof Error ? cause.message : String(cause)}` },
      })
      return
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue
      const response = await server.handle(message as never)
      if (response !== undefined) write(response)
    }
  }

  let chain: Promise<void> = Promise.resolve()
  reader.on('line', line => {
    // Serialize handling: two interleaved tool calls would each write their response
    // whenever they finished, which is legal MCP but makes a hard-to-read stream and
    // races the `initialize` handshake.
    chain = chain.then(() => handleLine(line)).catch((cause: unknown) => {
      process.stderr.write(`[muti-agent] mcp line failed: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    })
  })

  await new Promise<void>(resolve => { reader.once('close', resolve) })
  closed = true
  await service.runs.drain(2_000)

  return {
    dispatcher,
    close: async () => {
      if (closed) return
      closed = true
      reader.close()
    },
  }
}
