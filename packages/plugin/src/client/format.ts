/**
 * Presentation helpers shared by every surface: relative time, path shortening,
 * byte and duration formatting, and the tone/label mapping for the status pills.
 * Keeping the mappings here is what lets a component stay free of copy.
 *
 * @module @zorker/muti-agent-plugin/client/format
 */

import type {
  AuthSource,
  AuthStatus,
  ConflictSeverity,
  CredentialFlow,
  MessageKind,
  RunStatus,
  SessionStatus,
  TodoStatus,
} from '@zorker/muti-agent-contracts'
import type { Translate } from './locales.ts'

/** The visual weight of a status pill. */
export type Tone = 'ok' | 'warn' | 'error' | 'idle' | 'accent'

/** A status as the UI renders it: a colour tone plus localized text. */
export interface StatusPresentation {
  /** Which pill tone to paint. */
  readonly tone: Tone
  /** Localized status text. */
  readonly label: string
}

/** Fallback tone for a value the wire carried but this build does not know. */
const UNKNOWN: StatusPresentation = { tone: 'idle', label: '' }

/**
 * Render a timestamp as an age.
 *
 * @param value - ISO 8601 timestamp, when the agent recorded one.
 * @param t - Translator for the relative-time vocabulary.
 * @param now - Current epoch milliseconds; injectable for tests.
 * @returns The localized age, or the localized "unknown" for a missing timestamp.
 */
export function relativeTime(value: string | undefined, t: Translate, now: number = Date.now()): string {
  if (value === undefined) return t('time.unknown')
  const at = Date.parse(value)
  if (Number.isNaN(at)) return t('time.unknown')
  const deltaMs = now - at
  if (deltaMs < 60_000) return t('time.justNow')
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) return t('time.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hours', { count: hours })
  return t('time.days', { count: Math.floor(hours / 24) })
}

/**
 * Shorten an absolute path to its last few segments; the full path belongs in the
 * element's `title`, never in the row.
 *
 * @param path - Absolute path, when the session recorded one.
 * @param segments - How many trailing segments to keep.
 * @returns The shortened path, or an empty string when there is no path.
 */
export function shortenPath(path: string | undefined, segments = 2): string {
  if (path === undefined || path === '') return ''
  const parts = path.split('/').filter(part => part.length > 0)
  if (parts.length <= segments) return path
  return `…/${parts.slice(parts.length - segments).join('/')}`
}

/**
 * Format a byte count.
 *
 * @param bytes - Count, when the agent reported one.
 * @returns A short human form, e.g. `1.4 MB`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1)
  const label = units[unit] ?? 'B'
  return `${rounded} ${label}`
}

/**
 * Format a wall-clock duration.
 *
 * @param ms - Duration in milliseconds.
 * @returns A compact form, e.g. `820ms`, `42s`, `3m 05s`, `2h 10m`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${String(totalSeconds)}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) {
    const seconds = totalSeconds % 60
    return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Elapsed time since an ISO start, for a live run.
 *
 * @param startedAt - ISO 8601 start time.
 * @param now - Current epoch milliseconds.
 * @returns The formatted elapsed time, or an em dash when unparseable.
 */
export function elapsedSince(startedAt: string | undefined, now: number = Date.now()): string {
  if (startedAt === undefined) return '—'
  const at = Date.parse(startedAt)
  if (Number.isNaN(at)) return '—'
  return formatDuration(Math.max(0, now - at))
}

/**
 * Format a count with the browser's own grouping.
 *
 * @param value - The number.
 * @returns The formatted count.
 */
export function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}

/**
 * @param t - Translator.
 * @param key - The label key.
 * @param tone - The pill tone.
 * @returns A presentation.
 */
function present(t: Translate, key: Parameters<Translate>[0], tone: Tone): StatusPresentation {
  return { tone, label: t(key) }
}

/**
 * @param status - Observed session status.
 * @param t - Translator.
 * @returns Pill tone and label.
 */
export function sessionStatus(status: SessionStatus, t: Translate): StatusPresentation {
  switch (status) {
    case 'idle':
      return present(t, 'session.idle', 'idle')
    case 'running':
      return present(t, 'session.running', 'accent')
    case 'missing':
      return present(t, 'session.missing', 'warn')
    case 'unreadable':
      return present(t, 'session.unreadable', 'error')
    default:
      return UNKNOWN
  }
}

/**
 * @param status - Run lifecycle state.
 * @param t - Translator.
 * @returns Pill tone and label.
 */
export function runStatus(status: RunStatus, t: Translate): StatusPresentation {
  switch (status) {
    case 'preparing':
      return present(t, 'run.preparing', 'idle')
    case 'running':
      return present(t, 'run.running', 'accent')
    case 'succeeded':
      return present(t, 'run.succeeded', 'ok')
    case 'failed':
      return present(t, 'run.failed', 'error')
    case 'cancelled':
      return present(t, 'run.cancelled', 'warn')
    case 'timeout':
      return present(t, 'run.timeout', 'error')
    default:
      return UNKNOWN
  }
}

/**
 * @param status - Observed credential state.
 * @param t - Translator.
 * @returns Pill tone and label.
 */
