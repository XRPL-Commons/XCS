# Web app migration to Nuxt UI 4

Date: 2026-09-22
Status: approved design, pending implementation plan
Scope: `apps/web` only

## Goal

Rebuild the `apps/web` presentation layer on Nuxt UI 4 and Tailwind CSS 4 so the XCS site is
structured like the other XRPL Commons Nuxt applications (`starter.2026.04`, `merch`,
`forge/ui`), while keeping the current XCS visual identity, the French-default i18n, the strict
nonce-based Content Security Policy, and every route, workflow, locale key and business behavior
unchanged.

## Decisions already taken

| Decision            | Choice                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| Visual direction    | Keep the current XCS identity (paper/ink/sage palette, serif display)   |
| CSP                 | Relax `style-src-attr` only; keep nonce, strict-dynamic, report-only    |
| Lint and formatting | Keep root Prettier; add `@nuxt/eslint` with stylistic rules disabled    |
| Delivery            | One branch, all 17 pages converted, legacy CSS removed in the same PR   |
| Page construction   | Nuxt UI primitives plus a small XCS component kit for repeated patterns |

## Current state (audit summary)

- Nuxt 4.5 with the `app/` directory, Vue 3.5, `@nuxtjs/i18n` 10 (`fr` default, `en`,
  `prefix_except_default`), `nuxt-security` 2.6 with a strict report-only CSP.
- No Nuxt UI, no Tailwind, no layouts, no `error.vue`, no `app.config.ts`, no ESLint.
- Styling is a 1,621-line global `app/assets/css/main.css` (about 120 classes) plus scoped
  `<style>` blocks in `issue.vue`, `schemas/register.vue` and `credentials/[generationId].vue`.
- 17 pages, 7 components, 3 composables, 23 utils. Business logic (wallet, journal, evidence,
  payload publication, readiness) lives entirely in composables and utils and never touches the
  DOM.
- 23 Vitest files cover utils and composables in a node environment. Playwright covers the pilot
  flow (`e2e/pilot.spec.ts`, `developers.spec.ts`, `wallet-menu.spec.ts`) and the security
  headers (`security.spec.ts`, `security.production.spec.ts`).
- The e2e suite locates elements mostly by `data-testid` (155 uses) and role (61 uses). Twelve
  locators use CSS classes, five use element ids on form controls, and one checks the landing
  hero bounding box against the install command block.

## Architecture

### Dependencies

Added to `apps/web/package.json`:

- `@nuxt/ui` `^4.11.1` (brings Tailwind CSS 4, Reka UI, `@nuxt/icon`, `@nuxt/fonts`,
  `@nuxtjs/color-mode`)
- `@iconify-json/lucide`, `@iconify-json/simple-icons`
- `@nuxt/eslint`, `eslint-config-prettier` (dev)

Nothing is removed. `xrpl`, `xrpl-connect`, `@xcs-protocol/core`, `@xcs-protocol/sdk`,
`@nuxtjs/i18n` and `nuxt-security` stay at their current versions.

### Nuxt configuration

`nuxt.config.ts` keeps every existing runtime, security and Vite setting and adds:

```ts
modules: ['@nuxt/eslint', '@nuxt/ui', '@nuxtjs/i18n', 'nuxt-security'],
ui: { fonts: false },
icon: { mode: 'svg' },
colorMode: { preference: 'light', fallback: 'light', classSuffix: '' },
eslint: { config: { stylistic: false } },
```

- `ui.fonts: false` disables `@nuxt/fonts`. The identity uses system font stacks, so no font is
  downloaded at build time and the Docker build needs no network access for fonts. `font-src
'self'` remains valid.
- `icon.mode: 'svg'` renders icons as inline SVG so no un-nonced `<style>` tag is injected.
- The CSP `style-src-attr` directive changes from `'none'` to `'unsafe-inline'`. Reka UI and
  Floating UI position overlays through inline `style` attributes. All other directives, the
  nonce, `'strict-dynamic'`, report-only mode and the `private, no-store` render hook are
  unchanged.

### File layout

```
apps/web/
  eslint.config.mjs               withNuxt(prettierConfig)
  app/
    app.vue                       <UApp :locale="uiLocale"><NuxtLayout><NuxtPage /></NuxtLayout></UApp>
    app.config.ts                 ui.colors and per-component slot overrides
    error.vue                     UApp + UError, localized title, noindex
    layouts/default.vue           skip link, UHeader, UNavigationMenu, actions, UMain, UFooter
    assets/css/main.css           @import "tailwindcss"; @import "@nuxt/ui"; @theme static; base rules
    composables/useUiLocale.ts    maps the i18n locale to the @nuxt/ui/locale object
    components/                   kit (below) plus the rewritten existing components
    pages/                        same 17 files, templates rewritten, scripts unchanged
```

Deleted: the legacy content of `main.css` and the three scoped `<style>` blocks.

