/**
 * Smoke-verify the built plugin bundle without a harness.
 *
 * Loads `packages/plugin/lib/index.js` against a stub Cordis context that records what
 * the plugin registers, then exercises the three surfaces end to end: an HTTP method
 * call through a captured route, an MCP session in-process, and the native tool
 * definitions. This is the check that catches "it typechecked but the registration
 * throws" before a full harness boot.
 *
 * @module scripts/verify-plugin
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pluginEntry = new URL('../packages/plugin/lib/index.js', import.meta.url).href

const failures = []
const notes = []

/**
 * Assert a condition, recording a failure instead of throwing so one bad check does not
 * hide the others.
 *
 * @param {boolean} condition - What must hold.
 * @param {string} label - What was being checked.
 * @param {unknown} [detail] - Extra context for a failure.
 */
function check(condition, label, detail) {
  if (condition) return
  failures.push(detail === undefined ? label : `${label} — ${String(detail)}`)
}

/** Build a stub context that records registrations and answers `get(name)`. */
function makeContext() {
  const state = {
    tools: [],
    commands: [],
    routes: [],
    provided: new Map(),
    effects: 0,
    logLines: [],
  }
  const services = {
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        state.commands.push(definition)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          state.routes.push(route)
          return () => {}
        },
      },
    },
  }
  const ctx = {
    get: name => services[name] ?? undefined,
    provide: (name, value) => { state.provided.set(name, value) },
    on: () => () => {},
    effect(callback) {
      state.effects += 1
      return callback()
    },
    logger: {
      debug: line => { state.logLines.push(`debug ${line}`) },
      info: line => { state.logLines.push(`info ${line}`) },
      warn: line => { state.logLines.push(`warn ${line}`) },
      error: line => { state.logLines.push(`error ${line}`) },
    },
  }
  return { ctx, state }
}

