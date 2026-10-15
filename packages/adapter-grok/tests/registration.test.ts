/**
 * Grok Build's configuration → the registered CLI chat proxy route → a streamed answer.
 *
 * Like the Pi adapter's registration test, the sources are bundled with esbuild (the tool
 * `scripts/build.mjs` uses) because the package's by-name imports resolve to each package's
 * built `lib/` in this repository, and nothing under `lib/` is source.
 *
 * What it proves: the model list is the `allowed_models`/default the configuration names and
 * nothing else; a configuration that names none registers the route with no models and says
 * the endpoint is authoritative; the proxy bearer comes from the environment or the stored
 * sign-in; and one request reaches the endpoint with the proxy's routing headers and comes
 * back as the exact `StreamChunk` sequence.
 *
 * ```sh
 * node --test packages/adapter-grok/tests/registration.test.ts
 * ```
 *
 * @module @zorker/muti-agent-adapter-grok/tests/registration
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/** The adapter members this test drives; the harness calls exactly these. */
interface GrokLlmAdapterFace {
  providerInfo(provider: string): { id: string; name: string }
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  resolveModel(provider: string, model: string): Promise<Record<string, unknown>>
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}

/** Bundled entry module, as this test sees it. */
interface GrokLlmModule {
  registerGrokLlm: (ctx: { llm: StubLlm }, options: Record<string, unknown>) => Promise<{
    dispose: () => void
    providers: readonly string[]
    notes: readonly string[]
  }>
}

