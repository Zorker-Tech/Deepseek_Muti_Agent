/**
 * Codex's configuration → the Responses wire → the exact harness `StreamChunk` sequence.
 *
 * A local HTTP server on loopback speaks the Responses stream this adapter implements: text
 * deltas, a function call whose arguments arrive across three `response.function_call_arguments.delta`
 * events, a `response.completed` carrying usage, and the terminal event. The assertions read the
 * whole sequence member by member, in order.
 *
 * The configuration under test is a real `$CODEX_HOME`: `config.toml` names the default model,
 * its provider, a `model_providers` table with an `env_key` credential, a provider whose variable
 * is unset, and a provider with no `base_url`; `models.json` (named by `model_catalog_json`) adds
 * the context window and reasoning levels a Codex backend would otherwise supply.
 *
 * The package's sources are imported by name across workspace packages, which resolves to each
 * package's built `lib/` (not source), so `src/llm.ts` is bundled with esbuild — the same tool
 * `scripts/build.mjs` uses — and the assertions run against the sources in the tree.
 *
 * Run it with either runner:
 *
 * ```sh
 * node --test packages/adapter-codex/tests/stub-provider.test.ts
 * node packages/adapter-codex/tests/stub-provider.test.ts
 * ```
 *
 * @module @zorker/muti-agent-adapter-codex/tests/stub-provider
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/** Bundled entry module, as this test sees it. */
interface CodexLlmModule {
  registerCodexLlm: (ctx: { llm: StubLlm }, options: Record<string, unknown>) => Promise<{
    dispose: () => void
    providers: readonly string[]
    notes: readonly string[]
  }>
  codexLlmRoute: (providerId: string) => string
}

/** One registration the stub service recorded. */
interface StubLlm {
  registered: { providers: string[]; adapter: CodexLlmAdapterFace }[]
  directory: { entries: readonly Record<string, unknown>[] }[]
  disposed: number
}

/** The adapter members this test drives; the harness calls exactly these. */
interface CodexLlmAdapterFace {
  providerInfo(provider: string): { id: string; name: string }
  providerRetryPolicy(provider: string): unknown
  imageRequestPricing(provider: string, model: string): unknown
  imageRequestTarget(provider: string, model: string, image: { width: number; height: number; bytes: number }): unknown
  listModels(provider: string): Promise<readonly Record<string, unknown>[]>
  resolveModel(provider: string, model: string): Promise<Record<string, unknown>>
  prepareCall(provider: string, model: string): Promise<{
    model: Record<string, unknown>
    stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
  }>
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}

/** One request the stub endpoint received. */
interface RecordedRequest {
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

const scratch: string[] = []
const servers: Server[] = []

after(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => { resolve() })
  })))
  await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** Bundle the adapter's registration module and import it. */
