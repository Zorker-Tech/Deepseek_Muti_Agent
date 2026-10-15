/**
 * The bridge against a stub provider that speaks the wire protocol it implements.
 *
 * A real HTTP server on loopback emits the SSE bytes a chat-completions endpoint sends —
 * text deltas, a tool call split across three chunks, a usage record, `[DONE]` — and the
 * assertions read the whole `StreamChunk` sequence, member by member, in order. The
 * framing cases that are easy to get subtly wrong (multi-line `data`, comments, `CRLF`, a
 * chunk boundary inside a UTF-8 sequence, an unterminated final record) each have their own
 * case, because a framing bug is invisible until a provider does one of them.
 *
 * Run it with either runner:
 *
 * ```sh
 * node --test packages/llm-bridge/tests/stub-provider.test.ts
 * node packages/llm-bridge/tests/stub-provider.test.ts
 * ```
 *
 * @module @zorker/muti-agent-llm-bridge/tests/stub-provider
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { after, test } from 'node:test'
import { reasoningEffortId, toolCallId } from '../src/contract.ts'
import { streamChatCompletions } from '../src/openai.ts'
import type { ChatCompletionsTarget } from '../src/openai.ts'
import type { GenerateOptions, StreamChunk } from '../src/contract.ts'

/** One recorded request the stub provider received. */
interface RecordedRequest {
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** What the stub provider answers with. */
interface StubAnswer {
  status?: number
  headers?: Record<string, string>
  /** Body text, written in slices of this many bytes so chunk boundaries are exercised. */
  body: string
  sliceBytes?: number
}

/** A running stub provider and the requests it received. */
interface StubProvider {
  endpoint: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

const servers: Server[] = []

/** Start a stub provider that answers every request with one scripted response. */
async function serve(answer: StubAnswer | ((request: RecordedRequest) => StubAnswer)): Promise<StubProvider> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const body = await readRequest(request)
      const recorded: RecordedRequest = { url: request.url ?? '', headers: request.headers, body }
      requests.push(recorded)
      const scripted = typeof answer === 'function' ? answer(recorded) : answer
      response.writeHead(scripted.status ?? 200, {
        'content-type': 'text/event-stream',
        ...scripted.headers ?? {},
      })
      const bytes = Buffer.from(scripted.body, 'utf8')
      const slice = scripted.sliceBytes ?? bytes.length
      for (let offset = 0; offset < bytes.length; offset += slice) {
        response.write(bytes.subarray(offset, Math.min(offset + slice, bytes.length)))
        // Yield to the event loop so the client sees separate chunks rather than one write.
        await new Promise(resolve => setImmediate(resolve))
      }
      response.end()
    })().catch(() => {
      response.destroy()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stub provider did not bind a port')
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

/** Read a request body into text. */
async function readRequest(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  for await (const part of request) {
    parts.push(typeof part === 'string' ? Buffer.from(part) : part)
  }
  return Buffer.concat(parts).toString('utf8')
}

/** A minimal request for a stub route. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'stub',
    model: 'stub-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  }
}

/** Collect a call's chunks, and the failure when it threw. */
async function collect(
  provider: StubProvider,
  options: GenerateOptions,
  target: Partial<ChatCompletionsTarget> = {},
): Promise<{ chunks: StreamChunk[]; failure: unknown }> {
  const chunks: StreamChunk[] = []
  const stream = streamChatCompletions(options, {
    provider: 'stub',
    endpoint: provider.endpoint,
    headers: { authorization: 'Bearer stub-key' },
    supportsReasoningEffort: true,
    ...target,
  })
  try {
    for await (const chunk of stream) chunks.push(chunk)
    return { chunks, failure: undefined }
  } catch (failure: unknown) {
    return { chunks, failure }
  }
}

/** Read a typed error code off a caught failure, without assuming its class. */
function codeOf(failure: unknown): unknown {
  return typeof failure === 'object' && failure !== null && 'code' in failure
    ? (failure as { code: unknown }).code
    : undefined
}

/** Read a typed failure's serializable facts off a caught failure. */
function factsOf(failure: unknown): unknown {
  return typeof failure === 'object' && failure !== null && 'failure' in failure
    ? (failure as { failure: unknown }).failure
    : undefined
}

after(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => { resolve() })
  })))
})

