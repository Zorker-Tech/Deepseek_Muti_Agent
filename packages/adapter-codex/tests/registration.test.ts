/**
 * Codex's configuration registered on the REAL DeepSeek Harness `LlmRuntime`.
 *
 * The sibling registration tests drive a stub `llm` service, which proves what this adapter
 * asks for but not that the harness accepts it. This test mounts the harness's own
 * `LlmRuntime` on a bare `Context` and drives it exactly as a host would: register, read the
 * provider directory, list and resolve models, prepare a call, stream it to a loopback stub
 * endpoint, and dispose — then assert both registries are empty again.
 *
 * The harness is an external read-only checkout, so it is imported by absolute path from its
 * built `lib/` (the package ships compiled JavaScript; nothing under its `src/` is source for
 * a consumer). `Context` comes from the same checkout's linked `@deepseek-ai/cordis`, which is
 * the copy the runtime itself was built against — importing a second copy could compare two
 * sets of module identities.
 *
 * The adapter sources are bundled with esbuild for the same reason as the sibling tests: the
 * package's by-name imports resolve to built `lib/` directories, which are not source.
 *
 * Run it with either runner:
 *
 * ```sh
 * node --test packages/adapter-codex/tests/registration.test.ts
 * node packages/adapter-codex/tests/registration.test.ts
 * ```
 *
 * @module @zorker/muti-agent-adapter-codex/tests/registration
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

/** The harness checkout this test verifies against; read-only. */
const HARNESS_LLM_DIR = '/Volumes/Net/deepseek-harness/packages/llm/llm'

/** Bundled entry module, as this test sees it. */
interface CodexLlmModule {
  registerCodexLlm: (ctx: { llm: LlmRuntimeFace }, options: Record<string, unknown>) => Promise<{
    dispose: () => void
    providers: readonly string[]
    notes: readonly string[]
  }>
}

/** The `LlmRuntime` surface this test drives. */
interface LlmRuntimeFace {
  listProviders(): { id: string; name: string }[]
  listConfigurableProviders(): readonly Record<string, unknown>[]
  listModels(provider: string): Promise<readonly Record<string, unknown>[]>
  resolveModelInfo(provider: string, model: string): Promise<Record<string, unknown>>
  prepareCall(config: Record<string, unknown>): Promise<PreparedCallFace>
  registerAdapter(providers: string[], adapter: unknown): () => void
}

/** One prepared call, as `llm.prepareCall()` returns it. */
interface PreparedCallFace {
  readonly config: Record<string, unknown>
  readonly adapterDefaults: Record<string, unknown>
  readonly model: Record<string, unknown>
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}

/** The harness module this test imports. */
interface HarnessModule {
  LlmRuntime: new (ctx: unknown) => LlmRuntimeFace
}

