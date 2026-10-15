/**
 * State plumbing for the browser half: one tiny observable store, the React
 * bindings over it, and the async-loading hook every surface shares. There is no
 * state library and no framework service — a store is read through
 * `useSyncExternalStore`, so a surface re-renders exactly when its data changes.
 *
 * @module @zorker/muti-agent-plugin/client/store
 */

import * as React from 'react'
import { localeRevision, subscribeLocale, t, type Translate } from './locales.ts'

/** A minimal observable cell. */
export interface Store<T> {
  /** @returns The current value. */
  get(): T
  /** @param value - The next value; a no-op when it is identical. */
  set(value: T): void
  /**
   * @param updater - Produces the next value from the current one.
   */
  update(updater: (current: T) => T): void
  /**
   * @param listener - Called after every accepted change.
   * @returns Unsubscribe.
   */
  subscribe(listener: () => void): () => void
}

/**
 * Create a store.
 *
 * @typeParam T - Value type.
 * @param initial - The initial value.
 * @returns The store.
 */
export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  const publish = (next: T): void => {
    if (Object.is(next, value)) return
    value = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => value,
    set: publish,
    update: updater => {
      publish(updater(value))
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Read a store from a component.
 *
 * @typeParam T - Value type.
 * @param store - The store to read.
 * @returns The current value, re-rendering on change.
 */
export function useStore<T>(store: Store<T>): T {
  return React.useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * The translate seat for a component: re-renders when the user switches language.
 *
 * @returns The plugin translator.
 */
export function useT(): Translate {
  React.useSyncExternalStore(subscribeLocale, localeRevision, localeRevision)
  return t
}

/** A failure as the UI presents it: code, message and the next step. */
export interface FailureInfo {
  /** Stable code, e.g. `wire/bad-params` or `wire/bad-envelope`. */
  readonly code: string
  /** What went wrong, in the operation's own terms. */
  readonly message: string
  /** What the human should do next, when the host offered an action. */
  readonly remediation: string | undefined
}

/** A value that already carries the failure shape the host emits. */
interface FailureCarrier {
  code: string
  message: string
  remediation?: string | undefined
}

/**
 * Duck-typed instead of an `instanceof`, so this module never imports the RPC
 * client and the two stay acyclic.
 *
 * @param value - A caught value.
 * @returns Whether it carries a shaped failure.
 */
function isFailureCarrier(value: unknown): value is FailureCarrier {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  )
}

/**
 * Normalize a thrown value for display. Every fetch path routes through this, so a
 * failure always renders code + message + remediation rather than a blank panel.
 *
 * @param cause - The caught value.
 * @returns The presentable failure.
 */
export function toFailure(cause: unknown): FailureInfo {
  if (isFailureCarrier(cause)) {
    return {
      code: cause.code,
      message: cause.message,
      remediation: cause.remediation,
    }
  }
  if (cause instanceof Error) {
    return { code: 'harness/unclassified', message: cause.message, remediation: undefined }
  }
  return { code: 'harness/unclassified', message: String(cause), remediation: undefined }
}

/** The state of one async read. */
export type AsyncState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly error: FailureInfo }

/** An async read plus its reload trigger. */
export interface AsyncHandle<T> {
  /** The current state. */
  readonly state: AsyncState<T>
  /** Re-run the loader. */
  reload(): void
}

/**
 * Run an async read and expose its three states.
 *
 * The loader is read fresh on every run and is deliberately not a dependency: the
 * caller's `key` is the single invalidation input, which keeps a stale closure from
 * silently serving old data.
 *
 * @typeParam T - The value the loader resolves.
 * @param load - The read; receives an abort signal honoured on unmount and on key change.
 * @param key - Changes to this string re-run the read.
 * @returns The state and `reload`.
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
): AsyncHandle<T> {
  const [attempt, setAttempt] = React.useState(0)
  const [state, setState] = React.useState<AsyncState<T>>({ status: 'loading' })
  const loadRef = React.useRef(load)
  loadRef.current = load
  React.useEffect(() => {
    const controller = new AbortController()
    let live = true
    setState({ status: 'loading' })
    loadRef.current(controller.signal).then(
      value => {
        if (live) setState({ status: 'ready', value })
      },
      (cause: unknown) => {
        // An aborted read is a navigation, not a failure.
        if (!live || controller.signal.aborted) return
        setState({ status: 'error', error: toFailure(cause) })
      },
    )
    return () => {
      live = false
      controller.abort()
    }
  }, [key, attempt])
  const reload = React.useCallback(() => {
    setAttempt(current => current + 1)
  }, [])
  return { state, reload }
}
