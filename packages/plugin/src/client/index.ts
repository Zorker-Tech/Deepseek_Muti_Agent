/**
 * The browser half of the MutiAgent plugin (ADR-0005).
 *
 * The module exports `{ inject, apply }`. Cordis activates `apply(ctx)` in the page,
 * and every surface is contributed additively: two sidebar panel rows with their own
 * `main` pages, one settings section when the settings shell is present, one overlay
 * entry for toasts, and — where the product ships a right sidebar — one tab type of our
 * own whose body follows the conversation's bound agent. Nothing here replaces a `single`
 * slot, so the harness's own session browser, settings and brand are untouched and
 * uninstalling the plugin leaves no residue.
 *
 * React arrives from the module table via `require('react')` — the build externalizes
 * it and no second copy is ever bundled.
 *
 * @module @zorker/muti-agent-plugin/client
 */

import * as React from 'react'
import { RpcClient, meshRevisionStore, subscribeMeshEvents } from './api.ts'
import { installLocale, t, type LocaleServiceLike } from './locales.ts'
import { installStyles } from './styles.ts'
import { AgentsGlyph, CapabilitiesGlyph, MeshGlyph } from './icons.tsx'
import { ToastStack } from './components/Toast.tsx'
import { RENDER_CAP, SessionsView } from './views/SessionsView.tsx'
import { MeshView } from './views/MeshView.tsx'
import { AgentSelect } from './views/AgentSelect.tsx'
import { registerAgentMenuSource } from './menu-source.ts'
import { SettingsSection } from './views/SettingsSection.tsx'
import { CapabilitiesBody } from './views/CapabilitiesPanel.tsx'
import { CapabilitiesPage } from './views/CapabilitiesPage.tsx'

/** The sidebar row id and the matching `main` panel key of the sessions browser. */
export /** The capabilities panel row and the page it addresses. */
const CAPABILITIES_PANEL_ID = 'mutiagent-capabilities'

/** The composer switcher's slot-entry id, kept apart from the two panel rows. */
const COMPOSER_AGENT_ID = 'mutiagent-agent'

const SESSIONS_PANEL_ID = 'mutiagent'

/** The sidebar row id and the matching `main` panel key of the orchestration view. */
export const MESH_PANEL_ID = 'mutiagent-mesh'

/** The overlay entry id of the toast stack. */
export const TOASTS_ID = 'mutiagent-toasts'

/** The settings section id. */
export const SETTINGS_SECTION_ID = 'mutiagent'

/**
 * The Capabilities tab type: its registration id, and the `kind` a tab of this type is.
 *
 * One value for both, because the two stages of a tab type's registration are keyed
 * differently — `sidebarRightTabs.register` takes the `id`, the keyed
 * `sidebar.right.pane.tab` seat takes the same `id` as its key — and a mismatch would
 * silently render the seat owner's "nothing can view this" notice.
 */
export const CAPABILITIES_TAB_ID = 'mutiagent-capabilities'

/** The panel id of the Agents page the capabilities tab links to. */
export const AGENTS_PANEL_ID = 'mutiagent'

/** A disposer returned by a slot injection or registration. */
export type SlotDisposer = () => void

/** What a `slots.inject` callback may return. */
export type SlotInjectionEffect = SlotDisposer | readonly SlotDisposer[] | void

/**
 * The registration options this plugin uses. The harness type-checks these against
 * its own `SlotMap`; the client declares only the members it sets, so a harness
 * option rename surfaces as a missing capability rather than as a silent no-op.
 */
export interface SlotRegistrationOptions {
  /** Slot name being contributed to. */
  readonly name: string
  /** Entry id, for a list slot. */
  readonly id?: string
  /** Entry key, for a keyed slot. */
  readonly key?: string
  /** Ascending position within the slot. */
  readonly order?: number
  /**
   * Display label, resolved at read time so it follows the active language.
   *
   * @returns The row's label.
   */
  readonly label?: () => string
  /**
   * The registrant's injected props, spread into the component.
   *
   * A session-scoped slot hands the occupant its conversation by calling this with the
   * session id — the mechanism the harness's own composer controls use, and the reason an
   * agent choice can be stored against one conversation rather than globally.
   *
   * @param sessionId - The conversation this entry belongs to, for a session-scoped slot.
   * @returns The props the framework adds to this entry's component.
   */
  readonly inject?: (sessionId: string) => object
}

/** The slice of the harness slot service this plugin calls. Structural on purpose: the
 * client depends on `react` and `react/jsx-runtime` only (ADR-0005 §3).
 */
