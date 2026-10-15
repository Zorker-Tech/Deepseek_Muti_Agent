/**
 * Build MutiAgent's installable artifact.
 *
 * Three outputs, because the harness loads them differently:
 *
 * - `lib/index.js` (host, ESM, Node): the Cordis plugin. All workspace packages are
 *   bundled in, so the installed artifact resolves nothing of ours at runtime.
 * - `lib/client.js` (browser): the CJS closure factory the harness's module loader
 *   expects. React is external and resolved from the page's module table, so no second
 *   React is ever shipped (ADR-0005).
 * - `lib/mcp-stdio.js` (host, ESM, Node): the standalone MCP server.
 *
 * `--face` selects one, so the two build faces can run independently in CI and a client
 * change never rebuilds the host bundle.
 *
 * @module scripts/build
 */

import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(root, 'packages', 'plugin')

/** The harness's browser module-table baseline: everything here must stay external. */
const MODULE_TABLE_BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** The package name that must appear in the module-loader registration. */
const PACKAGE_NAME = '@zorker/muti-agent-plugin'

/**
 * A CommonJS `require` for the ESM host bundle.
 *
 * Some dependencies (the `yaml` parser among them) reach for `require` dynamically, which an
 * ESM bundle cannot express; esbuild leaves the call in place and the module then fails at
 * import time with `Dynamic require of "process" is not supported`. Providing a real
 * `require` through `createRequire` makes those calls work instead of failing the whole
 * adapter — which is how the oh-my-pi adapter silently failed to register.
 */
const CJS_REQUIRE_BANNER =
  "import { createRequire as __mutiCreateRequire } from 'node:module';"
  + 'const require = __mutiCreateRequire(import.meta.url);'

function parseArgs(argv) {
  const options = { faces: [], minify: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--face') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--face needs a value: host | client | mcp')
      options.faces.push(value)
      index += 1
      continue
    }
    if (arg === '--no-minify') {
      options.minify = false
      continue
    }
    if (arg === '--all') continue
    throw new Error(`unknown build argument ${JSON.stringify(arg)}`)
  }
  if (options.faces.length === 0) options.faces = ['host', 'client', 'mcp', 'proxy']
  return options
}

/** Build the ESM host plugin. */
async function buildHost(minify) {
  await build({
    entryPoints: [join(pluginDir, 'src', 'host', 'index.ts')],
    outfile: join(pluginDir, 'lib', 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify,
    sourcemap: true,
    // Node builtins stay external; every workspace package is bundled, so the
    // installed artifact has no dependency of ours to resolve at runtime.
    external: ['node:*'],
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: CJS_REQUIRE_BANNER },
  })
}

/**
 * Build the preset-mounted proxy plugin.
 *
 * A separate entry because a preset row names a package specifier, so the proxy must be its
 * own module: `${PACKAGE_NAME}/agent-proxy`.
 */
async function buildAgentProxy(minify) {
  await build({
    entryPoints: [join(pluginDir, 'src', 'host', 'agent-proxy.ts')],
    outfile: join(pluginDir, 'lib', 'agent-proxy.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify,
    sourcemap: true,
    external: ['node:*'],
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: CJS_REQUIRE_BANNER },
  })
}

/** Build the standalone MCP server entry. */
async function buildMcp(minify) {
  await build({
    entryPoints: [join(pluginDir, 'src', 'host', 'mcp-stdio-entry.ts')],
    outfile: join(pluginDir, 'lib', 'mcp-stdio.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify,
    sourcemap: true,
    external: ['node:*'],
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: `#!/usr/bin/env node\n${CJS_REQUIRE_BANNER}` },
  })
}

/**
 * Build the browser bundle in the harness's closure-factory envelope.
 *
 * The envelope matches the harness's own client emitter, and the factory receives the
 * module table's `require` so every baseline word resolves to the page's single instance.
 *
 * One addition the envelope alone does not provide: a `module` shim. A CJS bundle assigns
 * its exports to `module.exports`, and unlike the harness's rolldown-based emitter — which
 * supplies one — esbuild's CJS output expects the CommonJS globals to exist. Without the
 * shim the factory throws `module is not defined` at materialization and the plugin's
 * entire UI silently disappears from the page while the host half keeps working.
 */
async function buildClient(minify) {
  await build({
    entryPoints: [join(pluginDir, 'src', 'client', 'index.ts')],
    outfile: join(pluginDir, 'lib', 'client.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    minify,
    sourcemap: false,
    jsx: 'automatic',
    // React 19's automatic runtime resolves through the module table's `react`, so
    // `react/jsx-runtime` must stay external too.
    external: MODULE_TABLE_BASELINE,
    legalComments: 'none',
    logLevel: 'warning',
    banner: {
      js:
        `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {` +
        'const module = { exports: {} }; const exports = module.exports;',
    },
    footer: { js: 'return module.exports; } });' },
  })
}

/** Emit the type declarations the manifest advertises. */
async function buildTypes() {
  const manifestPath = join(pluginDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const required = [
    './lib/types/host/index.d.ts',
    './lib/types/client/index.d.ts',
  ]
  const missing = []
  for (const relative of required) {
    try {
      await readFile(join(pluginDir, relative), 'utf8')
    } catch {
      missing.push(relative)
    }
  }
  if (missing.length > 0) {
    process.stderr.write(
      `muti-agent build: ${manifest.name} advertises types that are not built yet: ${missing.join(', ')}\n` +
        'Run `pnpm run build:types` (tsc -b) before packaging.\n',
    )
  }
}

const options = parseArgs(process.argv.slice(2))
await mkdir(join(pluginDir, 'lib'), { recursive: true })

for (const face of options.faces) {
  if (face === 'host') await buildHost(options.minify)
  else if (face === 'client') await buildClient(options.minify)
  else if (face === 'mcp') await buildMcp(options.minify)
  else if (face === 'proxy') await buildAgentProxy(options.minify)
  else if (face === 'types') await buildTypes()
  else throw new Error(`unknown build face ${JSON.stringify(face)}`)
}
