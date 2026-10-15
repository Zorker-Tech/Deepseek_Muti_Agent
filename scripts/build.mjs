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
  if (options.faces.length === 0) options.faces = ['host', 'client', 'mcp']
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
    banner: { js: '#!/usr/bin/env node' },
  })
}

/**
 * Build the browser bundle in the harness's closure-factory envelope.
 *
 * The banner/footer pair is byte-compatible with the harness's own client emitter; the
 * factory receives the module table's `require`, so every baseline word resolves to the
 * page's single instance.
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
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {` },
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
  else if (face === 'types') await buildTypes()
  else throw new Error(`unknown build face ${JSON.stringify(face)}`)
}