export interface SlotServiceLike {
  /**
   * @param options - Slot name and entry options.
   * @param component - The component; the harness composes its real props, so the
   *   declared parameter type is only a lower bound.
   * @returns A disposer that removes the entry.
   */
  register(
    options: SlotRegistrationOptions,
    component: (props: never) => React.ReactNode,
  ): SlotDisposer
  /**
   * Run a contribution once the addressed slot has been declared, and re-run it if
   * the declaration is replaced. A slot that is never declared simply never fires,
   * which is the guard for optional harness surfaces such as `settings.section`.
   *
   * @param key - Slot name to wait for.
   * @param callback - Creates the disposer(s) for the contribution.
   * @returns A disposer that retires the injection.
   */
  inject(key: string, callback: () => SlotInjectionEffect): SlotDisposer
}

/** The client context, structurally. */
export interface ClientContext {
  /**
   * @param callback - Effect body, returning its own disposer.
   * @param label - Diagnostics label.
   * @returns The harness's own disposer handle.
   */
  effect(callback: () => void | (() => void), label?: string): unknown
  /** The slot service. */
  slots: SlotServiceLike
  /**
   * @param name - Service name; this plugin only ever reads `locale`, and tolerates
   *   a composition that installed none.
   * @returns The locale service, or `undefined`.
   */
  get(name: 'locale'): LocaleServiceLike | undefined
  /**
   * @param name - Any other service name. The result is untyped: the caller casts the one
   *   member it uses, so a harness-side rename surfaces here rather than in the page.
   * @returns The service, or `undefined`.
   */
  get(name: string): unknown
  /**
   * Mount a child fiber that activates once every named service exists, and is re-activated
   * when a provider replaces one.
   *
   * The right sidebar's tab registry arrives through this rather than a one-shot `get`,
   * because a base product package may load after this plugin and an eager probe taken at
   * activation would then be permanently `undefined` — a tab type that never exists.
   *
   * @param deps - Service names the registration waits for.
   * @param callback - The registration, receiving the child context.
   * @returns The harness's handle for the child fiber.
   */
  inject?(deps: readonly string[], callback: (scope: ClientContext) => void): unknown
}

/** One guide entry a tab type offers, as the right sidebar renders it. */
export interface SidebarRightGuideEntryLike {
  /** Stable entry identity within its provider. */
  readonly id: string
  /** Ascending position among every registered type's entries. */
  readonly order: number
  /** @returns The capsule's title in the current language. */
  readonly title: () => string
  /** @returns One line on what picking the capsule opens. */
  readonly description?: () => string
}

/**
 * One tab type's static face, as this plugin registers it.
 *
 * The fields mirror the harness's own `SidebarRightTabDefinition`; only the members this
 * plugin sets are declared, so an upstream rename shows up as a missing capability rather
 * than as a silently unopenable tab.
 */
export interface SidebarRightTabDefinitionLike {
  /** This implementation's identity; the key its body registers under. */
  readonly id: string
  /** Type discriminator; what `openTab` names and an address routes to. */
  readonly kind: string
  /** `extension` by default: a type from outside the product outranks the shipped ones. */
  readonly priority?: 'extension' | 'builtin' | 'fallback'
  /**
   * @param address - The address being opened.
   * @returns The tab chip's initial text.
   */
  readonly title: (address: string) => string
  /** Entry boxes for the guide page. */
  readonly guide?: readonly SidebarRightGuideEntryLike[]
}

/** The slice of the harness right-sidebar tab registry this plugin calls. */
export interface SidebarRightTabsLike {
  /**
   * @param definition - The type's static face.
   * @returns A disposer that unregisters the type.
   */
  register(definition: SidebarRightTabDefinitionLike): SlotDisposer
}

/** The slice of the harness layout service the "open the Agents panel" action calls. */
export interface LayoutServiceLike {
  /**
   * @param id - The `main` panel id to select.
   */
  selectPanel?: (id: string) => void
}

/** Cordis activation dependencies. `locale` is probed, not required, so a headless composition still loads. */
export const inject = ['slots']

/**
 * Register every browser surface.
 *
 * @param ctx - The client context.
 * @returns A disposer that tears the plugin down; the harness also disposes each
 *   `ctx.effect` and `slots.inject` on unload, so this is belt-and-braces for a
 *   manual (test) teardown.
 */