### Theme

`main.css` defines the identity as Tailwind theme tokens inside `@theme static`:

- `--color-neutral-50…950`: a warm gray scale from paper `#fbfbf8` to ink `#080b0f`, passing
  through line `#dde1e3` and muted `#626b75`.
- `--color-primary-50…950`: a sage scale around `#9fb2a8`, `#8fa99c` (focus ring) and `#24342f`.
- `--color-success-*`, `--color-warning-*`, `--color-error-*`: scales derived from the current
  mint `#e1efe7`, warning `#fff3cd` and danger `#fee6e5` tints.
- `--font-sans`: the current Inter stack. `--font-display`: the current Iowan Old Style serif
  stack, applied to `h1`, `h2` and `h3`.

`:root` maps `--ui-bg`, `--ui-bg-elevated`, `--ui-border`, `--ui-text`, `--ui-text-muted` to
paper, card white, line, ink and muted so every Nuxt UI component inherits the identity.

`app.config.ts` sets `ui.colors` (`primary: 'primary'`, `neutral: 'neutral'`) and slot overrides:
rounded corners at the current radius, `UCard` without shadow and with the line border,
`UButton` solid neutral as the primary action (ink background, white text) and outline neutral as
the secondary, `UBadge` tones for the status pill, `UFormField` labels in the current weight.

Color mode is forced light. No dark theme is designed.

### Layout and navigation

`layouts/default.vue`:

- Skip link to `#main-content` (kept for accessibility and the e2e suite).
- Sticky `UHeader` with the brand mark and `UNavigationMenu` items Explorer (`/schemas`), Create
  (`/studio`), Verify (`/verify`), Docs (`/developers`), rendered through `NuxtLinkLocale`
  targets. The primary navigation carries `data-testid="primary-nav"`.
- Header actions: `ExplorerSearch compact`, a `USelect` locale switcher bound to `setLocale`,
  and `WalletButton`.
- `UMain` wrapping `<slot />` with `id="main-content"` and `tabindex="-1"`.
- `UFooter` with the summary paragraph and the secondary links (schemas, create, docs, activity,
  status, XRPL Standards).

The root element keeps `data-client-ready` toggled on mount, because the e2e suite waits for it.

### i18n

`@nuxtjs/i18n` configuration and both locale files are unchanged. `useUiLocale` returns the `fr`
or `en` object from `@nuxt/ui/locale` for the active locale and `app.vue` passes it to `UApp`, so
Nuxt UI component strings follow the site language.

### Wallet menu

`WalletButton` becomes a trigger `UButton` (`data-testid="wallet-toggle"`) with a
`UDropdownMenu`. Each item renders a wallet with `data-wallet-choice`, `data-wallet-id` and
`data-credential-support` attributes, the availability label, and either a select action or a
setup link. The connect error renders in a `StatusBox` next to the control. Escape closes the menu
and returns focus to the trigger, which the dropdown provides natively.

## Component kit

Eight thin components in `app/components/`. Each wraps one repeated pattern, forwards attributes
(so `data-testid` and `id` pass through) and holds no business logic.

| Component          | Built on                                                                     | Replaces                                                  |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `PageHeader`       | `UPageHeader`: eyebrow, title, lead, actions                                 | `.eyebrow` + `h1` + `.lead`, `.page-heading`              |
| `StatusBox`        | `UAlert`, prop `tone: error/warning/success/notice`, `role="alert"` on error | `.error-box` `.warning-box` `.success-box` `.notice-box`  |
| `StatusPill`       | `UBadge` with the existing tone mapping                                      | `.status-pill`                                            |
| `MetadataList`     | `<dl>` grid; default slot of `dt`/`dd`                                       | `.metadata-list` `.compact-metadata` `.explorer-metadata` |
| `VerificationGrid` | four labeled `StatusPill`s and trust note                                    | `.verification-grid`                                      |
| `JsonBlock`        | `UCard` with `<pre>` and optional copy button                                | bare `<pre>` blocks                                       |
| `Pagination`       | first and next `UButton`s                                                    | `.pagination`                                             |
| `EmptyState`       | `UEmpty`, optional loading variant with `role="status"`                      | `.empty-state` `.loading-state`                           |

Existing components rewritten on the kit with identical props, emits and test IDs:
`CodeSnippet`, `TransactionPreview`, `BusinessFinality`, `ExplorerError` (adds
`data-testid="explorer-error"`), `ExplorerSearch` (adds `data-testid="explorer-search"`).

## Page mapping

Every page keeps its `<script setup>` block as is. Only templates change.