/** The cordis `Context` the runtime is mounted on. */
interface CordisModule {
  Context: new () => unknown
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

/** Load the real harness runtime and the cordis copy it was built against. */
async function loadHarness(): Promise<{ harness: HarnessModule; cordis: CordisModule }> {
  const harness = await import(pathToFileURL(join(HARNESS_LLM_DIR, 'lib/index.js')).href) as unknown
  const cordis = await import(
    pathToFileURL(join(HARNESS_LLM_DIR, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href
  ) as unknown
  assert.ok(isRecord(harness) && typeof harness['LlmRuntime'] === 'function', 'the harness exposes no LlmRuntime')
  assert.ok(isRecord(cordis) && typeof cordis['Context'] === 'function', 'cordis exposes no Context')
  return { harness: harness as unknown as HarnessModule, cordis: cordis as unknown as CordisModule }
}

/** Bundle the adapter's registration module and import it. */
async function loadModule(): Promise<CodexLlmModule> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-registration-'))
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
  assert.ok(isRecord(imported))
  return imported as unknown as CodexLlmModule
}

/** Whether one unknown value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
async function serve(body: string): Promise<{ endpoint: string; requests: RecordedRequest[] }> {
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
      for (let offset = 0; offset < bytes.length; offset += 64) {
        response.write(bytes.subarray(offset, Math.min(offset + 64, bytes.length)))
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

test('the real harness registry accepts the Codex routes and streams through them', async () => {
  const { harness, cordis } = await loadHarness()
  const module = await loadModule()
  const stub = await serve(sse(answerEvents()))
  const home = await codexHome(stub.endpoint)
  const env = { CORP_GATEWAY_KEY: 'test-key' }
  const llm = new harness.LlmRuntime(new cordis.Context())

  const registration = await module.registerCodexLlm(
    { llm },
    { homeDir: home, env, cwd: home },
  )
  assert.deepEqual(registration.providers, ['codex:corp-gateway', 'codex:unset-key'])
  assert.equal(registration.dispose instanceof Function, true)

  // The registered routes are exactly the prefixed ones this adapter owns.
  assert.deepEqual(llm.listProviders(), [
    { id: 'codex:corp-gateway', name: 'Codex · Corp Gateway' },
    { id: 'codex:unset-key', name: 'Codex · Unset Key' },
  ])

  // The configurable-provider directory carries the same routes with their endpoint, the
  // variable their credential resolves from, and the reason one of them cannot run.
  const directory = llm.listConfigurableProviders()
  assert.deepEqual(directory.map(entry => entry['provider']), ['codex:corp-gateway', 'codex:unset-key'])
  assert.deepEqual(directory[0], {
    provider: 'codex:corp-gateway',
    displayName: 'Codex · Corp Gateway',
    settingsNs: 'muti-agent',
    settingsPath: ['model_providers', 'corp-gateway'],
    declared: true,
    defaultBaseURL: stub.endpoint,
    nativeAuth: { env: ['CORP_GATEWAY_KEY'], oauth: false },
  })
  assert.match(String(directory[1]?.['error']), /NOT_SET_ANYWHERE/u)

  // What the selector shows: exactly the models the configuration names, with the
  // capabilities the same read knows.
  assert.deepEqual(await llm.listModels('codex:corp-gateway'), [
    {
      provider: 'codex:corp-gateway',
      id: 'gpt-5-codex',
      name: 'GPT-5 Codex',
      description: 'the model this configuration selects by default',
      inputModalities: ['text'],
    },
  ])
  assert.deepEqual(await llm.listModels('codex:unset-key'), [])
  assert.deepEqual(await llm.resolveModelInfo('codex:corp-gateway', 'gpt-5-codex'), {
    provider: 'codex:corp-gateway',
    id: 'gpt-5-codex',
    name: 'GPT-5 Codex',
    description: 'the model this configuration selects by default',
    inputModalities: ['text'],
    context: { contextWindow: 272000 },
    systemPromptUpdate: 'in-history',
    reasoning: {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'high',
    },
  })

  // A prepared call materializes the configuration's own reasoning default, so the
  // dispatched request carries the effort the configuration selected.
  const prepared = await llm.prepareCall({ provider: 'codex:corp-gateway', model: 'gpt-5-codex' })
  assert.equal(prepared.config['provider'], 'codex:corp-gateway')
  assert.equal(prepared.config['model'], 'gpt-5-codex')
  assert.equal(prepared.config['reasoningEffort'], 'high')
  assert.deepEqual(prepared.adapterDefaults, { reasoningEffort: true })

  const chunks: Record<string, unknown>[] = []
  for await (const chunk of prepared.stream({
    provider: 'codex:corp-gateway',
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }] }],
  })) {
    chunks.push(chunk)
  }
  console.log('chunks through the real harness:\n' + JSON.stringify(chunks, null, 2))
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
  assert.deepEqual(sent.reasoning, { effort: 'high' })
  assert.equal(sent.model, 'gpt-5-codex')

  // Disposing the registration empties both registries.
  registration.dispose()
  assert.deepEqual(llm.listProviders(), [])
  assert.deepEqual(llm.listConfigurableProviders(), [])
})
