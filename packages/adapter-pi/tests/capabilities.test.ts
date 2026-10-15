/**
 * Pi's capability inventory, against a fixture agent directory and project tree built in a
 * temporary directory and removed afterwards.
 *
 * What it proves: the reader resolves every documented Pi resource location — the agent
 * directory's `skills/`, `prompts/`, `mcp.json`, context files and `SYSTEM.md`/
 * `APPEND_SYSTEM.md`; the project's `.pi/skills`, `.pi/prompts`, `.pi/mcp.json` and
 * `.pi/SYSTEM.md`; the ancestor `.agents/skills` scan bounded by the repository root; and
 * `~/.agents/skills` — into the canonical inventory, with `sources` naming every file it
 * looked at and `notes` declaring what it could not read (a project tier withheld by trust,
 * a skill without a description, an MCP entry Pi would reject).
 *
 * The package's own sources are imported by name across workspace packages, which resolves
 * to each package's built `lib/` in this repository, so this test bundles
 * `src/capabilities.ts` with esbuild — the same tool `scripts/build.mjs` uses — and imports
 * that, which guarantees the assertions run against the sources in the tree. The fixture
 * files themselves are plain files under `os.tmpdir()`.
 *
 * ```sh
 * node --test packages/adapter-pi/tests/capabilities.test.ts
 * ```
 *
 * @module @zorker/muti-agent-adapter-pi/tests/capabilities
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { AgentCapabilityInventory } from '@zorker/muti-agent-contracts'

/** The reader this test drives, as the bundled module exposes it. */
interface CapabilityModule {
  readPiCapabilityInventory: (
    ctx: { log: unknown; config: unknown; files: FileProbeFace },
    agent: string,
    options: { env: NodeJS.ProcessEnv; cwd: string },
  ) => Promise<AgentCapabilityInventory>
  FileProbe: new () => FileProbeFace
}