export function authStatus(status: AuthStatus, t: Translate): StatusPresentation {
  switch (status) {
    case 'authenticated':
      return present(t, 'auth.authenticated', 'ok')
    case 'unauthenticated':
      return present(t, 'auth.unauthenticated', 'idle')
    case 'expired':
      return present(t, 'auth.expired', 'warn')
    case 'misconfigured':
      return present(t, 'auth.misconfigured', 'error')
    case 'unknown':
      return present(t, 'auth.unknown', 'idle')
    default:
      return UNKNOWN
  }
}

/**
 * @param source - Where the credential was observed.
 * @param t - Translator.
 * @returns The localized source label.
 */
export function authSource(source: AuthSource, t: Translate): string {
  switch (source) {
    case 'file':
      return t('auth.source.file')
    case 'env':
      return t('auth.source.env')
    case 'keyring':
      return t('auth.source.keyring')
    case 'cli-probe':
      return t('auth.source.cli-probe')
    case 'none':
      return t('auth.source.none')
    default:
      return t('common.unknown')
  }
}

/**
 * @param flow - A credential flow an adapter declared.
 * @param t - Translator.
 * @returns The localized action label for that flow.
 */
export function credentialFlow(flow: CredentialFlow, t: Translate): string {
  switch (flow) {
    case 'oauth-loopback':
      return t('settings.flow.oauth-loopback')
    case 'device-code':
      return t('settings.flow.device-code')
    case 'api-key':
      return t('settings.flow.api-key')
    case 'interactive':
      return t('settings.flow.interactive')
    default:
      return t('common.unknown')
  }
}

/**
 * @param status - Shared-board item status.
 * @param t - Translator.
 * @returns Pill tone and label.
 */
export function todoStatus(status: TodoStatus, t: Translate): StatusPresentation {
  switch (status) {
    case 'pending':
      return present(t, 'todo.pending', 'idle')
    case 'in_progress':
      return present(t, 'todo.in_progress', 'accent')
    case 'completed':
      return present(t, 'todo.completed', 'ok')
    case 'blocked':
      return present(t, 'todo.blocked', 'warn')
    case 'cancelled':
      return present(t, 'todo.cancelled', 'idle')
    default:
      return UNKNOWN
  }
}

/**
 * @param status - Collaboration task state.
 * @param t - Translator.
 * @returns Pill tone and label.
 */
export function taskStatus(
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked',
  t: Translate,
): StatusPresentation {
  switch (status) {
    case 'queued':
      return present(t, 'task.queued', 'idle')
    case 'running':
      return present(t, 'task.running', 'accent')
    case 'succeeded':
      return present(t, 'task.succeeded', 'ok')
    case 'failed':
      return present(t, 'task.failed', 'error')
    case 'cancelled':
      return present(t, 'task.cancelled', 'warn')
    case 'blocked':
      return present(t, 'task.blocked', 'warn')
    default:
      return UNKNOWN
  }
}

/**
 * @param status - Plan phase state.
 * @param t - Translator.
 * @returns Pill tone and label.
 */
export function phaseStatus(status: 'todo' | 'active' | 'done', t: Translate): StatusPresentation {
  switch (status) {
    case 'todo':
      return present(t, 'phase.todo', 'idle')
    case 'active':
      return present(t, 'phase.active', 'accent')
    case 'done':
      return present(t, 'phase.done', 'ok')
    default:
      return UNKNOWN
  }
}

/**
 * @param state - Worktree lifecycle state.
 * @param t - Translator.
 * @returns Pill tone and label.
 */
export function worktreeState(
  state: 'active' | 'idle' | 'merged' | 'removed' | 'orphan',
  t: Translate,
): StatusPresentation {
  switch (state) {
    case 'active':
      return present(t, 'worktree.active', 'accent')
    case 'idle':
      return present(t, 'worktree.idle', 'idle')
    case 'merged':
      return present(t, 'worktree.merged', 'ok')
    case 'removed':
      return present(t, 'worktree.removed', 'idle')
    case 'orphan':
      return present(t, 'worktree.orphan', 'warn')
    default:
      return UNKNOWN
  }
}

/**
 * @param severity - Conflict finding severity.
 * @param t - Translator.
 * @returns Pill tone and label.
 */
export function conflictSeverity(severity: ConflictSeverity, t: Translate): StatusPresentation {
  switch (severity) {
    case 'info':
      return present(t, 'severity.info', 'idle')
    case 'warning':
      return present(t, 'severity.warning', 'warn')
    case 'blocking':
      return present(t, 'severity.blocking', 'error')
    default:
      return UNKNOWN
  }
}

/**
 * @param status - Canonical transcript item kind.
 * @param t - Translator.
 * @returns The localized kind label.
 */
export function messageKind(kind: MessageKind, t: Translate): string {
  switch (kind) {
    case 'user':
      return t('message.user')
    case 'assistant':
      return t('message.assistant')
    case 'reasoning':
      return t('message.reasoning')
    case 'tool-call':
      return t('message.toolCall')
    case 'tool-result':
      return t('message.toolResult')
    case 'file-change':
      return t('message.fileChange')
    case 'plan':
      return t('message.plan')
    case 'error':
      return t('message.error')
    case 'system':
      return t('message.system')
    case 'unknown':
      return t('common.unknown')
    default:
      return t('common.unknown')
  }
}

/**
 * Copy text to the clipboard; the caller reports the outcome, because a silent
 * success would leave the user guessing whether the paste will work.
 *
 * @param text - Text to copy.
 * @returns Whether the clipboard accepted it.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard === 'undefined') return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