/** One registration the stub service recorded. */
interface StubLlm {
  registered: { providers: string[]; adapter: GrokLlmAdapterFace }[]
  directory: { entries: readonly Record<string, unknown>[] }[]
  disposed: number
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
async function loadModule(): Promise<GrokLlmModule> {
  const dir = await mkdtemp(join(tmpdir(), 'grok-llm-'))
  scratch.push(dir)
  const outfile = join(dir, 'grok-llm.mjs')
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
  return imported as GrokLlmModule
}

/** A stub `llm` service recording what the registration asked for. */
function serviceFor(state: StubLlm): StubLlm & {
  registerAdapter(providers: string[], adapter: GrokLlmAdapterFace): () => void
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

/** A stub `llm` service that records nothing. */
function emptyService(): StubLlm {
  return { registered: [], directory: [], disposed: 0 }
}

/** Write a grok home holding one `config.toml`, and return it. */
async function grokHome(config: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grok-home-'))
  scratch.push(dir)
  await mkdir(join(dir, 'sessions'), { recursive: true })
  await writeFile(join(dir, 'config.toml'), config)
  return dir
}

/** Start a stub endpoint answering one scripted SSE body and recording the requests. */
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

test('the model list is what the configuration names, and a glob is refused rather than guessed', async () => {
  const module = await loadModule()
  const home = await grokHome([
    '[models]',
    'default = "grok-build"',
    'allowed_models = ["grok-build", "grok-4*"]',
    '',
    '[model.grok-build]',
    'context_window = 131072',
    'reasoning_efforts = ["low", "high"]',
    '',
  ].join('\n'))
  const state = emptyService()
  const registration = await module.registerGrokLlm(
    { llm: serviceFor(state) },
    { env: { HOME: home, XAI_API_KEY: 'xai-test' }, homeDir: home, cwd: home },
  )

  assert.deepEqual(registration.providers, ['grok:cli-chat-proxy'])
  const entry = state.directory[0]?.entries[0]
  assert.equal(entry?.provider, 'grok:cli-chat-proxy')
  assert.equal(entry?.displayName, 'Grok Build')
  assert.equal(entry?.declared, true)
  assert.equal(entry?.defaultBaseURL, 'https://cli-chat-proxy.grok.com/v1/chat/completions')
  assert.deepEqual(entry?.baseURLEnv, ['GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_XAI_API_BASE_URL'])
  assert.deepEqual(entry?.nativeAuth, { env: ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'], oauth: true })
  assert.equal(entry?.error, undefined)

  const adapter = state.registered[0]?.adapter
  assert.ok(adapter !== undefined)
  assert.deepEqual(await adapter.listModels('grok:cli-chat-proxy'), [
    { provider: 'grok:cli-chat-proxy', id: 'grok-build', name: 'grok-build', inputModalities: ['text'] },
  ])
  const resolved = await adapter.resolveModel('grok:cli-chat-proxy', 'grok-build')
  assert.deepEqual(resolved.context, { contextWindow: 131072 })
  assert.deepEqual(resolved.reasoning, {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
  })
  assert.match(registration.notes.join('\n'), /allowed_models contains picker globs \(grok-4\*\)/)
  registration.dispose()
  assert.equal(state.disposed, 2)
})

test('a configuration naming no model registers the route with no models and says so', async () => {
  const module = await loadModule()
  const home = await grokHome('[cli]\ninstaller = "internal"\n')
  const state = emptyService()
  const registration = await module.registerGrokLlm(
    { llm: serviceFor(state) },
    { env: { HOME: home, XAI_API_KEY: 'xai-test' }, homeDir: home, cwd: home },
  )
  assert.deepEqual(registration.providers, ['grok:cli-chat-proxy'])
  assert.deepEqual(await state.registered[0]?.adapter.listModels('grok:cli-chat-proxy'), [])
  assert.match(
    registration.notes.join('\n'),
    /configuration names no model, so this route offers none: the endpoint is authoritative and this plugin makes no discovery request/,
  )
  registration.dispose()
})

test('the proxy bearer comes from the environment, else the stored sign-in, else nothing', async () => {
  const module = await loadModule()
  const home = await grokHome('')
  const state = emptyService()

  // Nothing stored and nothing exported: the route is still registered, with the reason.
  const registration = await module.registerGrokLlm(
    { llm: serviceFor(state) },
    { env: { HOME: home }, homeDir: home, cwd: home },
  )
  assert.match(registration.notes.join('\n'), /no credential resolves for this route/)
  assert.match(String(state.directory[0]?.entries[0]?.error), /no credential: set XAI_API_KEY/)
  await assert.rejects(
    async () => {
      for await (const _chunk of state.registered[0]?.adapter.stream({
        provider: 'grok:cli-chat-proxy',
        model: 'grok-build',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }) ?? []) {
        // Nothing is yielded before the credential is resolved.
      }
    },
    (error: unknown) => (error as { code?: string }).code === 'MISSING_CREDENTIAL',
  )
  registration.dispose()

  // A stored `grok login` token authenticates when no variable is exported.
  const stub = await serve('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  await writeFile(
    join(home, 'auth.json'),
    JSON.stringify({ 'https://accounts.x.ai/sign-in': { auth_mode: 'web_login', key: 'session-token' } }),
  )
  const stored = emptyService()
  const storedRegistration = await module.registerGrokLlm(
    { llm: serviceFor(stored) },
    { env: { HOME: home, GROK_CLI_CHAT_PROXY_BASE_URL: stub.endpoint }, homeDir: home, cwd: home },
  )
  assert.equal(stored.directory[0]?.entries[0]?.error, undefined)
  const storedAdapter = stored.registered[0]?.adapter
  assert.ok(storedAdapter !== undefined)
  for await (const _chunk of storedAdapter.stream({
    provider: 'grok:cli-chat-proxy',
    model: 'grok-build',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    // The request header is the assertion; the chunk mapping is covered elsewhere.
  }
  assert.equal(stub.requests[0]?.headers.authorization, 'Bearer session-token')
  storedRegistration.dispose()
})

test('the endpoint override is honoured and the request carries the proxy headers', async () => {
  const module = await loadModule()
  const stub = await serve([
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"weighing"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
    'data: [DONE]\n\n',
  ].join(''))
  const home = await grokHome('[models]\ndefault = "grok-build"\n')
  const state = emptyService()
  const registration = await module.registerGrokLlm(
    { llm: serviceFor(state) },
    {
      env: { HOME: home, XAI_API_KEY: 'xai-test', GROK_CLI_CHAT_PROXY_BASE_URL: stub.endpoint },
      homeDir: home,
      cwd: home,
    },
  )
  assert.equal(state.directory[0]?.entries[0]?.defaultBaseURL, `${stub.endpoint}/chat/completions`)

  const adapter = state.registered[0]?.adapter
  assert.ok(adapter !== undefined)
  const chunks: Record<string, unknown>[] = []
  for await (const chunk of adapter.stream({
    provider: 'grok:cli-chat-proxy',
    model: 'grok-build',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'weighing' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'done' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  const request = stub.requests[0]
  assert.equal(request?.url, '/v1/chat/completions')
  assert.equal(request?.headers.authorization, 'Bearer xai-test')
  assert.equal(request?.headers['x-xai-token-auth'], 'xai-grok-cli')
  assert.equal(request?.headers['x-grok-model-override'], 'grok-build')
  assert.match(String(request?.headers['user-agent']), /^muti-agent\/\d/)
  registration.dispose()
})
