/**
 * Materialize the built browser bundle outside a browser.
 *
 * The harness serves `lib/client.js` as a closure factory and the page's module table
 * supplies `require`. This reproduces both: it captures the registration, runs the
 * factory against a stub `require` and a stub DOM, and then calls `apply(ctx)` against a
 * stub slot registry. That is exactly the sequence the page performs, so a bundle that
 * would throw in the browser fails here instead — which is how a missing CommonJS shim
 * (a bundle that threw `module is not defined`, leaving the whole UI absent while the host
 * half looked healthy) was caught.
 *
 * @module scripts/verify-client-bundle
 */

import { readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'packages', 'plugin', 'lib', 'client.js')
const PACKAGE_NAME = '@zorker/muti-agent-plugin'
const EXPECTED_SLOTS = ['sidebar.panellist', 'main', 'settings.section', 'shell.overlay', 'conversation.input.right', 'sidebar.right.pane.tab']

const failures = []
const notes = []

/**
 * Assert a condition, collecting failures instead of throwing.
 *
 * @param {boolean} condition - What must hold.
 * @param {string} label - What was checked.
 * @param {unknown} [detail] - Extra context on failure.
 */
function check(condition, label, detail) {
  if (condition) return
  failures.push(detail === undefined ? label : `${label} — ${String(detail)}`)
}

const source = await readFile(bundlePath, 'utf8')

// Envelope: the loader matches a registration by exact id, so this is a hard contract.
check(source.startsWith(`window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`),
  'the bundle opens the harness loader envelope with its own package id')
check(source.trimEnd().endsWith('return module.exports; } });'), 'the bundle closes the envelope and returns the exports')
check(/const module = \{ exports: \{\} \}/.test(source), 'the bundle provides the CommonJS module shim the factory needs')

// Materialize: run the real captured factory against stubbed CommonJS globals.
let registration
const listeners = []
const documentStub = {
  createElement: tag => ({ tag, dataset: {}, textContent: '', setAttribute() {}, remove() {} }),
  head: { append(child) { listeners.push(child) } },
  querySelector: () => null,
}
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  // The composer control reuses the harness's Menu primitive; the stub returns markers
  // so a registration that forgets to pass it through still throws.
  Menu: 'Menu',
  StateDot: 'StateDot',
  Fragment: 'Fragment',
  useState: value => [value, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const globalScope = {
  window: { __ModuleLoader__: { load: entry => { registration = entry } } },
  document: documentStub,
  navigator: { language: 'en-US' },
  fetch: async () => { throw new Error('the client must not fetch during apply') },
  EventSource: class { constructor() {} close() {} addEventListener() {} },
  setTimeout,
  clearTimeout,
  console,
}
const requireStub = specifier => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return { jsx: reactStub.createElement, jsxs: reactStub.createElement, Fragment: 'Fragment' }
  // The module table serves the harness's own primitives; a bare specifier here stands in
  // for that table so the bundle's `require` calls are exercised.
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Menu: reactStub.Menu, StateDot: reactStub.StateDot }
  }
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
}

try {
  // eslint-disable-next-line no-new-func -- the bundle is browser code, not a module.
  const run = new Function(
    'window', 'document', 'navigator', 'fetch', 'EventSource', 'setTimeout', 'clearTimeout', 'console',
    source,
  )
  run(globalScope.window, globalScope.document, globalScope.navigator, globalScope.fetch, globalScope.EventSource, setTimeout, clearTimeout, console)
} catch (cause) {
  failures.push(`materializing the bundle threw: ${cause instanceof Error ? cause.message : String(cause)}`)
}

check(registration !== undefined, 'the bundle registered itself with the module loader')
check(registration?.id === PACKAGE_NAME, 'the registration id matches the graph row id', registration?.id)

let exported
if (registration !== undefined) {
  try {
    exported = registration.factory(requireStub)
  } catch (cause) {
    failures.push(`the factory threw: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
check(exported !== undefined && typeof exported.apply === 'function', 'the factory returns apply()')
check(Array.isArray(exported?.inject) && exported.inject.includes('slots'), 'the module declares the slots dependency', exported?.inject)

// Apply against a stub registry, which is where a bundle that loads but registers nothing
// would show up.
const registered = []
const injected = []
if (typeof exported?.apply === 'function') {
  const ctx = {
    slots: {
      inject: (key, callback) => { injected.push(key); callback() },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect: callback => callback(),
    on: () => () => {},
    get: name => (name === 'locale' ? { register: () => () => {}, bind: () => key => key } : undefined),
  }
  try {
    exported.apply(ctx)
  } catch (cause) {
    failures.push(`apply() threw: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

for (const key of EXPECTED_SLOTS) {
  check(injected.includes(key), `apply() waits for the ${key} slot`)
  check(registered.some(entry => entry.options?.name === key), `apply() registers into ${key}`)
}
const panelRows = registered.filter(entry => entry.options?.name === 'sidebar.panellist')
check(panelRows.length === 3, 'three sidebar panel rows are contributed', panelRows.length)
const composerRows = registered.filter(entry => entry.options?.name === 'conversation.input.right')
// One control only. The model selector in the composer stays the harness's own; this plugin
// contributes an agent switcher and reads agent models as data, not as a second dropdown.
check(composerRows.length === 1, 'the composer contributes exactly one control', composerRows.length)
check(
  composerRows[0]?.options?.id === 'mutiagent-agent',
  'the composer control is the agent switcher',
  composerRows[0]?.options?.id,
)
const styles = listeners.filter(node => node.tag === 'style')
check(styles.length === 1, 'exactly one stylesheet is injected', styles.length)
check(styles[0]?.textContent?.includes('--dsw-'), 'the stylesheet uses the harness theme tokens')

notes.push(`slots: ${registered.map(entry => entry.options?.name).filter(Boolean).join(', ')}`)
notes.push(`panel ids: ${panelRows.map(entry => entry.options?.id).join(', ')}`)

process.stdout.write('\nverify-client-bundle:\n')
for (const note of notes) process.stdout.write(`  ${note}\n`)
if (failures.length > 0) {
  process.stdout.write(`\nFAILED (${failures.length}):\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\nverify-client-bundle: OK\n')
}