export function apply(ctx: ClientContext): SlotDisposer {
  const api = new RpcClient()

  ctx.effect(() => installStyles(), 'mutiagent: stylesheet')
  ctx.effect(() => installLocale(ctx.get('locale')), 'mutiagent: locale dictionaries')

  // One stream for the whole plugin. While it is down the fallback poll re-reads the
  // two lists the mesh panel is built from and bumps the revision, which is what makes
  // every mounted page re-query; EventSource reconnects by itself, and `onopen` stops
  // the poll.
  ctx.effect(
    () =>
      subscribeMeshEvents({
        poll: async signal => {
          await Promise.all([
            api.runsList({ limit: 50 }, { signal }),
            api.sessionsPartitions({ limit: RENDER_CAP }, { signal }),
          ])
          meshRevisionStore.update(revision => revision + 1)
        },
      }),
    'mutiagent: mesh event stream',
  )

  const disposers: SlotDisposer[] = [
    // Agent switcher in the composer, right of the access-mode switcher. Guarded by
    // `slots.inject`, so a client without the conversation package simply never mounts it.
    ctx.slots.inject('conversation.input.right', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.right',
          id: COMPOSER_AGENT_ID,
          order: 10,
          // The session id arrives through the inject face, which is how a session-scoped
          // slot hands an occupant the conversation it belongs to.
          inject: (sessionId: string) => ({ api, sessionId }),
        },
        AgentSelect,
      ),
    ),
    // Agent Sessions: the panel row and the page it addresses.
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: SESSIONS_PANEL_ID,
          order: 30,
          label: () => t('sessions.panel'),
        },
        AgentsGlyph,
      ),
    ),
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: SESSIONS_PANEL_ID,
          inject: () => ({ api }),
        },
        SessionsView,
      ),
    ),
    // Orchestration: the second panel row and its page.
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: MESH_PANEL_ID,
          order: 31,
          label: () => t('mesh.panel'),
        },
        MeshGlyph,
      ),
    ),
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: MESH_PANEL_ID,
          inject: () => ({ api }),
        },
        MeshView,
      ),
    ),
    // A settings page, only where a settings shell declares the seat. This is the
    // reason the settings surfaces live under `settings.section` and never touch the
    // sidebar's `sidebar.settings` seat.
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: SETTINGS_SECTION_ID,
          order: 60,
          label: () => t('settings.panel'),
          inject: () => ({ api }),
        },
        SettingsSection,
      ),
    ),
    // Toast stack: failure visibility that outlives whichever panel started the work.
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: TOASTS_ID }, ToastStack),
    ),
    // Capabilities: a panel row and a page, the same shape as the other two panels, because a
    // right-sidebar tab *type* is not discoverable on its own — the sidebar renders tabs that
    // are already open, so a type with no visible guide entry is invisible in practice.
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: CAPABILITIES_PANEL_ID,
          order: 32,
          label: () => t('caps.panel'),
        },
        CapabilitiesGlyph,
      ),
    ),
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: CAPABILITIES_PANEL_ID,
          inject: () => ({ api }),
        },
        CapabilitiesPage,
      ),
    ),
    // Capabilities: a tab type of our own in the right sidebar, whose body follows the
    // conversation's bound agent. Stage two — the body — lives under the definition's own id
    // in the keyed `sidebar.right.pane.tab` seat; stage one is registered below, because the
    // tab registry is an optional surface that may load after this plugin.
    ctx.slots.inject('sidebar.right.pane.tab', () => {
      const layout = ctx.get('layout') as LayoutServiceLike | undefined
      const openPanel =
        typeof layout?.selectPanel === 'function'
          ? (id: string): void => {
              layout.selectPanel?.(id)
            }
          : undefined
      return ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: CAPABILITIES_TAB_ID,
          inject: (sessionId: string) => ({
            api,
            sessionId,
            ...(openPanel === undefined ? {} : { openPanel }),
          }),
        },
        CapabilitiesBody,
      )
    }),
  ]

  registerCapabilitiesTabType(ctx)
  // The harness's own `/` menu gains a group carrying the bound agent's skills; the group is
  // ours, per conversation, and replaces nothing.
  registerAgentMenuSource(ctx, api)

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Register the Capabilities tab type (stage one of a tab type's two-stage registration).
 *
 * Deliberately not a `ctx.get('sidebarRightTabs')` probe at activation time: the right
 * sidebar is a base product package that activates on its own schedule, so a snapshot taken
 * here would be `undefined` in exactly the compositions where the tab should appear. The
 * child fiber waits for the service and is disposed with this plugin.
 *
 * A failure is reported and contained: a tab type this plugin could not register costs the
 * tab and nothing else, because every other surface is already mounted by the time this
 * runs.
 *
 * @param ctx - The client context.
 */
function registerCapabilitiesTabType(ctx: ClientContext): void {
  const register = (scope: ClientContext): void => {
    const tabs = scope.get('sidebarRightTabs') as SidebarRightTabsLike | undefined
    if (tabs === undefined) return
    try {
      scope.effect(
        () =>
          tabs.register({
            id: CAPABILITIES_TAB_ID,
            kind: CAPABILITIES_TAB_ID,
            priority: 'extension',
            title: () => t('capabilities.tab'),
            guide: [
              {
                id: CAPABILITIES_TAB_ID,
                order: 70,
                title: () => t('capabilities.tab'),
                description: () => t('capabilities.subtitle'),
              },
            ],
          }),
        'mutiagent: capabilities tab type',
      )
    } catch (cause) {
      console.error(
        'mutiagent: the capabilities tab type was not registered:',
        cause instanceof Error ? cause.message : cause,
      )
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['sidebarRightTabs'], register)
      return
    } catch {
      // Fall through to the direct probe below.
    }
  }
  register(ctx)
}
