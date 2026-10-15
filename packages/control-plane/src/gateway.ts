/**
 * The HTTP + SSE gateway for the browser GUI (ADR-0004).
 *
 * It does not authenticate: the routes are registered on the harness's own
 * authenticated `/api` channel, which applies its browser-trust fence and admits only
 * owner peers before a request reaches this code. The gateway therefore only has to
 * parse, dispatch and serialize.
 *
 * Route shape is deliberately minimal — one request/response endpoint and one event
 * stream — because a method registry makes N routes unnecessary, keeps route
 * registration a single effect, and gives the MCP server and the tool catalog the same
 * enumerable surface.
 *
 * @module @zorker/muti-agent-control-plane/gateway
 */

import {
  ErrorCodes,
  MutiAgentError,
  SCHEMA_VERSION,
  WIRE_VERSION,
  toErrorShape,
} from '@zorker/muti-agent-contracts'
import type { MeshEvent } from '@zorker/muti-agent-core'
import { Dispatcher, browserActor, type InvokeRequest } from './dispatch.ts'
import { McpServer, type JsonRpcMessage } from './mcp/server.ts'

/**
 * Route paths, **including** the `/api` prefix.
 *
 * The harness validates an exact route by stripping its `/api` channel prefix and
 * requiring every remaining segment to match `[A-Za-z0-9_$.-]+`, so the registered path
 * must be absolute from the origin. Passing a bare `/mutiagent/...` fails at activation
 * with `connection: invalid exact Fetch route`.
 */
export const ROUTES = {
  /** Method invocation. */
  rpc: '/api/mutiagent/rpc',
  /** Server-sent event stream. */
  events: '/api/mutiagent/events',
  /** MCP streamable HTTP endpoint. */
  mcp: '/api/mutiagent/mcp',
} as const

