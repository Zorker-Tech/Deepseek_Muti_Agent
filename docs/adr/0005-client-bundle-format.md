# ADR-0005 — Client bundle format and build face

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

A `dsh` client plugin is not an ordinary npm module. `ClientModuleRegistry` scans live
Loader rows for a `dsh.client` manifest block, composes a boot graph, and serves the
package's `./client` export at `/plugins/??<pkg>/client.js&rev=<rev>`. The browser's
module system executes that file, which must:

1. call `window.__ModuleLoader__.load({ id, factory })` where `id` is exactly the
   package name in the graph row;
2. be a **synchronous CJS closure** whose body ends with `return module.exports` — the
   factory receives a `require` that resolves only **module-table seed words** plus
   already-materialized plugin modules, and throws on a cycle;
3. `require('react')` (and any other baseline word) rather than bundling its own copy;
4. declare any non-baseline runtime import in `dsh.client.external`, and must not
   value-import an undeclared workspace package (a purity gate rejects it in-tree).

The module-table baseline is exactly:
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
`zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
`@deepseek-ai/dsh-client-ui-dockkit`.

The in-tree emitter (`clientBundle()` in `packages/client/tsdown.client.ts`) produces
`format: 'cjs'` with a banner opening the factory and a footer `return module.exports; })`
— but it is a repo-internal helper, not a published tool.

## Decision

MutiAgent builds its client bundle with **esbuild**, replicating the documented envelope
exactly and keeping the dependency surface at the baseline minimum:

1. **Source**: TypeScript ESM under `packages/plugin/src/client/`.
2. **Bundle**: `esbuild` → `format: 'cjs'`, `platform: 'browser'`, `target: 'es2022'`,
   `bundle: true`, `jsx: 'automatic'`, `jsxImportSource: 'react'` — with a JSX transform
   that resolves to the module table's React (no second React is ever shipped).
3. **Externals**: every specifier in the module-table baseline, plus any
   `@deepseek-ai/*` specifier, are externalized and left as literal `require(...)` calls.
   MutiAgent's client depends on **`react` and `react/jsx-runtime` only**; everything else
   (styling, icons, primitives) is implemented locally so no `dsh.client.external` row is
   needed and the bundle can never be broken by a harness-side module-graph change.
4. **Envelope**: banner `window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {`
   and footer `return module.exports; } });` — byte-compatible with the in-tree emitter.
5. **Exports**: the client entry exports `{ inject, apply }`; the harness's Loader
   activates `apply(ctx)` in the browser Cordis tree.
   The banner also defines the CommonJS globals the bundle assigns its exports to:
   `const module = { exports: {} }; const exports = module.exports;`. The harness's own
   rolldown-based emitter supplies an equivalent; esbuild's CJS output does not, and
   without it the factory throws `module is not defined` **at materialization** — the
   plugin's whole UI disappears from the page while the host half keeps working and
   reports nothing. This is why a structural check of the served bytes is not enough and
   `scripts/verify-client-bundle.mjs` materializes the bundle instead.
6. **Styles**: no CSS file, no bundler CSS pipeline. Each component-local stylesheet is a
   TypeScript string constant injected as a single `<style data-plugin="…">` element
   inside `apply`, registered with `ctx.effect` for disposal. All colors, radii,
   elevations and typography come from the harness's `--dsw-*` custom properties, so the
   plugin follows the user's theme (light/dark) with no theme selector of its own.
7. **Localization**: strings live in typed `zh`/`en` dictionaries; they are registered
   with the harness's locale service through a *guarded* call when the service exists,
   and otherwise served from the local dictionary. No visible copy is hardcoded in a
   component.
8. **Host face is a separate artifact** (`lib/index.js`, ESM, Node) from the same
   package; `package.json` declares `exports['.']` (host) and `exports['./client']`
   (browser factory), plus `dsh.bundle.patch` and `dsh.client`.

## Consequences

**Positive**

- The client bundle is self-contained, small, and depends on nothing that can disappear.
- We follow the harness's theming tokens, so light/dark and radius changes are inherited.
- No build-time coupling to harness tooling; the same build runs in CI with only esbuild.

**Negative / accepted costs**

- We own the envelope. If upstream changes the factory contract, the symptom is a page
  that fails to register the module; mitigated by a build-time verification script
  (`scripts/verify-client-bundle.mjs`) that asserts the banner/footer and the absence of
  non-external bare imports.
- Hand-written CSS instead of CSS Modules: no scoping by construction, so class names are
  namespaced with a `ma-` prefix and the injected sheet is single-instance per plugin.
- We cannot use `ui-primitives` React components despite them being in the module table,
  because their prop contracts are in-tree types. The visual language is matched by
  tokens instead. Revisit if the harness publishes a stable primitive contract.

## Alternatives considered

- **Import `clientBundle()` from the harness repo.** Rejected: it is not a published
  package and would make our build depend on a harness checkout path.
- **Bundle React.** Rejected: two React instances in one page break hooks and context;
  the module table exists precisely to prevent this.
- **Add `dsh.client.external` requests for `ui-primitives`/`ui-slots`.** Rejected for
  v0.1: it widens the compatibility surface for cosmetic reuse. Reconsidered when we need
  a control the tokens alone cannot express.
- **Ship the client as a dynamically evaluated Cordis package** (through
  `ctx.dynamicCordisRunner`/`cordis-client-runner`, which evaluate source in the page).
  Rejected for the product path: definitions are session-scoped and process-local, so the
  plugin would have to be redefined each boot; it is the right mechanism for scratch
  authoring, not for an installed feature.
