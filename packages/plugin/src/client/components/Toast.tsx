/**
 * The toast stack and its store. It is mounted in `shell.overlay`, which stays up
 * after a panel closes, so an aborted or failed operation is still visible once the
 * user has navigated away from the surface that started it.
 *
 * An informational toast dismisses itself after {@link TOAST_TTL_MS}; an error toast
 * stays until the user dismisses it, because a failure that silently disappears is
 * worse than one that lingers.
 *
 * @module @zorker/muti-agent-plugin/client/components/Toast
 */

import * as React from 'react'
import { createStore, type FailureInfo, type Store, useStore, useT } from '../store.ts'
import { CloseGlyph } from '../icons.tsx'

/** How long an informational toast stays on screen. */
export const TOAST_TTL_MS = 6_000

/** Which surface colour a toast uses. */
export type ToastTone = 'info' | 'error'

/** One toast. */
export interface ToastRecord {
  /** Stable id, for dismissal. */
  readonly id: string
  /** Tone. */
  readonly tone: ToastTone
  /** Headline: the host's own message, or a short localized sentence. */
  readonly message: string
  /** The next step, when the host offered one. */
  readonly detail?: string
}

/** The toast store's value. */
export interface ToastState {
  /** Live toasts, oldest first. */
  readonly items: readonly ToastRecord[]
}

/** The toast store; the overlay entry subscribes to it. */
export const toastStore: Store<ToastState> = createStore({ items: [] })

let sequence = 0

/**
 * @returns A process-unique id for one toast.
 */
function nextId(): string {
  sequence += 1
  const uuid =
    typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function'
      ? undefined
      : crypto.randomUUID()
  return uuid ?? `mutiagent-toast-${String(sequence)}`
}

/**
 * @param id - Toast id.
 */
export function dismissToast(id: string): void {
  toastStore.update(state => ({
    items: state.items.filter(item => item.id !== id),
  }))
}

/**
 * @param tone - Tone.
 * @param message - Headline text.
 * @param detail - Optional next step.
 */
function push(tone: ToastTone, message: string, detail: string | undefined): void {
  const id = nextId()
  toastStore.update(state => ({
    items: [...state.items, { id, tone, message, ...(detail === undefined ? {} : { detail }) }],
  }))
  if (tone === 'info') {
    setTimeout(() => {
      dismissToast(id)
    }, TOAST_TTL_MS)
  }
}

/**
 * Announce an operation that failed, so it stays visible after the panel closes.
 *
 * @param failure - The shaped failure: code-bearing message plus its remediation.
 */
export function notifyFailure(failure: FailureInfo): void {
  push('error', failure.message, failure.remediation)
}

/**
 * Announce a failure that has no host-shaped envelope of its own, e.g. a refused
 * clipboard write.
 *
 * @param message - Localized headline text.
 * @param detail - Optional next step.
 */
export function notifyError(message: string, detail?: string): void {
  push('error', message, detail)
}

/**
 * Announce one thing that happened.
 *
 * @param message - Headline text.
 * @param detail - Optional extra line.
 */
export function notifyInfo(message: string, detail?: string): void {
  push('info', message, detail)
}

/**
 * @returns The toast stack, or null when there is nothing to show.
 */
export function ToastStack(): React.ReactElement | null {
  const t = useT()
  const state = useStore(toastStore)
  if (state.items.length === 0) return null
  return (
    <div className="ma-toasts" role="status" aria-label={t('toast.region')}>
      {state.items.map(item => (
        <div
          className={item.tone === 'error' ? 'ma-toast ma-toast--error' : 'ma-toast'}
          key={item.id}
        >
          <div className="ma-toast-body">
            <span>{item.message}</span>
            {item.detail === undefined ? null : <span className="ma-muted">{item.detail}</span>}
          </div>
          <button
            type="button"
            className="ma-btn ma-btn--quiet ma-btn--icon"
            aria-label={t('toast.dismiss')}
            title={t('toast.dismiss')}
            onClick={() => {
              dismissToast(item.id)
            }}
          >
            <CloseGlyph size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