/** The read-only file helpers the reader calls; the real `FileProbe`, bundled from source. */
interface FileProbeFace {
  resolvePath(path: string, base?: string): string
  isFile(path: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  fingerprint(path: string): Promise<{ size: number; mtimeMs: number; ino: number }>
  readHead(path: string, maxBytes?: number): Promise<{ text: string; truncated: boolean; missing: boolean }>
  readJson<T>(path: string): Promise<{ ok: true; value: T } | { ok: false; error: string; missing: boolean }>
  listDir(path: string): Promise<readonly { name: string; path: string; isDirectory: boolean; isFile: boolean }[]>
  baseName(path: string): string
}

const scratch: string[] = []

after(async () => {
  await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/**
 * Bundle the adapter's capability reader together with the core `FileProbe` it is handed,
 * against the sources in the tree, and import the result.
 */
async function loadModule(): Promise<CapabilityModule> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-caps-'))
  scratch.push(dir)
  const entry = join(dir, 'entry.ts')
  const outfile = join(dir, 'pi-capabilities.mjs')
  const reader = new URL('../src/capabilities.ts', import.meta.url).pathname
  const probe = new URL('../../core/src/process/files.ts', import.meta.url).pathname
  await writeFile(
    entry,
    `export { readPiCapabilityInventory } from ${JSON.stringify(reader)}\n` +
      `export { FileProbe } from ${JSON.stringify(probe)}\n`,
  )
  const result = await build({
    entryPoints: [entry],
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
  return imported as CapabilityModule
}

/** The reader's ambient services, with the real file probe. */
async function readContext(reader: CapabilityModule): Promise<{
  log: unknown
  config: unknown
  files: FileProbeFace
}> {
  return {
    log: { debug: () => {}, warn: () => {} },
    config: { enabled: true, env: {}, envMode: 'minimal', timeoutMs: 0, settings: {} },
    files: new reader.FileProbe(),
  }
}

/** Write a fixture tree; object values are JSON, string values are file text. */
async function writeTree(root: string, files: Readonly<Record<string, unknown>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    if (relative.endsWith('/')) {
      await mkdir(path, { recursive: true })
      continue
    }
    await writeFile(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
}

/** A skill file with the given frontmatter body. */
function skill(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody text.\n`
}

/** Build the fixture: an agent directory, a home directory, and a project with a `sub` cwd. */
async function fixture(): Promise<{
  agentDir: string
  home: string
  cwd: string
  env: NodeJS.ProcessEnv
}> {
  const root = await mkdtemp(join(tmpdir(), 'pi-caps-fixture-'))
  scratch.push(root)
  const home = join(root, 'home')
  const agentDir = join(home, '.pi', 'agent')
  const project = join(root, 'project')
  const cwd = join(project, 'sub')
  await writeTree(root, {
    'home/.pi/agent/skills/pdf-tools/SKILL.md': skill('pdf-tools', 'Extract text and tables from PDF files.'),
    'home/.pi/agent/skills/hidden/SKILL.md': skill('hidden', 'Only ever started by hand.', 'disable-model-invocation: true\n'),
    'home/.pi/agent/skills/loose.md': skill('loose', 'A standalone markdown skill.'),
    'home/.pi/agent/skills/broken/SKILL.md': '---\nname: broken\n---\n\nNo description, so Pi does not load it.\n',
    'home/.pi/agent/prompts/review.md':
      '---\ndescription: Review staged git changes\n---\nReview the staged changes.\n',
    'home/.pi/agent/prompts/deploy.md': '# Deploy the service\n\nRun the deploy script.\n',
    'home/.pi/agent/mcp.json': {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { SEED: 'never-carried' },
        },
        docs: { url: 'https://example.com/mcp', enabled: false },
      },
    },
    'home/.pi/agent/AGENTS.md': 'User instructions.\n',
    'home/.pi/agent/SYSTEM.md': 'User system prompt.\n',
    'home/.pi/agent/APPEND_SYSTEM.md': 'User append.\n',
    'home/.pi/agent/trust.json': { [cwd]: true },
    'home/.agents/skills/shared/SKILL.md': skill('shared', 'A user-level agents skill.'),
    'project/.git/': '',
    'project/AGENTS.md': 'Project instructions.\n',
    'project/.agents/skills/ancestor-skill/SKILL.md': skill('ancestor-skill', 'Found by the ancestor scan.'),
    'project/sub/AGENTS.md': 'Subdirectory instructions.\n',
    'project/sub/.pi/SYSTEM.md': 'Project system prompt.\n',
    'project/sub/.pi/skills/project-skill/SKILL.md': skill('project-skill', 'A project skill.'),
    'project/sub/.pi/prompts/project-prompt.md': '---\ndescription: A project template\n---\nDo the project thing.\n',
    'project/sub/.pi/mcp.json': {
      mcpServers: {
        'project-server': { url: 'https://project.example.com/mcp' },
        docs: { enabled: true },
        broken: {},
      },
    },
  })
  return { agentDir, home, cwd, env: { PI_CODING_AGENT_DIR: agentDir, HOME: home } }
}

test('a trusted project reads every Pi resource location into the inventory', async () => {
  const reader = await loadModule()
  const { agentDir, home, cwd, env } = await fixture()
  const inventory = await reader.readPiCapabilityInventory(await readContext(reader), 'pi', { env, cwd })

  assert.equal(inventory.agentId, 'pi')
  assert.ok(Number.isFinite(Date.parse(inventory.observedAt)), 'observedAt is an ISO timestamp')

  // Tools: Pi's declared built-in set, and the two inactive built-in-extension tools.
  assert.deepEqual(
    inventory.tools.map(tool => [tool.name, tool.source, tool.discoverable ?? false]),
    [
      ['read', 'builtin', false],
      ['bash', 'builtin', false],
      ['powershell', 'builtin', false],
      ['edit', 'builtin', false],
      ['write', 'builtin', false],
      ['grep', 'builtin', false],
      ['find', 'builtin', false],
      ['ls', 'builtin', false],
      ['codemode', 'builtin', true],
      ['tool_search', 'builtin', true],
    ],
  )

  // Skills: project .pi/skills, the ancestor .agents/skills, then the two user roots.
  assert.deepEqual(
    inventory.skills.map(s => [s.name, s.description, s.source, s.userInvocable, s.path]),
    [
      [
        'project-skill',
        'A project skill.',
        'project',
        true,
        join(cwd, '.pi', 'skills', 'project-skill', 'SKILL.md'),
      ],
      [
        'ancestor-skill',
        'Found by the ancestor scan.',
        'project',
        true,
        join(dirname(cwd), '.agents', 'skills', 'ancestor-skill', 'SKILL.md'),
      ],
      ['hidden', 'Only ever started by hand.', 'user', true, join(agentDir, 'skills', 'hidden', 'SKILL.md')],
      ['loose', 'A standalone markdown skill.', 'user', true, join(agentDir, 'skills', 'loose.md')],
      ['pdf-tools', 'Extract text and tables from PDF files.', 'user', true, join(agentDir, 'skills', 'pdf-tools', 'SKILL.md')],
      ['shared', 'A user-level agents skill.', 'user', true, join(home, '.agents', 'skills', 'shared', 'SKILL.md')],
    ],
  )

  // Commands: Pi's built-in slash commands, then the agent-directory templates, then the
  // project's. The second template's description is its first non-empty line.
  const commandNames = inventory.commands.map(command => command.name)
  assert.equal(inventory.commands.length, 25 + 2 + 1)
  assert.deepEqual(commandNames.slice(0, 4), ['settings', 'model', 'thinking', 'scoped-models'])
  assert.deepEqual(commandNames.slice(-3), ['deploy', 'review', 'project-prompt'])
  assert.deepEqual(
    inventory.commands.slice(-3).map(command => [command.name, command.description, command.source]),
    [
      ['deploy', '# Deploy the service', 'user'],
      ['review', 'Review staged git changes', 'user'],
      ['project-prompt', 'A project template', 'project'],
    ],
  )

  // MCP servers: the agent-directory file, with the project override applied by name.
  assert.deepEqual(
    inventory.mcpServers.map(server => [server.name, server.transport, server.command, server.url, server.enabled, server.source]),
    [
      ['filesystem', 'stdio', 'npx -y @modelcontextprotocol/server-filesystem .', undefined, true, 'user'],
      ['docs', 'http', undefined, 'https://example.com/mcp', true, 'user'],
      ['project-server', 'http', undefined, 'https://project.example.com/mcp', true, 'project'],
    ],
  )

  // Context files, in Pi's loader order, and paths only.
  assert.deepEqual(inventory.contextFiles, [
    join(agentDir, 'AGENTS.md'),
    join(dirname(cwd), 'AGENTS.md'),
    join(cwd, 'AGENTS.md'),
    join(cwd, '.pi', 'SYSTEM.md'),
    join(agentDir, 'APPEND_SYSTEM.md'),
  ])

  // Sources name every file and root the read looked at.
  assert.deepEqual(inventory.sources, [
    { path: join(agentDir, 'settings.json'), present: false },
    { path: join(agentDir, 'trust.json'), present: true },
    { path: join(cwd, '.pi', 'skills'), present: true },
    { path: join(cwd, '.agents', 'skills'), present: false },
    { path: join(dirname(cwd), '.agents', 'skills'), present: true },
    { path: join(agentDir, 'skills'), present: true },
    { path: join(home, '.agents', 'skills'), present: true },
    { path: join(agentDir, 'prompts'), present: true },
    { path: join(cwd, '.pi', 'prompts'), present: true },
    { path: join(agentDir, 'mcp.json'), present: true },
    { path: join(cwd, '.pi', 'mcp.json'), present: true },
    { path: join(agentDir, 'AGENTS.md'), present: true },
    { path: join(dirname(cwd), 'AGENTS.md'), present: true },
    { path: join(cwd, 'AGENTS.md'), present: true },
    { path: join(cwd, '.pi', 'SYSTEM.md'), present: true },
    { path: join(agentDir, 'APPEND_SYSTEM.md'), present: true },
  ])

  // Notes: the declared gaps. A trusted read has nothing withheld by trust.
  const reasons = inventory.notes.map(note => note.reason)
  assert.ok(reasons.some(reason => reason.includes('settings.defaultTools')), 'the tool-selection gap is declared')
  assert.ok(reasons.some(reason => reason.includes('mcp__<server>__<tool>')), 'the unenumerable MCP tools are declared')
  assert.ok(reasons.some(reason => reason.includes('built-in slash commands')), 'the built-in command source is declared')
  assert.ok(
    reasons.some(reason => reason.includes('disable-model-invocation') && reason.includes('userInvocable')),
    'the skill projection loss is declared',
  )
  assert.ok(
    reasons.some(reason => reason.includes('declared no description') && reason.includes('broken')),
    'the skip of a description-less skill is declared',
  )
  assert.ok(
    reasons.some(reason => reason.includes('skipped') && reason.includes('broken (in')),
    'the MCP entry Pi rejects is declared',
  )
  assert.ok(
    reasons.some(reason => reason.includes('docs') && reason.includes('overridden')),
    'the project MCP override is declared',
  )
  assert.ok(
    reasons.some(reason => reason.includes('env and headers values are never read')),
    'the credential-bearing MCP keys are declared',
  )
  assert.ok(
    inventory.notes.every(note => typeof note.field === 'string' && note.field !== ''),
    'every note names a field',
  )
  assert.ok(
    !reasons.some(reason => reason.includes('project trust')),
    'a trusted read declares nothing withheld by trust',
  )
})

test('an untrusted project tier is withheld and declared, not silently dropped', async () => {
  const reader = await loadModule()
  const { agentDir, home, cwd, env } = await fixture()
  await rm(join(agentDir, 'trust.json'))
  const inventory = await reader.readPiCapabilityInventory(await readContext(reader), 'pi', { env, cwd })

  // Project skills disappear; the user roots stay.
  assert.deepEqual(inventory.skills.map(s => s.name), ['hidden', 'loose', 'pdf-tools', 'shared'])
  // The project MCP entries are not read: docs keeps the user file's `enabled: false`.
  assert.deepEqual(
    inventory.mcpServers.map(server => [server.name, server.enabled, server.source]),
    [
      ['filesystem', true, 'user'],
      ['docs', false, 'user'],
    ],
  )
  // The project's SYSTEM.md is not used; the agent-directory one is.
  assert.ok(inventory.contextFiles.includes(join(agentDir, 'SYSTEM.md')))
  assert.ok(!inventory.contextFiles.includes(join(cwd, '.pi', 'SYSTEM.md')))
  // And every withheld tier is declared, with the project mcp.json named explicitly.
  const reasons = inventory.notes.map(note => note.reason)
  assert.ok(reasons.some(reason => reason.includes(join(cwd, '.pi', 'mcp.json')) && reason.includes('project trust')))
  assert.ok(reasons.some(reason => reason.includes(join(cwd, '.pi', 'skills')) && reason.includes('project trust')))
  assert.ok(reasons.some(reason => reason.includes(join(cwd, '.pi', 'prompts')) && reason.includes('project trust')))
  assert.ok(reasons.some(reason => reason.includes('project .agents/skills') && reason.includes('project trust')))
  assert.ok(reasons.some(reason => reason.includes('SYSTEM.md') && reason.includes('project trust')))
  // The withheld roots say so in `sources` too.
  const withheld = inventory.sources.filter(source => source.note !== undefined)
  assert.ok(withheld.some(source => source.path === join(cwd, '.pi', 'skills')))
  assert.ok(withheld.some(source => source.path === join(cwd, '.pi', 'prompts')))
  assert.ok(withheld.some(source => source.path === join(cwd, '.pi', 'mcp.json')))
  // The user-level agent skill tree is unaffected (the fixture's home is not the cwd).
  assert.ok(inventory.sources.some(source => source.path === join(home, '.agents', 'skills') && source.present))
})
