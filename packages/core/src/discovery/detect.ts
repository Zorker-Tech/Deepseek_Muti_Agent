/**
 * Binary and home-directory detection. Shared by adapters so every agent is
 * discovered the same way and reports the same diagnostic vocabulary.
 *
 * @module @zorker/muti-agent-core/discovery/detect
 */

import { access, constants, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { AgentDetection } from '@zorker/muti-agent-contracts'
import type { ProcessRunner } from '../process/runner.ts'

/** Result of resolving a binary on this machine. */
export interface BinaryResolution {
  found: boolean
  path?: string
  /** How it was found. */
  source: 'path' | 'config' | 'well-known' | 'none'
  /** Why it was not found, when applicable. */
  reason?: string
}

/**
 * Locate an executable without spawning anything.
 *
 * @param name - Bare command name, e.g. `codex`.
 * @param options - Extra absolute candidate paths to try before PATH lookup.
 * @returns The resolved absolute path, or why resolution failed.
 */
export async function resolveBinary(
  name: string,
  options: { candidates?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<BinaryResolution> {
  const env = options.env ?? process.env

  for (const candidate of options.candidates ?? []) {
    if (candidate === '') continue
    const absolute = isAbsolute(candidate) ? candidate : join(process.cwd(), candidate)
    if (await isExecutable(absolute)) {
      return { found: true, path: await realpath(absolute).catch(() => absolute), source: 'config' }
    }
  }

  const pathValue = env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (await isExecutable(candidate)) {
      return { found: true, path: await realpath(candidate).catch(() => candidate), source: 'path' }
    }
  }

  // A few install locations worth trying when PATH is unusual (a GUI-launched host
  // process often has a minimal PATH).
  const home = env.HOME ?? ''
  for (const candidate of [
    home === '' ? '' : join(home, '.local', 'bin', name),
    home === '' ? '' : join(home, '.cargo', 'bin', name),
    home === '' ? '' : join(home, '.bun', 'bin', name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ]) {
    if (candidate === '') continue
    if (await isExecutable(candidate)) {
      return { found: true, path: await realpath(candidate).catch(() => candidate), source: 'well-known' }
    }
  }

  return {
    found: false,
    source: 'none',
    reason: `\`${name}\` was not found on PATH or in any known install location`,
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Read a version string from an agent binary.
 *
 * Every supported agent prints a version for `--version`; the first line is taken
 * verbatim because these strings are user-facing and version-parsing rules differ
 * per product.
 *
 * @param runner - The managed process runner.
 * @param binaryPath - Absolute path of the binary.
 * @param options - Version arguments and the directory to probe from.
 * @returns The version string, or `undefined` when the probe failed.
 */
export async function probeVersion(
  runner: ProcessRunner,
  binaryPath: string,
  options: { args?: readonly string[]; cwd?: string } = {},
): Promise<string | undefined> {
  const outcome = await runner.run({
    command: binaryPath,
    args: [...(options.args ?? ['--version'])],
    cwd: options.cwd ?? homedir(),
    envMode: 'minimal',
    timeoutMs: 10_000,
    captureBytes: 64 * 1024,
  })
  const text = `${outcome.stdout.head}${outcome.stdout.tail}`.trim()
  const stderr = `${outcome.stderr.head}${outcome.stderr.tail}`.trim()
  const source = text !== '' ? text : stderr
  if (source === '') return undefined
  const firstLine = source.split('\n')[0]?.trim()
  return firstLine === undefined || firstLine === '' ? undefined : firstLine
}

/**
 * Resolve an agent's home directory from an explicit override, an environment
 * variable, or a default under the user's home.
 *
 * @param options - Override, environment variable name, and default directory name.
 * @returns The resolved absolute path plus a note when the variable was used.
 */
export function resolveHome(options: {
  override?: string
  envName: string
  defaultName: string
  env?: NodeJS.ProcessEnv
}): { path: string; fromEnv: boolean } {
  const env = options.env ?? process.env
  if (options.override !== undefined && options.override !== '') {
    return { path: options.override, fromEnv: false }
  }
  const fromEnvValue = env[options.envName]
  if (fromEnvValue !== undefined && fromEnvValue !== '') {
    return { path: fromEnvValue, fromEnv: true }
  }
  const home = env.HOME ?? env.USERPROFILE ?? ''
  return { path: join(home, options.defaultName), fromEnv: false }
}

/** Assemble a detection record from a resolution and an optional version probe. */
export function detectionFrom(
  resolution: BinaryResolution,
  extras: { version?: string; homeDir?: string } = {},
): AgentDetection {
  if (!resolution.found || resolution.path === undefined) {
    return { installed: false, source: 'none', ...(resolution.reason === undefined ? {} : { reason: resolution.reason }) }
  }
  return {
    installed: true,
    binaryPath: resolution.path,
    source: resolution.source,
    ...(extras.version === undefined ? {} : { version: extras.version }),
    ...(extras.homeDir === undefined ? {} : { homeDir: extras.homeDir }),
  }
}
