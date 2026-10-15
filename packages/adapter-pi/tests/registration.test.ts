/**
 * Pi's `models.json` → registered harness routes → a real streamed answer, end to end.
 *
 * The package's own sources are imported by name across workspace packages, which resolves
 * to each package's built `lib/` in this repository (nothing under `lib/` is source, and
 * nothing imports these packages at runtime except the bundled plugin). So the test bundles
 * `src/llm.ts` with esbuild — the same tool `scripts/build.mjs` uses — into one module and
 * imports that, which guarantees the assertions run against the sources in the tree.
 *
 * What it proves: only the route `models.json` declares and this bridge can speak is
 * registered; the others are refused with a note; the harness directory lists the same
 * route; `listModels`/`resolveModel` describe what the file declares; and one request
 * travels from the adapter to a stub endpoint and back as the exact `StreamChunk` sequence.
 *
 * ```sh
 * node --test packages/adapter-pi/tests/registration.test.ts
 * ```
 *
 * @module @zorker/muti-agent-adapter-pi/tests/registration
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
interface PiLlmModule {
  registerPiLlm: (ctx: { llm: StubLlm }, options: Record<string, unknown>) => Promise<{
    dispose: () => void
    providers: readonly string[]
    notes: readonly string[]
  }>
  piRouteKey: (providerId: string) => string
}

/** One registration the stub service recorded. */
interface StubLlm {
  registered: { providers: string[]; adapter: PiLlmAdapterFace }[]
  directory: { entries: readonly Record<string, unknown>[]; disposable: boolean }[]
  disposed: number
}

/** The adapter members this test drives; the harness calls exactly these. */
interface PiLlmAdapterFace {
  providerInfo(provider: string): { id: string; name: string }
  providerRetryPolicy(provider: string): unknown
  imageRequestPricing(provider: string, model: string): unknown
  imageRequestTarget(provider: string, model: string, image: { width: number; height: number; bytes: number }): unknown
  listModels(provider: string): Promise<readonly { id: string; name: string; inputModalities?: readonly string[] }[]>
  resolveModel(provider: string, model: string): Promise<Record<string, unknown>>
  prepareCall(provider: string, model: string): Promise<{
    model: Record<string, unknown>
    stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
  }>
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
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
async function loadModule(): Promise<PiLlmModule> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-llm-'))
  scratch.push(dir)
  const outfile = join(dir, 'pi-llm.mjs')
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
  return imported as PiLlmModule
}

/** A stub `llm` service recording what the registration asked for. */
function stubService(): StubLlm {
  const state: StubLlm = { registered: [], directory: [], disposed: 0 }
  return state
}

/** The stub service as the adapter sees it. */
function serviceFor(state: StubLlm): StubLlm & {
  registerAdapter(providers: string[], adapter: PiLlmAdapterFace): () => void
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
      state.directory.push({ entries, disposable: true })
      return () => {
        state.disposed += 1
      }
    },
  }
}

/** Write an agent directory holding one `models.json`. */
async function agentDir(models: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-agent-'))
  scratch.push(dir)
  await writeFile(join(dir, 'models.json'), JSON.stringify(models, null, 2))
  return dir
}

/** Start a stub endpoint answering one scripted SSE body. */
async function serve(body: string): Promise<{ endpoint: string; requests: { headers: IncomingMessage['headers']; body: string; url: string }[] }> {
  const requests: { headers: IncomingMessage['headers']; body: string; url: string }[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of request) parts.push(typeof part === 'string' ? Buffer.from(part) : part)
      requests.push({ headers: request.headers, body: Buffer.concat(parts).toString('utf8'), url: request.url ?? '' })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(body)
    })()
  })
  servers.push(server)
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub endpoint did not bind')
  return { endpoint: `http://127.0.0.1:${String(address.port)}/v1`, requests }
}