- **Forms** (`issue`, `accept`, `revoke`, `schemas/register`, `verify`, `developers`): one `UCard`
  per form card; `UFormField` with `UInput`, `USelect`, `UTextarea` or `UCheckbox` for every
  control. Control `id` attributes are preserved (`schema-uid`, `subject`, `claims`, `schema-json`,
  `https-url`, `payload-storage-mode`, `verify-generation`, `developer-generation-id`, and the
  others) because the e2e suite and labels use them. Guided/JSON editor toggles become `UTabs`.
  The verify advanced lookup becomes `UCollapsible`. Guided claim rows and schema field rows use
  `UFieldGroup` rows with a remove `UButton`.
- **Explorer** (`index`, `schemas/index`, `schemas/[uid]`, `search`, `activity`,
  `transactions/[hash]`, `credentials/[generationId]`, `status`): `UPageGrid` with `UPageCard`
  links for schema cards and search results (`data-testid="result-card"`), `MetadataList` for
  evidence, `UTimeline` for the credential timeline, a `UPageGrid` of stat cards on the landing
  page. The landing hero keeps its photograph, `data-testid="landing-hero"` on the section and
  `data-testid="install-command"` on the command block, with the same visual order so the
  bounding-box test still holds.
- **Create** (`studio`): two primary `UPageCard`s (`data-testid="create-primary-card"`) and three
  secondary ones.
- **Docs** (`developers`, `learn`): `UPageSection`s, the quickstart form as above, `JsonBlock`
  and `CodeSnippet` for examples.
- **Operations**: one `UCard` per journal entry (`data-testid="operation-card"`) with `UButton`
  actions.

Button conventions: primary action = `UButton` solid neutral; secondary = outline neutral; text
action = `variant="link"`; compact = `size="sm"`.

## Security

- Only `style-src-attr` changes, to `'unsafe-inline'`. `securityAssertions.ts` expects the new
  value. `docs/known-limitations.md` gains one sentence stating that inline style attributes are
  allowed for UI positioning and that script nonces with `'strict-dynamic'` remain the XSS control.
- Every `<script>` and `<style>` tag in the SSR document must still carry the nonce. Tailwind
  emits an external stylesheet in production; in development, Vite injects styles through the
  client runtime as it does today for `main.css`. The security e2e suite, run in both development
  and production modes, is the acceptance check.
- No new network origin is introduced: icons and Tailwind output are bundled, fonts are system
  stacks.

## Lint, format, build

- `apps/web/eslint.config.mjs` = `withNuxt(eslintConfigPrettier)`. `stylistic` is disabled in the
  module options so no rule conflicts with the root Prettier configuration (no semicolons, single
  quotes, trailing commas, width 100).
- `apps/web/package.json` scripts: `lint` becomes
  `NODE_ENV=development XCS_BROWSER_E2E=0 XCS_LOCAL_PAYLOAD_STORE=0 nuxt prepare && eslint . && NODE_ENV=development XCS_BROWSER_E2E=0 XCS_LOCAL_PAYLOAD_STORE=0 nuxt typecheck`.
  The `nuxt prepare` prefix generates the git-ignored `.nuxt/eslint.config.mjs` that
  `eslint.config.mjs` imports, so lint works on a clean checkout. `pnpm verify` at the root
  therefore runs ESLint through Turbo without any root change.
- Production build is unchanged in shape: `nuxt build` with `XCS_BROWSER_E2E=0` and
  `XCS_LOCAL_PAYLOAD_STORE=0`, then `node .output/server/index.mjs`.

## Testing and validation

- Unit tests: unchanged. They cover utils and composables only.
- E2E: the twelve class-based locators move to the `data-testid` values listed above. Wallet menu
  assertions use role-based queries on the dropdown (`menu`, `menuitem`) instead of `#wallet-menu`
  and `aria-expanded`. Everything else stays.
- Required green before merge, in this order: `pnpm install`, `pnpm --filter @xcs-protocol/web
lint`, `pnpm --filter @xcs-protocol/web test`, `pnpm --filter @xcs-protocol/web build`,
  `pnpm test:e2e` (pilot plus security suites), then the production Docker image for the web
  service built and started with the Compose `site` profile per AGENTS.md, because Tailwind and
  Nuxt UI change the dependency graph that `pnpm deploy --legacy` prunes.
- `pnpm audit --prod` and the license policy in `security.yml` must still pass with the new
  dependencies (MIT, ISC and CC0 licensed).

## Documentation

- `apps/web/README.md`: add a short "UI stack" paragraph naming Nuxt UI 4, `main.css` theme
  tokens, `app.config.ts` and the component kit. The implemented site map is unchanged.
- `docs/known-limitations.md`: the CSP sentence above.

## Out of scope

- Any change to routes, navigation entries, wording, locale keys, wallet adapters, readiness,
  journal or verification behavior.
- Dark mode.
- Component-level test tooling (`@nuxt/test-utils`).
- Changes to `apps/api`, `apps/indexer`, `packages/*`, Compose files, Dockerfile or CI workflows.
- Adopting the XRPL Commons brand fonts and palette.