/**
 * The required sequence: one text block, one tool call split across three chunks, usage,
 * and the terminal tool-calls finish — every member, in order.
 */
test('a tool call split across three chunks yields the exact chunk sequence', async () => {
  const provider = await serve({
    body: [
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Checking"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" the weather."},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":31,"completion_tokens":9,"total_tokens":40,"prompt_tokens_details":{"cached_tokens":7},"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
      'data: [DONE]\n\n',
    ].join(''),
    sliceBytes: 64,
  })

  const { chunks, failure } = await collect(provider, request({ maxTokens: 64 }), {
    wireModel: 'stub-model',
  })
  console.log('observed chunk sequence:\n' + JSON.stringify(chunks, null, 2))
  assert.equal(failure, undefined)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Checking' },
    { type: 'text-delta', index: 0, text: ' the weather.' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call_abc', name: 'get_weather', argumentsDelta: '{"ci' },
    { type: 'tool-call-delta', index: 1, id: 'call_abc', name: 'get_weather', argumentsDelta: 'ty":"' },
    { type: 'tool-call-delta', index: 1, id: 'call_abc', name: 'get_weather', argumentsDelta: 'Paris"}' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Checking the weather.' } },
    {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' },
    },
    { type: 'usage', usage: { inputTokens: 24, outputTokens: 9, totalTokens: 40, cacheReadTokens: 7, reasoningTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  const sent = JSON.parse(provider.requests[0]?.body ?? '{}') as Record<string, unknown>
  assert.deepEqual(sent.stream_options, { include_usage: true })
  assert.equal(sent.stream, true)
  assert.equal(sent.max_tokens, 64)
  assert.equal(sent.model, 'stub-model')
  assert.equal(provider.requests[0]?.headers.authorization, 'Bearer stub-key')
  assert.match(String(provider.requests[0]?.headers['user-agent']), /^muti-agent\/\d/)
})

test('comments, CRLF, multi-line data and a UTF-8 split are framed correctly', async () => {
  // The slice size is chosen to cut the multi-byte characters below in half.
  const text = 'héllo 世界'
  const provider = await serve({
    body: [
      ': keep-alive\r\n',
      '\r\n',
      `data: {"choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\r\n`,
      '\r\n',
      'event: message\r\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"},\r\n',
      'data: "finish_reason":null}]}\r\n',
      '\r\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n',
      '\r\n',
      'data: [DONE]\r\n',
      '\r\n',
    ].join(''),
    sliceBytes: 7,
  })

  const { chunks, failure } = await collect(provider, request())
  assert.equal(failure, undefined)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: 'think' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'think' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('an unterminated final record is discarded, and a stream with no terminal signal fails', async () => {
  const provider = await serve({
    body: 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"cut off"',
  })
  const { chunks, failure } = await collect(provider, request())
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
  ])
  assert.equal(codeOf(failure), 'STREAM_CLOSED')
})

test('a stream cut after the terminal reason still finishes', async () => {
  const provider = await serve({
    body: 'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
  })
  const { chunks, failure } = await collect(provider, request())
  assert.equal(failure, undefined)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('a completed response with no content is an empty response', async () => {
  const provider = await serve({
    body: 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  })
  const { chunks, failure } = await collect(provider, request())
  assert.deepEqual(chunks, [])
  assert.equal(codeOf(failure), 'EMPTY_RESPONSE')
})

test('HTTP failures carry the codes the retry policy routes on', async () => {
  const cases: readonly { status: number; body: string; headers?: Record<string, string>; code: string; retryAfterMs?: number }[] = [
    { status: 401, body: '{"error":{"message":"invalid api key","type":"authentication_error"}}', code: 'AUTH', },
    { status: 403, body: '{"error":{"message":"forbidden"}}', code: 'AUTH' },
    {
      status: 429,
      body: '{"error":{"message":"rate limit reached for gpt","type":"rate_limit_error"}}',
      headers: { 'retry-after': '2' },
      code: 'RATE_LIMIT',
      retryAfterMs: 2000,
    },
    { status: 500, body: '{"error":{"message":"internal server error"}}', code: 'SERVER' },
    { status: 400, body: '{"error":{"message":"invalid request: unknown field"}}', code: 'INVALID_REQUEST' },
    { status: 400, body: '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 4096 tokens"}}', code: 'CONTEXT_WINDOW_EXCEEDED' },
    { status: 402, body: '{"error":{"message":"insufficient balance"}}', code: 'QUOTA' },
    { status: 404, body: 'not found', code: 'INVALID_REQUEST' },
    { status: 418, body: '{}', code: 'HTTP_418' },
  ]
  for (const testCase of cases) {
    const provider = await serve({
      status: testCase.status,
      body: testCase.body,
      ...testCase.headers === undefined ? {} : { headers: testCase.headers },
    })
    const { failure } = await collect(provider, request())
    assert.equal(codeOf(failure), testCase.code, `status ${String(testCase.status)}`)
    const facts = factsOf(failure) as { status?: number; providerRetryAfterMs?: number } | undefined
    assert.equal(facts?.status, testCase.status)
    if (testCase.retryAfterMs !== undefined) assert.equal(facts?.providerRetryAfterMs, testCase.retryAfterMs)
  }
})

test('an error delivered inside the stream is classified, not decoded as a delta', async () => {
  const provider = await serve({
    body: 'data: {"error":{"message":"The request was rejected because it exceeded the context window","type":"invalid_request_error"}}\n\n',
  })
  const { chunks, failure } = await collect(provider, request())
  assert.deepEqual(chunks, [])
  assert.equal(codeOf(failure), 'CONTEXT_WINDOW_EXCEEDED')
})

test('caller cancellation aborts the call', async () => {
  const provider = await serve({
    body: 'data: {"choices":[{"index":0,"delta":{"content":"never finishes"},"finish_reason":null}]}\n\n',
  })
  const controller = new AbortController()
  const chunks: StreamChunk[] = []
  let failure: unknown
  try {
    for await (const chunk of streamChatCompletions(request({ signal: controller.signal }), {
      provider: 'stub',
      endpoint: provider.endpoint,
    })) {
      chunks.push(chunk)
      controller.abort()
    }
  } catch (error: unknown) {
    failure = error
  }
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'never finishes' },
  ])
  assert.equal(codeOf(failure), 'ABORTED')
})

test('a non-streaming JSON answer is refused rather than guessed at', async () => {
  const provider = await serve({
    headers: { 'content-type': 'application/json' },
    body: '{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}',
  })
  const { failure } = await collect(provider, request())
  assert.equal(codeOf(failure), 'MALFORMED_RESPONSE')
})

test('a reasoning effort is refused on a route with no field for one', async () => {
  const provider = await serve({ body: 'data: [DONE]\n\n' })
  const { failure } = await collect(provider, request({ reasoningEffort: reasoningEffortId('high') }), {
    supportsReasoningEffort: false,
  })
  assert.equal(codeOf(failure), 'UNSUPPORTED_OPTION')
})

test('the request body carries the harness vocabulary', async () => {
  const provider = await serve({ body: 'data: [DONE]\n\n' })
  await collect(
    provider,
    request({
      system: 'be brief',
      temperature: 0.25,
      stop: ['STOP'],
      reasoningEffort: reasoningEffortId('high'),
      tools: [{ name: 'weather', description: 'look it up', parameters: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'ignored on the wire' },
            { type: 'tool-call', id: toolCallId('call_1'), name: 'weather', arguments: '{"city":"Paris"}' },
          ],
        },
        { role: 'tool', content: [{ type: 'text', text: '18C' }], toolCallId: toolCallId('call_1') },
      ],
    }),
  )
  const sent = JSON.parse(provider.requests[0]?.body ?? '{}') as {
    messages?: readonly unknown[]
    temperature?: number
    stop?: readonly string[]
    reasoning_effort?: string
    tools?: readonly { function?: { name?: string } }[]
  }
  assert.deepEqual(sent.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }],
    },
    { role: 'tool', content: '18C', tool_call_id: 'call_1' },
  ])
  assert.equal(sent.temperature, 0.25)
  assert.deepEqual(sent.stop, ['STOP'])
  assert.equal(sent.reasoning_effort, 'high')
  assert.equal(sent.tools?.[0]?.function?.name, 'weather')
})