/** Invoke one method through the captured RPC route. */
async function rpc(route, method, params, confirm) {
  const body = JSON.stringify(confirm === undefined ? { method, params } : { method, params, confirm })
  const response = await route.fetch(
    new Request('http://127.0.0.1/api/mutiagent/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  )
  return { status: response.status, body: await response.json() }
}

const workdir = await mkdtemp(join(tmpdir(), 'muti-verify-'))
const stateDir = join(workdir, 'state')

const plugin = await import(pluginEntry)
check(typeof plugin.apply === 'function', 'the bundle exports apply()')
check(plugin.name === 'muti-agent', 'the bundle declares its plugin name', plugin.name)

const { ctx, state } = makeContext()
const dispose = await plugin.apply(ctx, {
  stateDir,
  log: { level: 'warn' },
  worktree: { sampleIntervalMs: 0 },
  sessions: { warmScanDelayMs: 0 },
})

check(dispose !== undefined, 'apply() returned a disposer')
check(state.tools.length > 0, 'native tools were registered')
check(state.commands.length > 0, 'slash commands were registered')
check(state.routes.length === 3, 'the three gateway routes were registered', state.routes.map(r => r.path).join(','))
check(state.provided.has('mutiAgent'), 'the service was published on the context')

const expectedPaths = ['/api/mutiagent/rpc', '/api/mutiagent/events', '/api/mutiagent/mcp']
for (const path of expectedPaths) {
  const route = state.routes.find(candidate => candidate.path === path)
  check(route !== undefined, `route ${path} is registered`)
  // The harness strips `/api` and requires every remaining segment to match this
  // pattern; a bare `/mutiagent/...` is rejected at activation.
  const segments = path.startsWith('/api/') ? path.slice('/api/'.length).split('/') : []
  check(
    segments.length > 0 && segments.every(segment => /^[A-Za-z0-9_$.-]+$/.test(segment)),
    `route ${path} is a valid harness endpoint path`,
  )
  if (route !== undefined) {
    check(route.methods.length > 0, `route ${path} declares methods`)
    check(typeof route.fetch === 'function', `route ${path} has a fetch handler`)
  }
}

// Every operation id must survive the transport, and every mutating one must be gated.
const rpcRoute = state.routes.find(route => route.path === '/api/mutiagent/rpc')
if (rpcRoute !== undefined) {
  const methods = await rpc(rpcRoute, 'mutiagent.methods', {})
  check(methods.status === 200, 'mutiagent.methods answered 200', methods.status)
  check(methods.body?.ok === true, 'mutiagent.methods succeeded', JSON.stringify(methods.body)?.slice(0, 300))
  const catalog = methods.body?.result?.methods ?? []
  check(catalog.length > 20, 'the catalog lists the declared methods', catalog.length)
  notes.push(`methods: ${catalog.length}`)

  const diagnostics = await rpc(rpcRoute, 'agents.diagnostics', {})
  check(diagnostics.body?.ok === true, 'agents.diagnostics succeeded', JSON.stringify(diagnostics.body)?.slice(0, 300))
  const agentRows = diagnostics.body?.result?.agents ?? []
  check(agentRows.length === 3, 'three agents are described', agentRows.map(row => row.agentId).join(','))
  const isolated = diagnostics.body?.result?.isolation
  check(isolated === 'worktree', 'isolation is reported as enabled', isolated)
  for (const row of agentRows) {
    notes.push(`${row.agentId}: installed=${String(row.installed)} ${row.version ?? ''}`.trim())
  }

  const agents = await rpc(rpcRoute, 'agents.list', {})
  check(agents.body?.ok === true, 'agents.list succeeded')
  const capabilities = agents.body?.result?.agents?.[0]?.descriptor?.capabilities
  check(
    capabilities !== undefined && Array.isArray(capabilities.runModes) && capabilities.runModes.length > 0,
    'each agent declares runModes',
  )
  check(
    capabilities !== undefined && typeof capabilities.credentials === 'object',
    'each agent declares a credential surface',
  )

  const refresh = await rpc(rpcRoute, 'sessions.refresh', {})
  check(refresh.body?.ok === true, 'sessions.refresh succeeded', JSON.stringify(refresh.body)?.slice(0, 300))
  const outcomes = refresh.body?.result?.outcomes ?? []
  check(outcomes.length === 3, 'every agent was scanned', outcomes.length)
  notes.push(`scan: ${outcomes.map(o => `${o.agentId}=${o.ok ? String(o.found) : 'failed'}`).join(' ')}`)

  // A row limit must not change any partition's counts, only how many rows it shows.
  const narrow = await rpc(rpcRoute, 'sessions.partitions', { includeUntracked: true, limit: 1 })
  const wide = await rpc(rpcRoute, 'sessions.partitions', { includeUntracked: true, limit: 500 })
  const countsOf = body =>
    (body?.result?.partitions ?? []).map(partition => `${partition.agentId}=${String(partition.untrackedCount)}`).join(',')
  check(
    countsOf(narrow) === countsOf(wide),
    'a partition row limit does not change the counts it reports',
    `${countsOf(narrow)} vs ${countsOf(wide)}`,
  )

  const partitions = await rpc(rpcRoute, 'sessions.partitions', { limit: 5 })
  check(partitions.body?.ok === true, 'sessions.partitions succeeded', JSON.stringify(partitions.body)?.slice(0, 300))
  const buckets = partitions.body?.result?.partitions ?? []
  check(buckets.length === 3, 'one partition per agent', buckets.map(b => b.agentId).join(','))
  const withNames = buckets.filter(bucket => typeof bucket.displayName === 'string' && bucket.displayName !== '')
  check(withNames.length === 3, 'every partition carries a display name')

  const credentials = await rpc(rpcRoute, 'credentials.list', {})
  check(credentials.body?.ok === true, 'credentials.list succeeded', JSON.stringify(credentials.body)?.slice(0, 300))
  const rows = credentials.body?.result?.credentials ?? []
  check(rows.length === 3, 'a credential row per agent', rows.length)
  for (const row of rows) {
    check(typeof row.state?.status === 'string', `${row.agentId} reports a status`)
    check(row.state?.agentId !== undefined, `${row.agentId} credential row is canonical`)
    notes.push(
      `${row.agentId}: ${row.state.status} via ${row.state.source} manageable=${String(row.manageable)}`,
    )
  }

  const bad = await rpc(rpcRoute, 'sessions.list', { sort: 'nonsense' })
  check(bad.body?.ok === false, 'an invalid parameter is rejected', JSON.stringify(bad.body)?.slice(0, 200))
  check(bad.body?.error?.code === 'wire/bad-params', 'the rejection carries the schema code', bad.body?.error?.code)

  const unknown = await rpc(rpcRoute, 'does.not.exist', {})
  check(unknown.body?.ok === false, 'an unknown method is rejected')
  check(unknown.body?.error?.code === 'wire/unknown-method', 'the rejection names the method error')

  // The browser is a trusted caller (the harness already proved the user owns this
  // Host, and the GUI confirms before every irreversible action), so it reaches the
  // operation and fails on the missing worktree rather than on the confirmation gate.
  const trusted = await rpc(rpcRoute, 'worktrees.remove', { worktreeId: 'wt-does-not-exist' })
  check(
    trusted.body?.error?.code === 'worktree/not-found',
    'a trusted caller reaches the operation and fails on its own terms',
    JSON.stringify(trusted.body)?.slice(0, 200),
  )
}

// MCP surface: run a full handshake and one tool call through the MCP route.
const mcpRoute = state.routes.find(route => route.path === '/api/mutiagent/mcp')
if (mcpRoute !== undefined) {
  const call = async payload => {
    const response = await mcpRoute.fetch(
      new Request('http://127.0.0.1/api/mutiagent/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
    const text = await response.text()
    return text === '' ? { status: response.status } : { status: response.status, body: JSON.parse(text) }
  }
  const initialize = await call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'verify-plugin', version: '1' } },
  })
  check(initialize.body?.result?.serverInfo?.name === 'mutiagent', 'MCP initialize answers with the server name')
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const tools = list.body?.result?.tools ?? []
  check(tools.length > 10, 'MCP tools/list returns the catalog', tools.length)
  const names = new Set(tools.map(tool => tool.name))
  check(names.has('mutiagent_agents_diagnostics'), 'the diagnostics tool is exposed over MCP', [...names].slice(0, 3).join(','))
  check(names.has('mutiagent_runs_start'), 'the dispatch tool is exposed over MCP')
  for (const tool of tools) {
    check(typeof tool.inputSchema === 'object', `tool ${tool.name} declares an input schema`)
  }
  const called = await call({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'mutiagent_agents_diagnostics', arguments: {} },
  })
  check(called.body?.result?.isError === false, 'an MCP tool call succeeds')
  // A dangerous operation reached by an untrusted MCP client must challenge, not act.
  const gated = await call({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'mutiagent_credentials_logout', arguments: { agentId: 'codex' } },
  })
  const gatedText = gated.body?.result?.content?.[0]?.text ?? ''
  check(
    gatedText.includes('confirmationRequired') || gatedText.includes('confirmation'),
    'an untrusted MCP client gets a confirmation challenge instead of a logout',
    gatedText.slice(0, 160),
  )
}