/** The `models.json` every case starts from. */
function modelsFile(endpoint: string): unknown {
  return {
    providers: {
      'local-qwen': {
        name: 'Local Qwen',
        baseUrl: endpoint,
        api: 'openai-completions',
        apiKey: '$LOCAL_QWEN_KEY',
        models: [
          {
            id: 'qwen3-local',
            name: 'Qwen Local',
            contextWindow: 6000,
            reasoning: true,
            thinkingLevelMap: { off: null, high: 'high', xhigh: 'xhigh' },
          },
        ],
      },
      'stored-key': {
        baseUrl: endpoint,
        api: 'openai-completions',
        apiKey: 'literal-value',
        headers: { 'x-bf-vk': 'gateway-key' },
        models: [{ id: 'lan-only' }],
      },
      'unset-key': {
        baseUrl: endpoint,
        api: 'openai-completions',
        apiKey: '$NOT_SET_ANYWHERE',
        models: [{ id: 'never-offered' }],
      },
      'command-key': {
        baseUrl: endpoint,
        api: 'openai-completions',
        apiKey: '!op read "op://vault/key"',
        models: [{ id: 'guarded' }],
      },
      'no-api': {
        baseUrl: endpoint,
        apiKey: 'literal',
        models: [{ id: 'unknown-protocol' }],
      },
      'anthropic-shape': {
        baseUrl: 'https://api.example.com',
        api: 'anthropic-messages',
        apiKey: 'literal',
        models: [{ id: 'claude-shaped' }],
      },
    },
  }
}

test('only the declared openai-completions routes are registered, with a note for each refusal', async () => {
  const module = await loadModule()
  const dir = await agentDir(modelsFile('http://127.0.0.1:1/v1'))
  const state = stubService()
  const registration = await module.registerPiLlm(
    { llm: serviceFor(state) },
    { agentDir: dir, env: { LOCAL_QWEN_KEY: 'test-key' }, cwd: dir },
  )

  assert.deepEqual(registration.providers, ['pi:local-qwen', 'pi:stored-key', 'pi:unset-key'])
  assert.equal(state.registered.length, 1)
  assert.deepEqual(state.registered[0]?.providers, ['pi:local-qwen', 'pi:stored-key', 'pi:unset-key'])
  assert.equal(state.directory.length, 1)
  const entries = state.directory[0]?.entries ?? []
  assert.deepEqual(entries.map(entry => entry.provider), ['pi:local-qwen', 'pi:stored-key', 'pi:unset-key'])
  assert.equal(entries[0]?.displayName, 'Pi · local-qwen')
  assert.equal(entries[0]?.declared, true)
  assert.equal(entries[0]?.settingsNs, 'muti-agent')
  assert.equal(entries[0]?.defaultBaseURL, 'http://127.0.0.1:1/v1/chat/completions')
  assert.equal(entries[2]?.error, 'the apiKey resolves from $NOT_SET_ANYWHERE, which is not set in this environment, so this route offers no models until the variable is exported to the harness')

  const noteText = registration.notes.join('\n')
  assert.match(noteText, /command-key: models\.json declares a !command apiKey/)
  assert.match(noteText, /no-api: models\.json declares no api/)
  assert.match(noteText, /anthropic-shape: models\.json declares api "anthropic-messages"/)
  assert.match(noteText, /unset-key: the apiKey references \$NOT_SET_ANYWHERE/)
  // A route whose credential resolves needs no diagnostic of its own.
  assert.doesNotMatch(noteText, /local-qwen:/)
  assert.equal(entries[0]?.error, undefined)

  registration.dispose()
  assert.equal(state.disposed, 2)
})