async function loadModule(): Promise<CodexLlmModule> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-llm-'))
  scratch.push(dir)
  const outfile = join(dir, 'codex-llm.mjs')
  const result = await build({
    entryPoints: [new URL('../src/llm.ts', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    external: ['node:*'],
    tsconfig: new URL('../../../tsconfig.base.json', import.meta.url).pathname,
  })
  const output = result.outputFiles?.[0]
  assert.ok(output !== undefined, 'esbuild produced no output')
  await writeFile(outfile, output.text)
  const imported: unknown = await import(pathToFileURL(outfile).href)
  assert.ok(typeof imported === 'object' && imported !== null)
  return imported as CodexLlmModule
}

/** A stub `llm` service recording what the registration asked for. */
function serviceFor(state: StubLlm): StubLlm & {
  registerAdapter(providers: string[], adapter: CodexLlmAdapterFace): () => void
  registerConfigurableProviders(entries: readonly Record<string, unknown>[]): () => void
} {
  return {
    ...state,
    registerAdapter(providers, adapter) {
      state.registered.push({ providers, adapter })
      return () => {
        state.disposed += 1
      }
    },
    registerConfigurableProviders(entries) {
      state.directory.push({ entries })
      return () => {
        state.disposed += 1
      }
    },
  }
}

/** A `$CODEX_HOME` holding the configuration under test. */
async function codexHome(endpoint: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-home-'))
  scratch.push(dir)
  await writeFile(
    join(dir, 'config.toml'),
    [
      'model = "gpt-5-codex"',
      'model_provider = "corp-gateway"',
      'model_reasoning_effort = "high"',
      'model_context_window = 272000',
      'model_catalog_json = "models.json"',
      '',
      '[model_providers.corp-gateway]',
      'name = "Corp Gateway"',
      `base_url = "${endpoint}"`,
      'env_key = "CORP_GATEWAY_KEY"',
      '',
      '[model_providers.unset-key]',
      'name = "Unset Key"',
      `base_url = "${endpoint}"`,
      'env_key = "NOT_SET_ANYWHERE"',
      '',
      '[model_providers.no-endpoint]',
      'name = "No Endpoint"',
      'env_key = "CORP_GATEWAY_KEY"',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(dir, 'models.json'),
    JSON.stringify({
      models: [
        {
          slug: 'gpt-5-codex',
          display_name: 'GPT-5 Codex',
          context_window: 272000,
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
        },
      ],
    }),
  )
  return dir
}

/** Turn scripted Responses events into the SSE bytes the endpoint sends. */
function sse(events: readonly Record<string, unknown>[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

/** Start a stub endpoint answering one scripted SSE body, written in slices. */
async function serve(body: string, sliceBytes = 64): Promise<{ endpoint: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of request) parts.push(typeof part === 'string' ? Buffer.from(part) : part)
      requests.push({
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(parts).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const bytes = Buffer.from(body, 'utf8')
      for (let offset = 0; offset < bytes.length; offset += sliceBytes) {
        response.write(bytes.subarray(offset, Math.min(offset + sliceBytes, bytes.length)))
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
  if (address === null || typeof address === 'string') throw new Error('the stub endpoint did not bind a port')
  return { endpoint: `http://127.0.0.1:${String(address.port)}/v1`, requests }
}

/** Register the adapter over one stub endpoint and hand back what was recorded. */
async function register(
  module: CodexLlmModule,
  endpoint: string,
  env: NodeJS.ProcessEnv = { CORP_GATEWAY_KEY: 'test-key' },
): Promise<{ state: StubLlm; adapter: CodexLlmAdapterFace; registration: Awaited<ReturnType<CodexLlmModule['registerCodexLlm']>>; home: string }> {
  const home = await codexHome(endpoint)
  const state: StubLlm = { registered: [], directory: [], disposed: 0 }
  const registration = await module.registerCodexLlm(
    { llm: serviceFor(state) },
    { homeDir: home, env, cwd: home },
  )
  const adapter = state.registered[0]?.adapter
  assert.ok(adapter !== undefined, 'no adapter was registered')
  return { state, adapter, registration, home }
}

/** Collect the chunks of one call, and the failure when it threw. */
async function collect(
  stream: AsyncIterable<Record<string, unknown>>,
): Promise<{ chunks: Record<string, unknown>[]; failure: unknown }> {
  const chunks: Record<string, unknown>[] = []
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

/** The request every streaming case starts from. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'codex:corp-gateway',
    model: 'gpt-5-codex',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }] }],
    ...overrides,
  }
}

/** The Responses events one complete answer with a tool call consists of. */
function answerEvents(): Record<string, unknown>[] {
  return [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5-codex', status: 'in_progress' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Checking' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: ' the weather.' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Checking the weather.', annotations: [] }],
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        id: 'fc_1',
        type: 'function_call',
        name: 'get_weather',
        arguments: '',
        call_id: 'call_abc',
        status: 'in_progress',
      },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, call_id: 'call_abc', delta: '{"ci' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, call_id: 'call_abc', delta: 'ty":"' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, call_id: 'call_abc', delta: 'Paris"}' },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        id: 'fc_1',
        type: 'function_call',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
        call_id: 'call_abc',
        status: 'completed',
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        end_turn: true,
        usage: {
          input_tokens: 31,
          input_tokens_details: { cached_tokens: 7 },
          output_tokens: 9,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 40,
        },
      },
    },
  ]
}

test('a text block and a tool call split across three chunks yield the exact chunk sequence', async () => {
  const module = await loadModule()
  const stub = await serve(sse(answerEvents()))
  const { adapter, registration, state } = await register(module, stub.endpoint)

  const { chunks, failure } = await collect(adapter.stream(request({
    system: 'be brief',
    reasoningEffort: 'high',
    maxTokens: 128,
    temperature: 0.25,
    sessionId: 'sess-1',
    tools: [{ name: 'get_weather', description: 'look it up', parameters: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', id: 'call_prev', name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: '18C' }], toolCallId: 'call_prev' },
    ],
  })))

  console.log('observed chunk sequence:\n' + JSON.stringify(chunks, null, 2))
  assert.equal(failure, undefined)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Checking' },
    { type: 'text-delta', index: 0, text: ' the weather.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Checking the weather.' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call_abc', name: 'get_weather', argumentsDelta: '{"ci' },
    { type: 'tool-call-delta', index: 1, id: 'call_abc', name: 'get_weather', argumentsDelta: 'ty":"' },
    { type: 'tool-call-delta', index: 1, id: 'call_abc', name: 'get_weather', argumentsDelta: 'Paris"}' },
    {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' },
    },
    { type: 'usage', usage: { inputTokens: 24, outputTokens: 9, totalTokens: 40, cacheReadTokens: 7, reasoningTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])

  const sent = JSON.parse(stub.requests[0]?.body ?? '{}') as Record<string, unknown>
  assert.equal(stub.requests[0]?.url, '/v1/responses')
  assert.equal(stub.requests[0]?.headers.authorization, 'Bearer test-key')
  assert.match(String(stub.requests[0]?.headers['user-agent']), /^muti-agent\/\d/u)
  assert.equal(sent.model, 'gpt-5-codex')
  assert.equal(sent.stream, true)
  assert.equal(sent.store, false)
  assert.equal(sent.tool_choice, 'auto')
  assert.equal(sent.parallel_tool_calls, true)
  // The current Codex client carries base instructions as input items, not as this
  // request-level field, so nothing here may send one.
  assert.equal(sent.instructions, undefined)
  assert.equal(sent.prompt_cache_key, 'sess-1')
  assert.equal(sent.max_output_tokens, 128)
  assert.equal(sent.temperature, 0.25)
  assert.deepEqual(sent.reasoning, { effort: 'high' })
  assert.deepEqual(sent.tools, [
    { type: 'function', name: 'get_weather', description: 'look it up', strict: false, parameters: { type: 'object', properties: {} } },
  ])
  assert.deepEqual(sent.input, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'be brief' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather in Paris?' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'let me check' }] },
    { type: 'function_call', name: 'get_weather', arguments: '{"city":"Paris"}', call_id: 'call_prev' },
    { type: 'function_call_output', call_id: 'call_prev', output: '18C' },
  ])

  registration.dispose()
  // One disposal per registration: the adapter route and the directory entry.
  assert.equal(state.disposed, 2)
})

test('the routes offered are exactly the configuration that can run', async () => {
  const module = await loadModule()
  const stub = await serve(sse(answerEvents()))
  const { adapter, registration, state } = await register(module, stub.endpoint)

  assert.deepEqual(registration.providers, ['codex:corp-gateway', 'codex:unset-key'])
  assert.equal(module.codexLlmRoute('corp-gateway'), 'codex:corp-gateway')
  assert.deepEqual(adapter.providerInfo('codex:corp-gateway'), { id: 'codex:corp-gateway', name: 'Codex · Corp Gateway' })

  // The descriptor says what Codex names and nothing more: the id, the name the local
  // catalog gives it, its context window, and the reasoning levels it declares.
  assert.deepEqual(await adapter.listModels('codex:corp-gateway'), [
    {
      provider: 'codex:corp-gateway',
      id: 'gpt-5-codex',
      name: 'GPT-5 Codex',
      description: 'the model this configuration selects by default',
      inputModalities: ['text'],
    },
  ])
  const resolved = await adapter.resolveModel('codex:corp-gateway', 'gpt-5-codex')
  assert.deepEqual(resolved.context, { contextWindow: 272000 })
  assert.deepEqual(resolved.reasoning, {
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'high',
  })
  // An id the configuration never names is described, not refused: the provider decides
  // which ids exist, exactly as Codex does.
  assert.equal((await adapter.resolveModel('codex:corp-gateway', 'some-future-model')).id, 'some-future-model')

  // A route whose named variable is unset cannot serve a request, so it offers nothing
  // until the environment provides it, and the directory entry says why.
  assert.deepEqual(await adapter.listModels('codex:unset-key'), [])
  const entries = state.directory[0]?.entries ?? []
  assert.deepEqual(entries.map(entry => entry['provider']), ['codex:corp-gateway', 'codex:unset-key'])
  assert.equal(entries[0]?.['declared'], true)
  assert.equal(entries[0]?.['defaultBaseURL'], stub.endpoint)
  assert.deepEqual(entries[0]?.['nativeAuth'], { env: ['CORP_GATEWAY_KEY'], oauth: false })
  assert.equal(entries[0]?.['error'], undefined)
  assert.match(String(entries[1]?.['error']), /resolves its credential from NOT_SET_ANYWHERE/u)

  const noteText = registration.notes.join('\n')
  assert.match(noteText, /\[model_providers\.no-endpoint\] names no base_url/u)
  assert.match(noteText, /unset-key: \[model_providers\.unset-key\] resolves its credential from NOT_SET_ANYWHERE/u)
  // The route that can run carries no diagnostic of its own.
  assert.doesNotMatch(noteText, /corp-gateway:/u)

  const blocked = await collect(adapter.stream({
    provider: 'codex:unset-key',
    model: 'gpt-5-codex',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.deepEqual(blocked.chunks, [])
  assert.equal(codeOf(blocked.failure), 'MISSING_CREDENTIAL')
  assert.equal(stub.requests.length, 0)

  registration.dispose()
})

test('a stream that never reaches its terminal event fails, and an in-band failure is classified', async () => {
  const module = await loadModule()
  const cut = await serve(sse(answerEvents().slice(0, 4)))
  const first = await register(module, cut.endpoint)
  const { chunks, failure } = await collect(first.adapter.stream(request()))
  assert.deepEqual(chunks.map(chunk => chunk['type']), ['block-start', 'text-delta', 'text-delta'])
  assert.equal(codeOf(failure), 'STREAM_CLOSED')
  first.registration.dispose()

  const failed = await serve(sse([
    { type: 'response.created', response: { id: 'resp_2', status: 'in_progress' } },
    {
      type: 'response.failed',
      response: {
        id: 'resp_2',
        status: 'failed',
        error: {
          code: 'context_length_exceeded',
          message: "This model's maximum context length is 272000 tokens",
          type: 'invalid_request_error',
        },
      },
    },
  ]))
  const second = await register(module, failed.endpoint)
  const result = await collect(second.adapter.stream(request()))
  assert.deepEqual(result.chunks, [])
  assert.equal(codeOf(result.failure), 'CONTEXT_WINDOW_EXCEEDED')
  second.registration.dispose()
})

test('the request options this wire cannot express are refused, not dropped', async () => {
  const module = await loadModule()
  const stub = await serve(sse(answerEvents()))
  const { adapter, registration } = await register(module, stub.endpoint)
  const { failure } = await collect(adapter.stream(request({ stop: ['STOP'] })))
  assert.equal(codeOf(failure), 'UNSUPPORTED_OPTION')
  assert.equal(stub.requests.length, 0)
  registration.dispose()
})