/**
 * Mirror the harness's tool-schema subset (`packages/core/tools/src/json-schema.ts`):
 * a closed keyword set, a closed type set, and a **boolean** `additionalProperties`.
 * Checked here because a schema the harness refuses fails activation *after* install,
 * which is the most expensive place to find out.
 *
 * @param schema - A JSON Schema node.
 * @param path - Where it sits, for the failure message.
 * @param problems - Collector.
 */
function auditSchema(schema, path, problems) {
  if (typeof schema !== 'object' || schema === null) {
    problems.push(`${path}: not a schema object`)
    return
  }
  const allowedKeywords = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description'])
  for (const key of Object.keys(schema)) {
    if (!allowedKeywords.has(key)) problems.push(`${path}.${key} is outside the harness's supported subset`)
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((branch, index) => auditSchema(branch, `${path}.oneOf[${index}]`, problems))
  }
  const allowedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  if (schema.type !== undefined && !allowedTypes.has(schema.type)) {
    problems.push(`${path}.type is unsupported: ${JSON.stringify(schema.type)}`)
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    problems.push(`${path}.additionalProperties must be a boolean`)
  }
  if (schema.type === 'object' && !Object.hasOwn(schema, 'additionalProperties')) {
    problems.push(`${path}: object schemas must declare additionalProperties`)
  }
  if (typeof schema.properties === 'object' && schema.properties !== null) {
    for (const [key, child] of Object.entries(schema.properties)) auditSchema(child, `${path}.${key}`, problems)
  }
  if (typeof schema.items === 'object' && schema.items !== null) auditSchema(schema.items, `${path}[]`, problems)
}

// Every registered tool must carry the members the harness's registry requires, and its
// schemas must satisfy the harness's structural rules.
for (const tool of state.tools) {
  check(typeof tool.name === 'string' && tool.name.startsWith('mutiagent_'), `tool ${String(tool.name)} is namespaced`)
  check(typeof tool.description === 'string' && tool.description.length > 10, `tool ${tool.name} has a description`)
  check(typeof tool.parameters === 'object' && tool.parameters !== null, `tool ${tool.name} has a parameter schema`)
  check(typeof tool.output?.render === 'function', `tool ${tool.name} declares a render function`)
  check(tool.output?.schema !== undefined, `tool ${tool.name} declares an output schema`)
  check(typeof tool.execute === 'function', `tool ${tool.name} has an execute function`)
  const problems = []
  auditSchema(tool.parameters, `${String(tool.name)}.parameters`, problems)
  auditSchema(tool.output.schema, `${String(tool.name)}.output.schema`, problems)
  for (const problem of problems) check(false, 'tool schema is harness-compatible', problem)
}

if (typeof dispose === 'function') await dispose()
await rm(workdir, { recursive: true, force: true })

process.stdout.write(`\nverify-plugin: ${String(state.tools.length)} tools, ${String(state.commands.length)} commands, ${String(state.routes.length)} routes\n`)
for (const note of notes) process.stdout.write(`  ${note}\n`)
if (failures.length > 0) {
  process.stdout.write(`\nFAILED (${String(failures.length)}):\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\nverify-plugin: OK\n')
}