test('the adapter describes and streams what the file declared', async () => {
  const module = await loadModule()
  const stub = await serve([
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"local "},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ].join(''))
  const dir = await agentDir(modelsFile(stub.endpoint))
  const state = stubService()
  const registration = await module.registerPiLlm(
    { llm: serviceFor(state) },
    { agentDir: dir, env: { LOCAL_QWEN_KEY: 'test-key' }, cwd: dir },
  )
  const adapter = state.registered[0]?.adapter
  assert.ok(adapter !== undefined)

  assert.deepEqual(adapter.providerInfo('pi:local-qwen'), { id: 'pi:local-qwen', name: 'Pi · local-qwen' })
  assert.deepEqual(await adapter.listModels('pi:local-qwen'), [
    { provider: 'pi:local-qwen', id: 'qwen3-local', name: 'Qwen Local', inputModalities: ['text'] },
  ])
  assert.deepEqual(await adapter.listModels('pi:stored-key'), [
    { provider: 'pi:stored-key', id: 'lan-only', name: 'lan-only', inputModalities: ['text'] },
  ])
  // A route whose named variable is unset offers nothing, so nothing can be selected that
  // would fail on use.
  assert.deepEqual(await adapter.listModels('pi:unset-key'), [])

  const resolved = await adapter.resolveModel('pi:local-qwen', 'qwen3-local')
  assert.equal(resolved.provider, 'pi:local-qwen')
  assert.deepEqual(resolved.context, { contextWindow: 6000 })
  assert.deepEqual(resolved.reasoning, {
    efforts: [
      { id: 'minimal', name: 'Minimal' },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'Xhigh' },
    ],
  })
  await assert.rejects(
    () => adapter.resolveModel('pi:local-qwen', 'undeclared-model'),
    (error: unknown) => (error as { code?: string }).code === 'UNKNOWN_MODEL',
  )

  const chunks: Record<string, unknown>[] = []
  for await (const chunk of adapter.stream({
    provider: 'pi:local-qwen',
    model: 'qwen3-local',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'local ' },
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'local answer' } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  const request = stub.requests[0]
  assert.equal(request?.url, '/v1/chat/completions')
  assert.equal(request?.headers.authorization, 'Bearer test-key')
  assert.match(String(request?.headers['user-agent']), /^muti-agent\/\d/)
  const sent = JSON.parse(request?.body ?? '{}') as { model?: string; stream?: boolean }
  assert.equal(sent.model, 'qwen3-local')
  assert.equal(sent.stream, true)

  registration.dispose()
  assert.equal(state.disposed, 2)
})

test('every member the harness calls on a registered adapter exists', async () => {
  const module = await loadModule()
  const stub = await serve('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  const dir = await agentDir(modelsFile(stub.endpoint))
  const state = stubService()
  const registration = await module.registerPiLlm(
    { llm: serviceFor(state) },
    { agentDir: dir, env: { LOCAL_QWEN_KEY: 'test-key' }, cwd: dir },
  )
  const adapter = state.registered[0]?.adapter
  assert.ok(adapter !== undefined)
  assert.equal(adapter.providerRetryPolicy('pi:local-qwen'), undefined)
  assert.equal(adapter.imageRequestPricing('pi:local-qwen', 'qwen3-local'), undefined)
  assert.deepEqual(
    adapter.imageRequestTarget('pi:local-qwen', 'qwen3-local', { width: 10, height: 20, bytes: 30 }),
    { width: 10, height: 20, maxBytes: 30 },
  )

  // `prepareCall` is what `llm.prepareCall()` and the dispatch path use, so its stream entry
  // point has to work exactly like `stream` — a missing member here is a TypeError the
  // harness reports as an adapter failure, not a degraded feature.
  const prepared = await adapter.prepareCall('pi:local-qwen', 'qwen3-local')
  assert.equal(prepared.model.id, 'qwen3-local')
  const chunks: Record<string, unknown>[] = []
  for await (const chunk of prepared.stream({
    provider: 'pi:local-qwen',
    model: 'qwen3-local',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  registration.dispose()
})

test('a declared header credential is sent beside the declared apiKey', async () => {
  const module = await loadModule()
  const stub = await serve('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  const dir = await agentDir(modelsFile(stub.endpoint))
  const state = stubService()
  const registration = await module.registerPiLlm({ llm: serviceFor(state) }, { agentDir: dir, env: {}, cwd: dir })
  const adapter = state.registered[0]?.adapter
  assert.ok(adapter !== undefined)
  for await (const _chunk of adapter.stream({
    provider: 'pi:stored-key',
    model: 'lan-only',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    // The request itself is the assertion; the chunks are covered above.
  }
  assert.equal(stub.requests[0]?.headers.authorization, 'Bearer literal-value')
  assert.equal(stub.requests[0]?.headers['x-bf-vk'], 'gateway-key')
  registration.dispose()
})
