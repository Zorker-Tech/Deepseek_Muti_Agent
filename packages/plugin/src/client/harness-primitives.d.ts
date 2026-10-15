/**
 * Type declarations for the harness control we reuse: the dropdown the access-mode
 * switcher and the model selector are built from.
 *
 * The implementation is not a dependency of this package. It lives in the page's module
 * table and the client bundle reaches it through the loader's `require`, which is why the
 * build keeps `@deepseek-ai/dsh-client-ui-primitives` external (ADR-0005). These
 * declarations mirror **only** the members this plugin passes and reads, so a change to
 * the real component's props shows up as a type error here rather than as a blank control
 * in the composer. The runtime contract is verified in `scripts/verify-client-bundle.mjs`
 * and by rendering the composer in a browser.
 *
 * @module @zorker/muti-agent-plugin/client/harness-primitives
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  /** One selectable row in a `Menu`. */
  export interface MenuItem {
    id: string
    label: ReactNode
    icon?: ReactNode
    disabled?: boolean
    danger?: boolean
  }

  /** A non-selectable row. */
  export interface MenuLabel {
    type: 'label'
    label: ReactNode
  }

  /** A rule between rows. */
  export interface MenuSeparator {
    type: 'separator'
  }

  /** Any row a `Menu` accepts. */
  export type MenuEntry = MenuItem | MenuLabel | MenuSeparator

  /** Props of the shared anchored dropdown. */
  export interface MenuProps {
    open: boolean
    anchor: ReactNode
    items?: readonly MenuEntry[]
    selectedId?: string | undefined
    onSelect?: (id: string) => void
    onClose?: () => void
    side?: 'top' | 'bottom'
    align?: 'start' | 'end'
    portal?: boolean
    autoFocus?: boolean
  }

  /** The shared anchored dropdown, as this plugin uses it. */
  export function Menu(props: MenuProps): ReactNode

  /** The states a `StateDot` renders. */
  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

  /** Props of the shared status dot. */
  export interface StateDotProps {
    state: StateDotState
    size?: number
    className?: string
  }

  /** The shared status dot. */
  export function StateDot(props: StateDotProps): ReactNode
}
