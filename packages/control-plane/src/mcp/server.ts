/**
 * The MCP server: JSON-RPC 2.0 over a pluggable transport, exposing the operation
 * catalog as MCP tools (ADR-0011).
 *
 * Only the subset MutiAgent needs is implemented — `initialize`, `tools/list`,
 * `tools/call`, `ping` — because the whole point is to ship no dependency into a
 * user's host process, and the required surface is small and stable. The transport is
 * abstracted so stdio and streamable HTTP share this file, and so swapping in the
 * official SDK later is a local change (see the ADR's consequences).
 *
 * @module @zorker/muti-agent-control-plane/mcp/server
 */

import {
  ErrorCodes,
  MutiAgentError,
  PLUGIN_VERSION,
  SCHEMA_VERSION,
  WIRE_VERSION,
  toErrorShape,
} from '@zorker/muti-agent-contracts'
import { Dispatcher, mcpActor, type InvokeRequest } from '../dispatch.ts'

/** Protocol versions this server accepts, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

/** The protocol version used when a client asks for one we do not know. */
export const FALLBACK_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

/** One JSON-RPC request or notification. */
export interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

/** One JSON-RPC response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number, message: string, data?: unknown }
}

/**
 * An MCP server bound to one dispatcher. One instance per client connection, so
 * per-connection state (the negotiated protocol version, the client's name) never
 * leaks between clients.
 */
export class McpServer {
  private initialized = false
  private protocolVersion: string = FALLBACK_PROTOCOL_VERSION
  private clientName = 'unknown'
  private clientVersion = 'unknown'

  /**
   * @param dispatcher - Operation dispatch, shared across connections.
   * @param serverName - Advertised server name.
   */
  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly serverName = 'mutiagent',
  ) {}

  /** Whether the client completed the `initialize` handshake. */
  get ready(): boolean {
    return this.initialized
  }

  /** The negotiated protocol version. */
  get negotiatedVersion(): string {
    return this.protocolVersion
  }

  /** The client identity reported at `initialize`, for the audit journal. */
  get client(): { name: string, version: string } {
    return { name: this.clientName, version: this.clientVersion }
  }

  /**
   * Handle one inbound message.
   *
   * @param message - Parsed JSON-RPC request or notification.
   * @param signal - Cancellation for the underlying operation.
   * @returns A response to send, or `undefined` for a notification (which must not be
   *   answered).
   */
  async handle(message: JsonRpcMessage, signal?: AbortSignal): Promise<JsonRpcResponse | undefined> {
    const id = message.id ?? null
    const method = typeof message.method === 'string' ? message.method : ''
    const isNotification = message.id === undefined || message.id === null

    if (method === '') {
      if (isNotification) return undefined
      return errorResponse(id, -32600, 'invalid request: no method')
    }

    try {
      if (method === 'initialize') {
        this.applyInitialize(message.params)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: this.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.serverName, version: PLUGIN_VERSION },
            instructions: [
              'MutiAgent drives other coding agents (Codex, Grok Build, Pi) from one place.',
              'Read tools are safe to call freely. A tool that reports confirmationRequired',
              'has not run: ask the human, then repeat the call with confirm: true.',
            ].join(' '),
          },
        }
      }
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        return undefined
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

      if (!this.initialized && (method === 'tools/list' || method === 'tools/call')) {
        return errorResponse(id, -32002, 'server not initialized: send initialize first')
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: this.dispatcher.operations.tools().map(operation => ({
              name: toolName(operation.id),
              description: `${operation.summary} (schema v${String(SCHEMA_VERSION)}, wire v${String(WIRE_VERSION)})`,
              inputSchema: operation.params.toJsonSchema(),
              annotations: {
                readOnlyHint: operation.scope === 'read',
                destructiveHint: operation.danger === 'irreversible',
                idempotentHint: operation.scope === 'read',
                openWorldHint: operation.scope !== 'read',
              },
            })),
          },
        }
      }

      if (method === 'tools/call') {
        return await this.handleToolCall(id, message.params, signal)
      }

      if (isNotification) return undefined
      return errorResponse(id, -32601, `method not found: ${method}`)
    } catch (cause) {
      if (isNotification) return undefined
      const shape = toErrorShape(cause)
      return errorResponse(id, -32603, shape.message, shape)
    }
  }

  /** Apply an `initialize` request, tolerating a client that omits the version. */
  private applyInitialize(params: unknown): void {
    const record = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
    const requested = typeof record.protocolVersion === 'string' ? record.protocolVersion : undefined
    this.protocolVersion = requested !== undefined && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : FALLBACK_PROTOCOL_VERSION
    const clientInfo = record.clientInfo
    if (typeof clientInfo === 'object' && clientInfo !== null) {
      const info = clientInfo as Record<string, unknown>
      if (typeof info.name === 'string' && info.name !== '') this.clientName = info.name
      if (typeof info.version === 'string' && info.version !== '') this.clientVersion = info.version
    }
    this.initialized = true
  }

  /** Dispatch one `tools/call`, mapping the operation result onto MCP's content shape. */
  private async handleToolCall(id: string | number | null, params: unknown, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const record = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
    const rawName = record.name
    if (typeof rawName !== 'string' || rawName === '') {
      return errorResponse(id, -32602, 'invalid params: tools/call requires a tool name')
    }
    // Resolve by deriving each catalog id's tool name and comparing, rather than by
    // reversing the string transform: `sessions.list` and `sessions_list` would map to
    // the same name, and a lookup that guesses is a lookup that eventually calls the
    // wrong method.
    const operationId = resolveToolName(this.dispatcher.operations, rawName)
    if (operationId === undefined) {
      return errorResponse(id, -32602, `unknown tool: ${rawName}`)
    }
    const args = typeof record.arguments === 'object' && record.arguments !== null
      ? (record.arguments as Record<string, unknown>)
      : {}
    const request: InvokeRequest = { method: operationId, params: args }
    const result = await this.dispatcher.invoke(request, {
      actor: mcpActor(this.clientName),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!result.ok) {
      // A tool failure is a successful JSON-RPC call with `isError`; that is what tells
      // a model the tool ran and failed, as opposed to the protocol being broken.
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `${result.error.code}: ${result.error.message}${result.error.remediation === undefined ? '' : `\n\nNext step: ${result.error.remediation}`}` }],
        },
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: false,
        content: [{ type: 'text', text: renderResult(result.result) }],
        structuredContent: result.result,
      },
    }
  }
}