/** A route as the host plugin must register it. */
export interface GatewayRoute {
  path: string
  methods: readonly ('GET' | 'HEAD' | 'POST')[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

/** Gateway limits and identity policy. */
export interface GatewayOptions {
  /** Maximum accepted request body size for the RPC route. */
  maxBodyBytes: number
  /** SSE heartbeat interval; keeps intermediaries from closing an idle stream. */
  heartbeatMs: number
  /** How long a new SSE subscriber receives the buffered backlog, in events. */
  backlogLimit: number
  /**
   * Supplies the signed operator id for a request, when the host can provide one. Used
   * only for the audit journal; admission has already happened.
   */
  subjectOf?: (request: Request) => string | undefined
}

const DEFAULT_OPTIONS: GatewayOptions = {
  maxBodyBytes: 4 * 1024 * 1024,
  heartbeatMs: 15_000,
  backlogLimit: 200,
}

/** The gateway's routes, ready to hand to the host's route registry. */
export class Gateway {
  private readonly options: GatewayOptions
  private readonly streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  /**
   * MCP sessions, keyed by the id handed back at `initialize`.
   *
   * Streamable HTTP is a request/response transport, so the `initialize` handshake, the
   * negotiated protocol version and the client identity live here rather than in the
   * connection. A single-session client that omits the header (which is common) is
   * served by the only open session instead of being forced to re-initialize per call.
   */
  private readonly mcpSessions = new Map<string, McpServer>()
  private lastMcpSessionId: string | undefined

  /**
   * @param dispatcher - Shared operation dispatch.
   * @param subscribe - The mesh event stream to forward to SSE clients.
   * @param options - Limits and identity policy.
   */
  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly subscribe: (push: (event: MeshEvent) => void) => () => void,
    options: Partial<GatewayOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * Build the routes.
   *
   * @returns One entry per endpoint, with the absolute path the harness expects.
   */
  routes(): readonly GatewayRoute[] {
    return [
      { path: ROUTES.rpc, methods: ['POST'], requestBody: 'buffered', fetch: request => this.handleRpc(request) },
      { path: ROUTES.events, methods: ['GET'], requestBody: 'buffered', fetch: request => this.handleEvents(request) },
      { path: ROUTES.mcp, methods: ['POST'], requestBody: 'buffered', fetch: request => this.handleMcp(request) },
    ]
  }

  /** Close every open event stream, so a plugin unload does not leak responses. */
  close(): void {
    for (const stream of this.streams) {
      try {
        stream.close()
      } catch {
        // Already closed by the client; nothing to release.
      }
    }
    this.streams.clear()
    this.mcpSessions.clear()
    this.lastMcpSessionId = undefined
  }

  /** Dispatch one JSON envelope. */
  private async handleRpc(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'use POST' }, 405)
    let body: unknown
    try {
      body = await this.readJson(request)
    } catch (cause) {
      return json(failure(cause), 400)
    }
    const envelope = asRecord(body)
    const method = typeof envelope.method === 'string' ? envelope.method : ''
    const params = envelope.params
    const confirm = envelope.confirm === true
    const invoke: InvokeRequest = {
      method,
      params: params ?? {},
      ...(confirm ? { confirm: true } : {}),
    }
    const result = await this.dispatcher.invoke(invoke, {
      actor: browserActor(this.subjectOf(request)),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    // A failed operation is still an answered HTTP request: the envelope carries the
    // failure, so a client never has to distinguish transport errors from domain
    // errors by status code alone.
    return json(result, 200)
  }

  /** Stream mesh events as SSE. */
  private async handleEvents(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'use GET' }, 405)
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200 })

    const encoder = new TextEncoder()
    const backlog: MeshEvent[] = []
    let unsubscribe: (() => void) | undefined
    let heartbeat: NodeJS.Timeout | undefined
    let closed = false

    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        this.streams.add(controller)
        const write = (event: MeshEvent): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          } catch {
            // The client vanished; teardown below releases the subscription.
            cleanup()
          }
        }
        // An opening comment flushes headers so the client's `open` fires immediately,
        // rather than after the first event hours later on a quiet machine.
        controller.enqueue(encoder.encode(`: mutiagent ${String(SCHEMA_VERSION)}/${String(WIRE_VERSION)}\n\n`))

        unsubscribe = this.subscribe(event => {
          if (backlog.length < this.options.backlogLimit) backlog.push(event)
          write(event)
        })
        heartbeat = setInterval(() => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`))
          } catch {
            cleanup()
          }
        }, this.options.heartbeatMs)
        heartbeat.unref?.()

        const cleanup = (): void => {
          if (closed) return
          closed = true
          if (heartbeat !== undefined) clearInterval(heartbeat)
          unsubscribe?.()
          this.streams.delete(controller)
          try {
            controller.close()
          } catch {
            // Already closed.
          }
        }
        request.signal.addEventListener('abort', cleanup, { once: true })
      },
      cancel: () => {
        closed = true
        if (heartbeat !== undefined) clearInterval(heartbeat)
        unsubscribe?.()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  }

  /** Handle one MCP message over streamable HTTP, replying as JSON. */
  private async handleMcp(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'use POST' }, 405)
    let body: unknown
    try {
      body = await this.readJson(request)
    } catch (cause) {
      return json(failure(cause), 400)
    }
    const messages = Array.isArray(body) ? (body as JsonRpcMessage[]) : [body as JsonRpcMessage]
    const declaredId = request.headers.get('mcp-session-id') ?? undefined
    const session = this.mcpSession(declaredId)
    const responses: unknown[] = []
    let opening = false
    for (const message of messages) {
      if (message.method === 'initialize') opening = true
      const response = await session.handle(
        message,
        request.signal === undefined ? undefined : request.signal,
      )
      if (response !== undefined) responses.push(response)
    }
    if (responses.length === 0) return new Response(null, { status: 202 })
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }
    // The id is announced at initialize and echoed by the client on later requests, so
    // each client keeps its own negotiated protocol version and client identity.
    if (opening || declaredId !== undefined) headers['mcp-session-id'] = this.lastMcpSessionId ?? ''
    return new Response(JSON.stringify(responses.length === 1 ? responses[0] : responses), {
      status: 200,
      headers,
    })
  }

  /**
   * The MCP session for a request.
   *
   * @param declaredId - The `Mcp-Session-Id` header, when the client sent one.
   * @returns The matching session, the only open session for a header-less client, or a
   *   fresh session when neither applies.
   */
  private mcpSession(declaredId: string | undefined): McpServer {
    if (declaredId !== undefined) {
      const existing = this.mcpSessions.get(declaredId)
      if (existing !== undefined) return existing
    } else if (this.mcpSessions.size === 1 && this.lastMcpSessionId !== undefined) {
      const only = this.mcpSessions.get(this.lastMcpSessionId)
      if (only !== undefined) return only
    }
    const id = `mcp-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`
    const session = new McpServer(this.dispatcher)
    this.mcpSessions.set(id, session)
    this.lastMcpSessionId = id
    // A long-lived gateway must not accumulate abandoned sessions.
    if (this.mcpSessions.size > 16) {
      const oldest = this.mcpSessions.keys().next()
      if (!oldest.done && oldest.value !== id) this.mcpSessions.delete(oldest.value)
    }
    return session
  }

  /** Read and parse a JSON body with a size ceiling. */
  private async readJson(request: Request): Promise<unknown> {
    const declared = request.headers.get('content-length')
    if (declared !== null && Number.parseInt(declared, 10) > this.options.maxBodyBytes) {
      throw new MutiAgentError(
        ErrorCodes.wireBadEnvelope,
        `request body exceeds ${String(this.options.maxBodyBytes)} bytes`,
        { remediation: 'Send a smaller request; narrow the query and paginate.' },
      )
    }
    const text = await request.text()
    if (text.length > this.options.maxBodyBytes) {
      throw new MutiAgentError(ErrorCodes.wireBadEnvelope, 'request body exceeds the size limit', {
        remediation: 'Send a smaller request; narrow the query and paginate.',
      })
    }
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text) as unknown
    } catch (cause) {
      throw new MutiAgentError(ErrorCodes.wireBadEnvelope, 'request body is not valid JSON', {
        cause,
        remediation: 'Send a JSON object with `method` and optional `params`.',
      })
    }
  }

  private subjectOf(request: Request): string | undefined {
    return this.options.subjectOf?.(request)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function failure(cause: unknown): unknown {
  return {
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    wireVersion: WIRE_VERSION,
    error: toErrorShape(cause),
  }
}