/**
 * The MCP tool name for an operation id. Dots are not legal in every client's tool
 * name validation, so they become underscores, and the mapping is not injective —
 * which is why the reverse lookup goes through the catalog instead of string surgery.
 */
export function toolName(operationId: string): string {
  return `mutiagent_${operationId.replace(/\./g, '_')}`
}

/**
 * Resolve a tool name back to an operation id.
 *
 * Uses the catalog as the authority: the dot-to-underscore substitution is not
 * injective, so a string reverse-transform could route a call to a different method
 * than the client named.
 *
 * @param catalog - The live operation catalog.
 * @param name - The tool name a client sent.
 * @returns The operation id, or `undefined` when no exposed tool has that name.
 */
export function resolveToolName(
  catalog: { list(): readonly { id: string, exposeAsTool: boolean }[] },
  name: string,
): string | undefined {
  for (const operation of catalog.list()) {
    if (!operation.exposeAsTool) continue
    if (toolName(operation.id) === name) return operation.id
  }
  return undefined
}

/** Render a result as text for a model: JSON, bounded so a large list stays readable. */
function renderResult(result: unknown): string {
  const text = JSON.stringify(result, null, 2)
  const limit = 200_000
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… output truncated at ${String(limit)} characters; narrow the request to see the rest.`
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const response: JsonRpcResponse = { jsonrpc: '2.0', id, error: { code, message } }
  if (data !== undefined) response.error = { code, message, data }
  return response
}

/**
 * Parse one line of a stdio MCP stream.
 *
 * @param line - One line, without its terminator.
 * @returns The parsed message, or `undefined` when the line is blank or malformed.
 */
export function parseMcpLine(line: string): { message?: JsonRpcMessage, error?: string } {
  const trimmed = line.trim()
  if (trimmed === '') return {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { error: 'message must be a JSON object' }
    return { message: parsed as JsonRpcMessage }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Validate a stdio server's environment before it starts: MutiAgent's MCP server needs
 * the state directory, and failing loudly beats connecting and then reporting empty
 * results.
 *
 * @param env - The server process environment.
 * @throws {MutiAgentError} `harness/service-missing` when the state directory is unset.
 */
export function requireStdioEnvironment(env: NodeJS.ProcessEnv = process.env): { stateDir: string } {
  const stateDir = env.MUTI_AGENT_STATE_DIR
  if (stateDir === undefined || stateDir === '') {
    throw new MutiAgentError(
      ErrorCodes.harnessServiceMissing,
      'MUTI_AGENT_STATE_DIR is not set for the stdio MCP server',
      {
        remediation:
          'Add MUTI_AGENT_STATE_DIR to the MCP server entry so it reads the same state as the harness host.',
      },
    )
  }
  return { stateDir }
}
