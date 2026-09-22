# Web App Migration to Nuxt UI 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `apps/web` presentation layer on Nuxt UI 4 and Tailwind CSS 4 with the current XCS identity, keeping every route, script block, locale key, test ID and security property, and add DigitalOcean App Platform deployment support for the web app.

**Architecture:** Nuxt UI 4 is added as a module; the hand-written stylesheet is replaced by Tailwind theme tokens and Nuxt UI semantic variables; a layout, an error page and an eight-piece component kit carry the repeated XCS patterns; every page keeps its `<script setup>` and gets a new template built from Nuxt UI primitives and the kit. A root `Dockerfile` and a root `.env.example` (web contract) make the repo compatible with `gh deploy-setup`; the Compose contract moves to `.env.compose.example`.

**Tech Stack:** Nuxt 4.5, Nuxt UI 4.11 (Tailwind CSS 4, Reka UI, @nuxt/icon), @nuxtjs/i18n 10, nuxt-security 2.6, @nuxt/eslint + eslint-config-prettier, Vitest, Playwright, Docker.

**Spec:** `docs/superpowers/specs/2026-09-22-web-nuxt-ui-migration-design.md`

## Global Constraints

- Only `apps/web` changes, plus: root `Dockerfile`, root `.env.example` / `.env.compose.example`, `.gitignore`, `docs/runbooks/deployment.md`, `docs/runbooks/indexer.md`, `docs/known-limitations.md`.
- `@nuxt/ui` `^4.11.1`; `@nuxt/eslint` latest 1.x; `eslint-config-prettier` latest; `@iconify-json/lucide`, `@iconify-json/simple-icons` latest.
- Nuxt config additions exactly: `modules: ['@nuxt/eslint', '@nuxt/ui', '@nuxtjs/i18n', 'nuxt-security']`, `ui: { fonts: false, colorMode: false }`, `icon: { mode: 'svg' }`, `eslint: { config: { stylistic: false } }`.
- CSP: only `style-src-attr` changes, from `["'none'"]` to `["'unsafe-inline'"]`.
- Every page keeps its `<script setup lang="ts">` block byte-for-byte unless a task says otherwise. Only templates and `<style scoped>` blocks change; every `<style scoped>` block is deleted.
- Every existing `data-testid`, form control `id`, `role`, `aria-*` and `data-*` attribute in a template is preserved. New test IDs listed per task are added.
- Prettier (root config: no semicolons, single quotes, trailing commas, width 100) formats every touched file: run `pnpm exec prettier --write <files>` before committing.
- Commit after every task on branch `web-nuxt-ui-migration`; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Working directory for all commands: `/Users/lucbocahut/xrpl/XCS` unless stated.

### Conversion rules (apply in every page task)

| Legacy markup                                                                                        | New markup                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<section class="section-wrap ...">` page root                                                       | `<UContainer class="py-10 sm:py-14">` (keep `<article>` for learn.vue: `<UContainer as="article" ...>`)                                                    |
| `<p class="eyebrow">X</p><h1>T</h1><p class="lead">L</p>`                                            | `<PageHeader eyebrow="X" :title="T" :lead="L" />`                                                                                                          |
| `.page-heading` (heading + side actions)                                                             | `<PageHeader ...><template #actions>…</template></PageHeader>`                                                                                             |
| `<div class="form-card form-grid">…`                                                                 | `<UCard class="mb-6"><div class="grid gap-5">…</div></UCard>`                                                                                              |
| `<article class="form-card">` / `<section class="evidence-card">` / `.result-card` / `.preview-card` | `<UCard class="mb-6">` with `<template #header><h2 class="text-xl font-semibold">…</h2></template>` when the card starts with an `h2`                      |
| `<label for="x">L</label><input id="x" …>`                                                           | `<UFormField label="L"><UInput id="x" … /></UFormField>` (same for `USelect`, `UTextarea`)                                                                 |
| `<select>` with static `<option>`s                                                                   | `<USelect v-model="…" :items="[{ label, value }]" />`                                                                                                      |
| `<input type="checkbox">` inside a label                                                             | `<UCheckbox v-model="…" :label="text" />` or `:model-value` + `@update:model-value` when the legacy markup used `:checked` + `@change`                     |
| `<button class="button">`                                                                            | `<UButton color="neutral" variant="solid">`                                                                                                                |
| `<button class="button secondary">`                                                                  | `<UButton color="neutral" variant="outline">`                                                                                                              |
| `compact` modifier                                                                                   | add `size="sm"`                                                                                                                                            |
| `<button class="text-button">` / `<a class="text-link">`                                             | `<UButton color="neutral" variant="link" class="px-0">`                                                                                                    |
| `<NuxtLinkLocale class="button …">`                                                                  | `<UButton :to="localePath('/path')" …>` (add `const localePath = useLocalePath()` at the top of the script block: this is the one permitted script change) |
| `.error-box` / `.warning-box` / `.success-box` / `.notice-box`                                       | `<StatusBox tone="error                                                                                                                                    | warning | success | notice">` |
| `<p class="loading-state" role="status">`                                                            | `<EmptyState loading />`                                                                                                                                   |
| `.empty-state`                                                                                       | `<EmptyState>text</EmptyState>`                                                                                                                            |
| `<dl class="metadata-list">` / `.explorer-metadata`                                                  | `<MetadataList>` (keep `data-testid` if present)                                                                                                           |
| `<dl class="compact-metadata">`                                                                      | `<MetadataList compact>`                                                                                                                                   |
| `.verification-grid` (four `article`s + note)                                                        | `<VerificationGrid :report="x.report" />`                                                                                                                  |
| `<pre>{{ json }}</pre>`                                                                              | `<JsonBlock :code="json" />`                                                                                                                               |
| `<nav class="pagination">`                                                                           | `<Pagination :first-to="…" :has-next="…" @next="nextPage" />`                                                                                              |
| `<p class="muted">`                                                                                  | `<p class="text-sm text-muted">`                                                                                                                           |
| `<p class="neutrality-note">` / `.verification-note`                                                 | `<p class="text-sm text-toned border-l-2 border-accented pl-3">`                                                                                           |
| `<p class="form-hint">`                                                                              | use the `help` prop of `UFormField`, or `<p class="text-sm text-muted">` outside a field                                                                   |
| `.button-row`                                                                                        | `<div class="flex flex-wrap gap-3">`                                                                                                                       |
| `.definition-grid`                                                                                   | `<div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">` with `<UCard>` per item                                                                           |
| `.status-pill`                                                                                       | unchanged component name `StatusPill` (rewritten in Task 3)                                                                                                |
| `.sr-only`                                                                                           | Tailwind `sr-only`                                                                                                                                         |

Class-based Playwright locators that must keep working via new test IDs: `explorer-error`, `explorer-search`, `result-card`, `primary-nav`, `create-primary-card`, `landing-hero`, `landing-art`, `install-command`, `explorer-metadata`. `.error-box` locators become `getByTestId('status-error')`: every `StatusBox tone="error"` without its own `data-testid` gets `data-testid="status-error"` automatically (Task 3).

---

## File map

Created:

- `apps/web/eslint.config.mjs` — ESLint flat config: Nuxt + Prettier compatibility.
- `apps/web/app/app.config.ts` — Nuxt UI color aliases and slot overrides.
- `apps/web/app/error.vue` — error page.
- `apps/web/app/layouts/default.vue` — header, navigation, actions, main, footer.
- `apps/web/app/composables/useUiLocale.ts` — maps i18n locale to Nuxt UI locale.
- `apps/web/app/components/PageHeader.vue`, `StatusBox.vue`, `MetadataList.vue`, `VerificationGrid.vue`, `JsonBlock.vue`, `Pagination.vue`, `EmptyState.vue` — kit.
- `Dockerfile` (root) — web app image for App Platform.
- `.env.compose.example` (root) — the former Compose contract.

Modified:

- `apps/web/package.json`, `apps/web/nuxt.config.ts`, `apps/web/app/app.vue`, `apps/web/app/assets/css/main.css` (replaced), `apps/web/app/components/*.vue` (rewritten), all 17 pages (templates), `apps/web/e2e/securityAssertions.ts`, `apps/web/e2e/pilot.spec.ts`, `apps/web/e2e/security.production.spec.ts`, `apps/web/README.md`, `docs/known-limitations.md`, `docs/runbooks/deployment.md`, `docs/runbooks/indexer.md`, `.env.example` (replaced), `.gitignore`.

---

### Task 1: Dependencies, Nuxt config, ESLint

**Files:**

- Modify: `apps/web/package.json`
- Modify: `apps/web/nuxt.config.ts`
- Create: `apps/web/eslint.config.mjs`

**Interfaces:**

- Produces: Nuxt UI auto-imported components (`U*`), `useLocalePath`, ESLint through `pnpm --filter @xcs-protocol/web lint`.

- [ ] **Step 1: Add dependencies**

```bash
cd /Users/lucbocahut/xrpl/XCS
pnpm --filter @xcs-protocol/web add @nuxt/ui@^4.11.1 @iconify-json/lucide @iconify-json/simple-icons
pnpm --filter @xcs-protocol/web add -D @nuxt/eslint eslint-config-prettier
```

Expected: `apps/web/package.json` lists the five packages; `pnpm-lock.yaml` updated.

- [ ] **Step 2: Update `nuxt.config.ts`**

Replace the `modules` line and add the `ui`, `icon` and `eslint` keys right after `devtools`:

```ts
  devtools: { enabled: false },
  modules: ['@nuxt/eslint', '@nuxt/ui', '@nuxtjs/i18n', 'nuxt-security'],
  ui: {
    // System font stacks: no build-time font download, font-src 'self' stays valid.
    fonts: false,
    // Light only. Also avoids the color-mode inline script in the SSR head.
    colorMode: false,
  },
  icon: {
    // Inline SVG: no per-icon <style> tag competes with the CSP nonce.
    mode: 'svg',
  },
  eslint: {
    config: {
      // Prettier owns formatting for the whole monorepo.
      stylistic: false,
    },
  },
```

Remove the old `modules: ['@nuxtjs/i18n', 'nuxt-security'],` line.

- [ ] **Step 3: Create `apps/web/eslint.config.mjs`**

```js
// @ts-check
import eslintConfigPrettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(eslintConfigPrettier, {
  ignores: ['.output/**', 'playwright-report/**', 'test-results/**'],
})
```

- [ ] **Step 4: Update the `lint` script**

In `apps/web/package.json` change:

```json
"lint": "NODE_ENV=development XCS_BROWSER_E2E=0 XCS_LOCAL_PAYLOAD_STORE=0 nuxt typecheck",
```

to:

```json
"lint": "eslint . && NODE_ENV=development XCS_BROWSER_E2E=0 XCS_LOCAL_PAYLOAD_STORE=0 nuxt typecheck",
```

- [ ] **Step 5: Prepare and lint**

```bash
pnpm --filter @xcs-protocol/web exec nuxt prepare
pnpm --filter @xcs-protocol/web lint
```

Expected: ESLint runs (fix any reported problems in existing code with the smallest change: unused variables, `vue/*` rules) and typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/nuxt.config.ts apps/web/eslint.config.mjs pnpm-lock.yaml
git commit -m "Add Nuxt UI 4 and ESLint to the web app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Theme, app shell, layout, error page, locale bridge

**Files:**

- Replace: `apps/web/app/assets/css/main.css`
- Create: `apps/web/app/app.config.ts`
- Modify: `apps/web/app/app.vue`
- Create: `apps/web/app/layouts/default.vue`
- Create: `apps/web/app/error.vue`
- Create: `apps/web/app/composables/useUiLocale.ts`

**Interfaces:**

- Produces: Tailwind colors `neutral`, `sage`, `success`, `warning`, `error`; fonts `font-sans`, `font-display`, `font-mono`; Nuxt UI aliases `primary=sage`, `neutral=neutral`; `useUiLocale(): ComputedRef<Locale>`.
- Consumes: `ExplorerSearch` and `WalletButton` (rewritten in Task 3; they keep their names).

- [ ] **Step 1: Replace `main.css` entirely**

```css
@import 'tailwindcss';
@import '@nuxt/ui';

@theme static {
  --font-sans:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-display:
    'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, ui-serif, serif;
  --font-mono: 'SFMono-Regular', Consolas, monospace;

  /* Warm gray: paper (50) to ink (950). */
  --color-neutral-50: #fbfbf8;
  --color-neutral-100: #f3f3ef;
  --color-neutral-200: #dde1e3;
  --color-neutral-300: #c5cacd;
  --color-neutral-400: #9aa2a9;
  --color-neutral-500: #626b75;
  --color-neutral-600: #4a525a;
  --color-neutral-700: #30363c;
  --color-neutral-800: #1c2126;
  --color-neutral-900: #101418;
  --color-neutral-950: #080b0f;

  /* Sage accent: mint (100), sage (300), focus ring (400), sage-dark (900). */
  --color-sage-50: #f1f6f3;
  --color-sage-100: #e1efe7;
  --color-sage-200: #c7ddd1;
  --color-sage-300: #9fb2a8;
  --color-sage-400: #8fa99c;
  --color-sage-500: #6f8f80;
  --color-sage-600: #55705f;
  --color-sage-700: #3f5549;
  --color-sage-800: #2f423a;
  --color-sage-900: #24342f;
  --color-sage-950: #142019;

  --color-success-50: #f1f6f3;
  --color-success-100: #e1efe7;
  --color-success-200: #c7ddd1;
  --color-success-300: #9fb2a8;
  --color-success-400: #6f8f80;
  --color-success-500: #55705f;
  --color-success-600: #3f5549;
  --color-success-700: #2f423a;
  --color-success-800: #24342f;
  --color-success-900: #1a2721;
  --color-success-950: #101814;

  --color-warning-50: #fffbeb;
  --color-warning-100: #fff3cd;
  --color-warning-200: #fde68a;
  --color-warning-300: #f5d76e;
  --color-warning-400: #e8c04a;
  --color-warning-500: #c9a227;
  --color-warning-600: #a3801d;
  --color-warning-700: #7c6116;
  --color-warning-800: #5c4811;
  --color-warning-900: #3f320c;
  --color-warning-950: #241c06;

  --color-error-50: #fef2f2;
  --color-error-100: #fee6e5;
  --color-error-200: #fbc9c7;
  --color-error-300: #f4a3a0;
  --color-error-400: #e97772;
  --color-error-500: #d5524c;
  --color-error-600: #b53c37;
  --color-error-700: #922f2b;
  --color-error-800: #742723;
  --color-error-900: #5a211e;
  --color-error-950: #33100e;
}

/* Nuxt UI semantic variables mapped to the XCS identity (unlayered: wins over the module's @layer theme). */
:root {
  --ui-radius: 0.45rem;
  --ui-container: 80rem;
  --ui-header-height: 6rem;
  --ui-bg: var(--color-neutral-50);
  --ui-bg-muted: var(--color-neutral-100);
  --ui-bg-elevated: #ffffff;
  --ui-bg-accented: var(--color-neutral-200);
  --ui-bg-inverted: var(--color-neutral-950);
  --ui-border: var(--color-neutral-200);
  --ui-border-muted: var(--color-neutral-200);
  --ui-border-accented: var(--color-neutral-300);
  --ui-border-inverted: var(--color-neutral-950);
  --ui-text-dimmed: var(--color-neutral-400);
  --ui-text-muted: var(--color-neutral-500);
  --ui-text-toned: var(--color-neutral-600);
  --ui-text: var(--color-neutral-950);
  --ui-text-highlighted: var(--color-neutral-950);
  --ui-text-inverted: #ffffff;
}

@layer base {
  html {
    scroll-behavior: smooth;
  }
  body {
    min-width: 320px;
    background: var(--ui-bg);
    color: var(--ui-text);
    font-family: var(--font-sans);
  }
  h1,
  h2,
  h3 {
    font-family: var(--font-display);
    letter-spacing: -0.02em;
  }
  ::selection {
    background: #bdcec5;
    color: var(--ui-text);
  }
  code,
  pre {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  :where(a, button, input, textarea, select, summary):focus-visible {
    outline: 3px solid var(--color-sage-400);
    outline-offset: 3px;
  }
}
```

- [ ] **Step 2: Create `app.config.ts`**

```ts
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'sage',
      secondary: 'neutral',
      success: 'success',
      info: 'sage',
      warning: 'warning',
      error: 'error',
      neutral: 'neutral',
    },
    button: {
      slots: { base: 'rounded-[0.45rem] font-semibold' },
      defaultVariants: { color: 'neutral', variant: 'solid' },
      compoundVariants: [
        {
          color: 'neutral',
          variant: 'solid',
          class: 'bg-neutral-950 text-white hover:bg-neutral-800 disabled:bg-neutral-950',
        },
        {
          color: 'neutral',
          variant: 'outline',
          class: 'bg-white text-neutral-950 ring-neutral-300 hover:bg-neutral-100',
        },
      ],
    },
    card: {
      slots: {
        root: 'rounded-[0.6rem] bg-elevated ring-default shadow-none',
        header: 'p-5 sm:px-6',
        body: 'p-5 sm:p-6',
        footer: 'p-5 sm:px-6',
      },
    },
    badge: { slots: { base: 'rounded-full font-semibold' } },
    alert: { slots: { root: 'rounded-[0.6rem]' } },
    input: { slots: { root: 'w-full' }, defaultVariants: { size: 'lg' } },
    textarea: { slots: { root: 'w-full' }, defaultVariants: { size: 'lg' } },
    select: { slots: { base: 'w-full' }, defaultVariants: { size: 'lg' } },
    formField: { slots: { label: 'font-semibold text-default' } },
    pageHeader: {
      slots: {
        root: 'border-b-0 py-0',
        headline: 'text-xs font-semibold uppercase tracking-[0.2em] text-muted',
        title: 'font-display text-4xl tracking-tight sm:text-5xl',
        description: 'max-w-3xl text-lg text-toned',
      },
    },
    pageCard: { slots: { root: 'rounded-[0.6rem] shadow-none' } },
  },
})
```

- [ ] **Step 3: Create `composables/useUiLocale.ts`**

```ts
import { en, fr } from '@nuxt/ui/locale'

/** Nuxt UI component strings follow the site locale managed by @nuxtjs/i18n. */
export function useUiLocale() {
  const { locale } = useI18n()
  return computed(() => (locale.value === 'en' ? en : fr))
}
```

- [ ] **Step 4: Replace `app.vue`**

```vue
<script setup lang="ts">
const uiLocale = useUiLocale()
</script>

<template>
  <UApp :locale="uiLocale">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
```

- [ ] **Step 5: Create `layouts/default.vue`**

```vue
<script setup lang="ts">
const { locale, locales, setLocale, t } = useI18n()
const localePath = useLocalePath()
const clientReady = ref(false)

const localeItems = computed(() =>
  locales.value.map((item) =>
    typeof item === 'string'
      ? { label: item, value: item }
      : { label: item.name, value: item.code },
  ),
)

const navigation = computed(() => [
  { label: t('nav.explorer'), to: localePath('/schemas') },
  { label: t('nav.create'), to: localePath('/studio') },
  { label: t('nav.verify'), to: localePath('/verify') },
  { label: t('nav.docs'), to: localePath('/developers') },
])

const footerLinks = computed(() => [
  { label: t('nav.schemas'), to: localePath('/schemas') },
  { label: t('nav.create'), to: localePath('/studio') },
  { label: t('nav.docs'), to: localePath('/developers') },
  { label: t('nav.activity'), to: localePath('/activity') },
  { label: t('nav.status'), to: localePath('/status') },
])

onMounted(() => {
  clientReady.value = true
})
</script>

<template>
  <div class="flex min-h-screen flex-col" :data-client-ready="clientReady ? 'true' : 'false'">
    <a
      class="fixed top-3 left-3 z-[100] -translate-y-[150%] rounded-[0.45rem] bg-neutral-950 px-4 py-3 font-bold text-white no-underline focus:translate-y-0"
      href="#main-content"
    >
      {{ $t('nav.skip') }}
    </a>

    <UHeader :ui="{ root: 'bg-default/95 backdrop-blur-lg' }">
      <template #left>
        <NuxtLink
          :to="localePath('/')"
          class="inline-flex items-center gap-3 text-2xl font-extrabold tracking-tight"
          aria-label="XCS home"
        >
          <span
            class="relative size-9 rounded-full bg-neutral-950 after:absolute after:inset-[28%] after:rounded-full after:bg-neutral-50 after:content-['']"
            aria-hidden="true"
          />
          <span>XCS</span>
        </NuxtLink>
      </template>

      <UNavigationMenu :items="navigation" data-testid="primary-nav" :aria-label="$t('nav.main')" />

      <template #right>
        <ExplorerSearch compact class="hidden md:flex" />
        <label class="sr-only" for="locale">{{ $t('nav.language') }}</label>
        <USelect
          id="locale"
          :model-value="locale"
          :items="localeItems"
          size="sm"
          class="w-28"
          @update:model-value="setLocale($event as 'fr' | 'en')"
        />
        <WalletButton />
      </template>

      <template #body>
        <UNavigationMenu :items="navigation" orientation="vertical" class="-mx-2.5" />
        <ExplorerSearch compact class="mt-4" />
      </template>
    </UHeader>

    <UMain id="main-content" tabindex="-1" class="flex-1 outline-none">
      <slot />
    </UMain>

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">{{ $t('footer.summary') }}</p>
      </template>
      <nav class="flex flex-wrap gap-x-5 gap-y-2 text-sm" :aria-label="$t('footer.navigation')">
        <NuxtLink
          v-for="link in footerLinks"
          :key="link.to"
          :to="link.to"
          class="text-muted hover:text-default"
        >
          {{ link.label }}
        </NuxtLink>
        <a
          class="text-muted hover:text-default"
          href="https://github.com/XRPLF/XRPL-Standards"
          rel="noreferrer"
        >
          XRPL Standards
        </a>
      </nav>
    </UFooter>
  </div>
</template>
```

- [ ] **Step 6: Create `error.vue`**

```vue
<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const uiLocale = useUiLocale()
const localePath = useLocalePath()
const is404 = computed(() => props.error.statusCode === 404)

useSeoMeta({ title: () => `${props.error.statusCode} — XCS`, robots: 'noindex' })
</script>

<template>
  <UApp :locale="uiLocale">
    <UContainer class="flex min-h-screen flex-col items-center justify-center py-16 text-center">
      <p class="font-display text-7xl font-semibold text-sage-700">{{ error.statusCode }}</p>
      <h1 class="mt-4 text-3xl font-semibold">
        {{ is404 ? $t('explorer.errors.notFound') : $t('explorer.errors.unavailable') }}
      </h1>
      <p v-if="!is404" class="mt-3 text-sm text-muted">
        {{ $t('explorer.errors.unavailableHint') }}
      </p>
      <UButton
        class="mt-8"
        :to="localePath('/')"
        @click="clearError({ redirect: localePath('/') })"
      >
        XCS
      </UButton>
    </UContainer>
  </UApp>
</template>
```

Check `apps/web/i18n/locales/en.json` for `explorer.errors.notFound`; if that key does not exist use `explorer.errors.unavailable` for both branches (do not add locale keys).

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @xcs-protocol/web lint
```

Expected: PASS (pages still compile; they are unstyled until Tasks 4–7).

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write apps/web/app
git add apps/web/app
git commit -m "Replace the web stylesheet with Nuxt UI theme tokens, layout and error page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Component kit and rewritten components

**Files:**

- Create: `apps/web/app/components/PageHeader.vue`, `StatusBox.vue`, `MetadataList.vue`, `VerificationGrid.vue`, `JsonBlock.vue`, `Pagination.vue`, `EmptyState.vue`
- Rewrite: `apps/web/app/components/StatusPill.vue`, `CodeSnippet.vue`, `TransactionPreview.vue`, `BusinessFinality.vue`, `ExplorerError.vue`, `ExplorerSearch.vue`, `WalletButton.vue`

**Interfaces (produced, used by Tasks 4–7):**

- `PageHeader` props `{ eyebrow?: string; title: string; lead?: string }`, slots `actions`, `default`.
- `StatusBox` props `{ tone?: 'error' | 'warning' | 'success' | 'notice'; title?: string }`, default slot. Falls through `data-testid`; `tone="error"` sets `role="alert"` and, when no `data-testid` attr is given, `data-testid="status-error"`.
- `StatusPill` props `{ value: string }` (unchanged).
- `MetadataList` props `{ compact?: boolean }`, default slot of `<dt>`/`<dd>` pairs.
- `VerificationGrid` props `{ report: { onChain: string; schema: string; payload: string; issuerTrust: string }; testIdPrefix?: string; note?: boolean }` (`note` default `true`).
- `JsonBlock` props `{ code: string }`.
- `Pagination` props `{ firstTo?: string; hasNext: boolean }`, emit `next`.
- `EmptyState` props `{ loading?: boolean }`, default slot.
- `CodeSnippet`, `TransactionPreview`, `BusinessFinality`, `ExplorerError`, `ExplorerSearch`, `WalletButton`: same props and emits as today.

- [ ] **Step 1: `PageHeader.vue`**

```vue
<script setup lang="ts">
defineProps<{ eyebrow?: string; title: string; lead?: string }>()
</script>

<template>
  <UPageHeader :headline="eyebrow" :title="title" :description="lead" class="mb-8">
    <template v-if="$slots.actions" #links>
      <div class="flex flex-wrap gap-3">
        <slot name="actions" />
      </div>
    </template>
    <slot />
  </UPageHeader>
</template>
```

- [ ] **Step 2: `StatusBox.vue`**

```vue
<script setup lang="ts">
const props = withDefaults(
  defineProps<{ tone?: 'error' | 'warning' | 'success' | 'notice'; title?: string }>(),
  { tone: 'notice', title: undefined },
)
const attrs = useAttrs()

const color = computed(
  () => ({ error: 'error', warning: 'warning', success: 'success', notice: 'neutral' }) as const,
)
const testId = computed(() =>
  props.tone === 'error' && attrs['data-testid'] === undefined ? 'status-error' : undefined,
)
</script>

<template>
  <UAlert
    :color="color[tone]"
    variant="subtle"
    :title="title"
    :role="tone === 'error' ? 'alert' : undefined"
    :data-testid="testId"
    :data-tone="tone"
    class="mb-4"
  >
    <template #description>
      <div class="space-y-2 text-sm [&_code]:font-mono">
        <slot />
      </div>
    </template>
  </UAlert>
</template>
```

Vue merges `attrs['data-testid']` over the bound `:data-testid` when both exist, so an explicit test ID always wins.

- [ ] **Step 3: `StatusPill.vue`** (keep the tone lists exactly)

```vue
<script setup lang="ts">
const props = defineProps<{ value: string }>()
const color = computed(() => {
  if (['active', 'valid', 'trusted', 'ready', 'accepted', 'created'].includes(props.value)) {
    return 'success'
  }
  if (['tampered', 'invalid', 'untrusted', 'deleted', 'halted', 'rejected'].includes(props.value)) {
    return 'error'
  }
  if (
    [
      'pending',
      'unavailable',
      'unknown',
      'not_checked',
      'starting',
      'catching_up',
      'expired',
    ].includes(props.value)
  ) {
    return 'warning'
  }
  return 'neutral'
})
</script>

<template>
  <UBadge :color="color" variant="subtle" :label="value" :data-tone="color" class="status-pill" />
</template>
```

- [ ] **Step 4: `MetadataList.vue`**

```vue
<script setup lang="ts">
defineProps<{ compact?: boolean }>()
</script>

<template>
  <dl
    class="grid gap-x-6 gap-y-2 text-sm [&>dd]:m-0 [&>dd]:min-w-0 [&>dd]:break-words [&>dt]:font-semibold [&>dt]:text-muted [&_code]:font-mono [&_code]:text-[0.85em]"
    :class="compact ? 'sm:grid-cols-[auto_1fr]' : 'sm:grid-cols-[12rem_1fr]'"
  >
    <slot />
  </dl>
</template>
```

- [ ] **Step 5: `VerificationGrid.vue`**

```vue
<script setup lang="ts">
withDefaults(
  defineProps<{
    report: { onChain: string; schema: string; payload: string; issuerTrust: string }
    testIdPrefix?: string
    note?: boolean
  }>(),
  { testIdPrefix: undefined, note: true },
)
</script>

<template>
  <div class="my-6">
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <article
        v-for="dimension in [
          { key: 'on-chain', label: $t('verify.onChain'), value: report.onChain },
          { key: 'schema', label: $t('verify.schema'), value: report.schema },
          { key: 'payload', label: $t('verify.payload'), value: report.payload },
          { key: 'trust', label: $t('verify.trust'), value: report.issuerTrust },
        ]"
        :key="dimension.key"
        class="flex items-center justify-between gap-3 rounded-[0.6rem] bg-elevated px-4 py-3 ring-1 ring-default"
        :data-testid="testIdPrefix ? `${testIdPrefix}-${dimension.key}` : undefined"
      >
        <span class="text-sm font-semibold">{{ dimension.label }}</span>
        <StatusPill :value="dimension.value" />
      </article>
    </div>
    <p v-if="note" class="mt-3 border-l-2 border-accented pl-3 text-sm text-toned">
      {{ $t('verify.trustNote') }}
    </p>
  </div>
</template>
```

- [ ] **Step 6: `JsonBlock.vue`**

```vue
<script setup lang="ts">
defineProps<{ code: string }>()
</script>

<template>
  <pre
    class="my-4 overflow-x-auto rounded-[0.6rem] bg-neutral-950 p-4 text-[0.8rem] leading-relaxed whitespace-pre-wrap text-neutral-50"
  ><code>{{ code }}</code></pre>
</template>
```

- [ ] **Step 7: `Pagination.vue`**

```vue
<script setup lang="ts">
defineProps<{ firstTo?: string; hasNext: boolean }>()
defineEmits<{ next: [] }>()
</script>

<template>
  <nav class="mt-8 flex flex-wrap gap-3" :aria-label="$t('explorer.pagination.label')">
    <UButton v-if="firstTo" :to="firstTo" color="neutral" variant="outline" size="sm">
      {{ $t('explorer.pagination.first') }}
    </UButton>
    <UButton v-if="hasNext" color="neutral" variant="outline" size="sm" @click="$emit('next')">
      {{ $t('explorer.pagination.next') }}
    </UButton>
  </nav>
</template>
```

- [ ] **Step 8: `EmptyState.vue`**

```vue
<script setup lang="ts">
defineProps<{ loading?: boolean }>()
</script>

<template>
  <p v-if="loading" class="my-6 text-sm text-muted" role="status">{{ $t('common.loading') }}</p>
  <div
    v-else
    class="my-6 rounded-[0.6rem] border border-dashed border-accented px-6 py-10 text-center text-sm text-muted"
  >
    <slot />
  </div>
</template>
```

- [ ] **Step 9: Rewrite `CodeSnippet.vue` template** (script unchanged)

```vue
<template>
  <UCard class="mb-6">
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-lg font-semibold">{{ title }}</h3>
        <UButton color="neutral" variant="outline" size="sm" @click="copyCode">
          {{ copyLabel }}
        </UButton>
      </div>
    </template>
    <JsonBlock :code="code" class="my-0" />
    <p v-if="copyState === 'copied'" class="mt-3 text-sm text-muted" role="status">
      {{ copiedLabel }}
    </p>
    <p v-else-if="copyState === 'error'" class="mt-3 text-sm text-error" role="status">
      {{ copyErrorLabel }}
    </p>
  </UCard>
</template>
```

- [ ] **Step 10: Rewrite `TransactionPreview.vue` template**

```vue
<template>
  <UCard v-if="transaction" class="mb-6" data-testid="transaction-preview" aria-live="polite">
    <template #header>
      <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">
        {{ $t('transaction.preview') }}
      </p>
      <h2 class="text-xl font-semibold">{{ transaction.TransactionType }}</h2>
    </template>
    <MetadataList>
      <template v-for="(value, key) in transaction" :key="key">
        <dt>{{ key }}</dt>
        <dd>
          <code>{{ typeof value === 'object' ? JSON.stringify(value) : value }}</code>
        </dd>
      </template>
    </MetadataList>
    <StatusBox tone="warning" class="mt-5">{{ $t('transaction.confirmWarning') }}</StatusBox>
    <UButton data-testid="transaction-sign" :disabled="busy" @click="$emit('confirm')">
      {{ busy ? $t('common.working') : $t('transaction.sign') }}
    </UButton>
  </UCard>
</template>
```

- [ ] **Step 11: Rewrite `BusinessFinality.vue` template**

```vue
<template>
  <UCard class="mb-6" data-testid="business-finality">
    <template #header>
      <h2 class="text-xl font-semibold">{{ $t('finality.title') }}</h2>
    </template>
    <StatusBox tone="notice" :title="$t('finality.xrplValidated')" data-testid="xrpl-finality">
      <p>
        <code>{{ txHash }}</code>
      </p>
      <p>{{ engineResult ?? 'tesSUCCESS' }} · ledger {{ ledgerIndex ?? '—' }}</p>
    </StatusBox>
    <StatusBox
      v-if="businessConfirmation === 'confirmed'"
      tone="success"
      :title="$t('finality.xcsConfirmed')"
      data-testid="xcs-confirmed"
    />
    <StatusBox
      v-else-if="businessConfirmation === 'rejected'"
      tone="error"
      :title="$t('finality.xcsRejected')"
      data-testid="xcs-rejected"
    >
      <code v-if="businessEvidence?.reasonCode">{{ businessEvidence.reasonCode }}</code>
    </StatusBox>
    <StatusBox
      v-else-if="businessConfirmation === 'mismatch'"
      tone="error"
      :title="$t('finality.xcsMismatch')"
      data-testid="xcs-mismatch"
    />
    <StatusBox v-else tone="notice" :title="$t('finality.xcsPending')" data-testid="xcs-pending">
      <p>{{ $t('finality.reconfirm') }}</p>
    </StatusBox>
    <MetadataList v-if="businessEvidence" class="mt-5">
      <dt>{{ $t('finality.proofLedger') }}</dt>
      <dd>{{ businessEvidence.ledgerIndex }}</dd>
      <dt>{{ $t('finality.proofLedgerHash') }}</dt>
      <dd>
        <code>{{ businessEvidence.ledgerHash }}</code>
      </dd>
      <dt>{{ $t('finality.proofTransactionIndex') }}</dt>
      <dd>{{ businessEvidence.transactionIndex }}</dd>
      <template v-if="businessEvidence.schemaUid">
        <dt>Schema UID</dt>
        <dd>
          <code>{{ businessEvidence.schemaUid }}</code>
        </dd>
      </template>
      <template v-if="businessEvidence.generationId">
        <dt>Generation ID</dt>
        <dd>
          <code>{{ businessEvidence.generationId }}</code>
        </dd>
      </template>
      <template v-if="businessEvidence.eventType">
        <dt>{{ $t('finality.proofEvent') }}</dt>
        <dd>
          <code>{{ businessEvidence.eventType }}</code>
        </dd>
      </template>
      <template v-if="businessEvidence.deletionCause">
        <dt>{{ $t('finality.proofDeletionCause') }}</dt>
        <dd>
          <code>{{ businessEvidence.deletionCause }}</code>
        </dd>
      </template>
    </MetadataList>
  </UCard>
</template>
```

- [ ] **Step 12: Rewrite `ExplorerError.vue` template**

```vue
<template>
  <StatusBox tone="error" :title="$t(messageKey)" data-testid="explorer-error">
    <p v-if="explorerErrorKind(error) === 'unavailable'">
      {{ $t('explorer.errors.unavailableHint') }}
    </p>
    <UButton v-if="retryable" color="neutral" variant="link" class="px-0" @click="$emit('retry')">
      {{ $t('common.retry') }}
    </UButton>
  </StatusBox>
</template>
```

- [ ] **Step 13: Rewrite `ExplorerSearch.vue` template**

```vue
<template>
  <form
    class="flex w-full items-center gap-2"
    :class="compact ? 'max-w-xs' : 'max-w-2xl'"
    role="search"
    data-testid="explorer-search"
    @submit.prevent="submitSearch"
  >
    <label class="sr-only" :for="compact ? 'global-explorer-search' : 'explorer-search'">
      {{ $t('explorer.search.label') }}
    </label>
    <UInput
      :id="compact ? 'global-explorer-search' : 'explorer-search'"
      v-model="query"
      type="search"
      name="q"
      maxlength="128"
      minlength="2"
      autocomplete="off"
      :autofocus="autofocus"
      :placeholder="$t('explorer.search.placeholder')"
      :size="compact ? 'sm' : 'lg'"
      class="flex-1"
    />
    <UButton type="submit" :size="compact ? 'sm' : 'md'" :disabled="query.trim().length < 2">
      {{ $t('explorer.search.submit') }}
    </UButton>
  </form>
</template>
```

- [ ] **Step 14: Rewrite `WalletButton.vue`**

Replace the whole file. The popover is controlled: Reka only asks to open; discovery decides when it opens.

```vue
<script setup lang="ts">
import type { WalletChoice } from '~/composables/useWallet'

const { account, busy, error, walletChoices, connect, disconnect } = useWallet()
const open = ref(false)
const wallets = ref<WalletChoice[]>([])
const trigger = ref<{ $el?: HTMLElement } | null>(null)
let walletMenuRequest = 0

function focusTrigger(): void {
  const element = trigger.value?.$el
  if (element instanceof HTMLElement) element.focus()
}

async function closeWalletMenu(): Promise<void> {
  walletMenuRequest += 1
  open.value = false
  await nextTick()
  focusTrigger()
}

async function toggle() {
  if (account.value) {
    await disconnect()
    return
  }
  const request = ++walletMenuRequest
  const discoveredWallets = await walletChoices()
  if (request !== walletMenuRequest || account.value) return
  wallets.value = discoveredWallets
  open.value = true
}

function onOpenRequest(next: boolean): void {
  if (next) void toggle()
  else void closeWalletMenu()
}

async function chooseWallet(walletId: string) {
  try {
    await connect(walletId)
    await closeWalletMenu()
  } catch {
    // useWallet exposes the adapter error next to the control.
  }
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-5)}`
}
</script>

<template>
  <div class="relative" @keydown.esc.stop="closeWalletMenu()">
    <UPopover
      :open="open"
      :content="{ side: 'bottom', align: 'end', collisionPadding: 8 }"
      @update:open="onOpenRequest"
    >
      <UButton
        ref="trigger"
        data-testid="wallet-toggle"
        color="neutral"
        :variant="account ? 'outline' : 'solid'"
        size="sm"
        :disabled="busy"
        class="whitespace-nowrap"
      >
        {{ account ? shortAddress(account.address) : $t('wallet.connect') }}
      </UButton>

      <template #content>
        <div v-if="!account" id="wallet-menu" class="w-[min(20rem,calc(100vw-1rem))] space-y-3 p-4">
          <strong class="block text-sm">{{ $t('wallet.choose') }}</strong>
          <div
            v-for="wallet in wallets"
            :key="wallet.id"
            class="flex items-start justify-between gap-3 border-t border-default pt-3"
            :data-wallet-choice="wallet.id"
          >
            <span class="grid gap-0.5 text-sm">
              <strong>{{ wallet.name }}</strong>
              <small class="text-muted">
                {{ $t(wallet.available ? 'wallet.available' : 'wallet.unavailable') }}
              </small>
              <small class="text-muted" :data-credential-support="wallet.credentialSupport">
                {{ $t(`wallet.credentials.${wallet.credentialSupport}`) }}
              </small>
            </span>
            <UButton
              v-if="wallet.available"
              color="neutral"
              variant="link"
              size="sm"
              class="px-0"
              :data-wallet-id="wallet.id"
              @click="chooseWallet(wallet.id)"
            >
              {{ $t('wallet.select') }}
            </UButton>
            <UButton
              v-else-if="wallet.url"
              color="neutral"
              variant="link"
              size="sm"
              class="px-0"
              :data-wallet-id="wallet.id"
              :href="wallet.url"
              rel="noopener noreferrer"
              target="_blank"
            >
              {{ $t('wallet.setup') }}
            </UButton>
          </div>
          <p v-if="wallets.length === 0" class="text-sm text-muted">{{ $t('wallet.none') }}</p>
          <UButton color="neutral" variant="link" size="sm" class="px-0" @click="closeWalletMenu()">
            {{ $t('common.close') }}
          </UButton>
        </div>
      </template>
    </UPopover>
    <p v-if="error" class="absolute top-full right-0 mt-1 text-xs whitespace-nowrap text-error">
      {{ error }}
    </p>
  </div>
</template>
```

- [ ] **Step 15: Typecheck and run the wallet menu e2e**

```bash
pnpm --filter @xcs-protocol/web lint
pnpm --filter @xcs-protocol/web exec playwright test e2e/wallet-menu.spec.ts
```

Expected: lint PASS. The four wallet-menu tests PASS (trigger `aria-expanded`, `#wallet-menu` presence/absence, Escape focus return, 320px fit). If `aria-expanded` is not reported as `"false"` when closed, add `:aria-expanded="open ? 'true' : 'false'"` on the trigger `UButton`.

- [ ] **Step 16: Commit**

```bash
pnpm exec prettier --write apps/web/app/components
git add apps/web/app/components
git commit -m "Add the XCS component kit on Nuxt UI and rewrite shared components

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Explorer pages, group 1

**Files:** templates only of `apps/web/app/pages/index.vue`, `studio.vue`, `learn.vue`, `status.vue`, `activity.vue`, `search.vue`, `schemas/index.vue`.

**Interfaces:** consumes the kit from Task 3 and the conversion rules.

- [ ] **Step 1: `index.vue`**

Keep the hero photograph and order. Template:

```vue
<template>
  <div>
    <section
      class="relative isolate overflow-hidden bg-neutral-950 text-neutral-50"
      aria-labelledby="landing-title"
      data-testid="landing-hero"
    >
      <picture class="absolute inset-0 -z-10" aria-hidden="true" data-testid="landing-art">
        <img
          src="/images/xcs-orbit-hero.jpg"
          alt=""
          width="1672"
          height="941"
          fetchpriority="high"
          decoding="async"
          class="size-full object-cover opacity-60"
        />
      </picture>
      <UContainer class="py-20 sm:py-28">
        <div class="max-w-3xl">
          <p
            class="mb-5 inline-flex items-center gap-2 text-xs font-semibold tracking-[0.2em] uppercase"
          >
            <span class="size-2 rounded-full bg-sage-300" aria-hidden="true" />{{
              $t('home.badge')
            }}
          </p>
          <h1 id="landing-title" class="text-5xl leading-tight tracking-tight sm:text-6xl">
            {{ $t('home.title') }}
          </h1>
          <p class="mt-6 max-w-2xl text-lg text-neutral-200">{{ $t('home.description') }}</p>
          <div class="mt-8 flex flex-wrap gap-3">
            <UButton :to="localePath('/studio')" color="neutral" variant="outline" size="lg">
              <span class="font-mono" aria-hidden="true">&gt;_</span>
              {{ $t('home.start') }}
            </UButton>
            <UButton
              href="https://github.com/XRPL-Commons/XCS"
              target="_blank"
              rel="noopener noreferrer"
              color="neutral"
              variant="ghost"
              size="lg"
              class="text-neutral-50"
            >
              {{ $t('home.github') }} <span aria-hidden="true">↗</span>
            </UButton>
          </div>
          <div
            class="mt-8 inline-flex items-center gap-3 rounded-[0.45rem] bg-neutral-900/80 px-4 py-2 font-mono text-sm ring-1 ring-neutral-700"
            :aria-label="$t('home.commandLabel')"
            data-testid="install-command"
          >
            <span aria-hidden="true">$</span>
            <code>pnpm install</code>
          </div>
        </div>
      </UContainer>
    </section>

    <UContainer class="py-12 sm:py-16" aria-labelledby="network-overview-title">
      <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">
            {{ $t('home.stats.eyebrow') }}
          </p>
          <h2 id="network-overview-title" class="text-3xl">{{ $t('home.stats.title') }}</h2>
        </div>
        <UButton :to="localePath('/status')" color="neutral" variant="link" class="px-0">
          {{ $t('home.stats.status') }}
        </UButton>
      </div>
      <p class="mb-4 max-w-2xl text-toned">{{ $t('home.searchIntro') }}</p>
      <ExplorerSearch />
      <EmptyState v-if="pending" loading />
      <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
      <div v-else-if="stats" class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <UCard
          v-for="stat in [
            { value: stats.schemas.total, label: $t('home.stats.schemas') },
            { value: stats.schemas.publishers, label: $t('home.stats.publishers') },
            { value: stats.credentialGenerations.total, label: $t('home.stats.credentials') },
            { value: stats.checkpoint.ledgerIndex, label: $t('home.stats.ledger') },
          ]"
          :key="stat.label"
        >
          <strong class="block font-display text-3xl">{{ numberFormat.format(stat.value) }}</strong>
          <span class="text-sm text-muted">{{ stat.label }}</span>
        </UCard>
      </div>
    </UContainer>

    <UContainer class="py-12" aria-labelledby="landing-flow-title">
      <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">
        {{ $t('home.flowEyebrow') }}
      </p>
      <h2 id="landing-flow-title" class="mb-6 text-3xl">{{ $t('home.flowTitle') }}</h2>
      <ol class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <li
          v-for="(step, index) in ['schema', 'issue', 'accept', 'verify']"
          :key="step"
          class="rounded-[0.6rem] bg-elevated p-5 ring-1 ring-default"
        >
          <span class="block font-mono text-sm text-muted">0{{ index + 1 }}</span>
          {{ $t(`home.flow.${step}`) }}
        </li>
      </ol>
    </UContainer>

    <UContainer class="py-12">
      <div class="grid gap-4 sm:grid-cols-3">
        <UCard v-for="pillar in ['keys', 'data', 'trust']" :key="pillar">
          <h2 class="text-xl font-semibold">{{ $t(`home.pillars.${pillar}.title`) }}</h2>
          <p class="mt-2 text-sm text-toned">{{ $t(`home.pillars.${pillar}.copy`) }}</p>
        </UCard>
      </div>
    </UContainer>
  </div>
</template>
```

Add `const localePath = useLocalePath()` after `const { locale, t } = useI18n()` in the script block.

- [ ] **Step 2: `studio.vue`**

Add `const localePath = useLocalePath()`. Template: `<UContainer class="py-10 sm:py-14">`, `<PageHeader :eyebrow="$t('nav.create')" :title="$t('studio.title')" :lead="$t('studio.description')" />`, neutrality note paragraph, then a `grid gap-4 sm:grid-cols-2` with two `NuxtLink` cards (`data-testid="create-primary-card"`, classes `block rounded-[0.6rem] p-6 ring-1 ring-default bg-elevated hover:ring-accented`, the second with `bg-neutral-950 text-neutral-50`) each containing the index span, `h2`, `p`, and `strong` CTA exactly as today. Then the secondary heading block and a `grid gap-4 sm:grid-cols-3` of three `NuxtLink` cards to `/accept`, `/revoke`, `/operations` with the numbers 03–05.

- [ ] **Step 3: `learn.vue`**

`<UContainer as="article" class="py-10 sm:py-14">`, `PageHeader eyebrow="XCS 0.1" :title="$t('learn.title')" :lead="$t('learn.intro')"`, `h2` actors, a `grid gap-4 sm:grid-cols-2 lg:grid-cols-3` of six `UCard`s (`h3` + `p`), `h2` verification + paragraph, then `<div class="flex gap-2">` with the three `StatusPill`s.

- [ ] **Step 4: `status.vue`**

`UContainer`, `PageHeader eyebrow="Explorer · Network"`, `EmptyState loading` / `ExplorerError`, then `<div class="flex items-center gap-3"><StatusPill …/><strong>…</strong></div>`, the neutrality note, and `<MetadataList data-testid="explorer-metadata">` with the same `dt`/`dd` rows.

- [ ] **Step 5: `activity.vue`**

`PageHeader` with `#actions` holding `<UButton :to="localePath('/schemas')" variant="outline">`; lead and scope paragraphs; loading/error; `<ol class="grid gap-4">` with each `li` as a `UCard` containing the status row and a `<MetadataList compact>`; `EmptyState` fallback; `<Pagination :first-to="cursor ? localePath('/activity') : undefined" :has-next="Boolean(data?.nextCursor)" @next="nextPage" />` guarded by `v-if="data"`.

- [ ] **Step 6: `search.vue`**

`PageHeader eyebrow="Explorer"`, lead, `<ExplorerSearch :initial-query="query" autofocus />`, loading/error/empty; results as `<div class="grid gap-3">` of `NuxtLink` cards with `data-testid="result-card"` and the same inner content (pill, `h2`, description, `code`, arrow), then `<StatusBox v-if="data.hasMore" tone="warning">`.

- [ ] **Step 7: `schemas/index.vue`**

`PageHeader eyebrow="Registry"` with `#actions` `<UButton :to="localePath('/schemas/register')">`; description; loading/error; `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">` of `NuxtLink` cards (`data-testid="schema-card"`) with pill, `h2`, `p`, `code`, two `small`; `EmptyState`; `Pagination` as in activity with `firstTo` = `localePath('/schemas')`.

- [ ] **Step 8: Verify**

```bash
pnpm exec prettier --write apps/web/app/pages
pnpm --filter @xcs-protocol/web lint
pnpm --filter @xcs-protocol/web exec playwright test e2e/pilot.spec.ts -g "landing|Explorer|explorer|search|activity|status"
```

Expected: lint PASS; listed pilot tests PASS or fail only on locators updated in Task 9 (note which).

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/pages
git commit -m "Rebuild landing, studio, learn, status, activity, search and schema list pages on Nuxt UI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Explorer pages, group 2

**Files:** templates of `apps/web/app/pages/schemas/[uid].vue`, `transactions/[hash].vue`, `credentials/[generationId].vue` (also delete its `<style scoped>`), `operations.vue`.

- [ ] **Step 1: `schemas/[uid].vue`**

`UContainer`; loading/error; then `StatusPill`, `h1` (`class="mt-3 text-4xl"`), lead paragraph, `<MetadataList>` rows, neutrality note, `h2` fields + `<div class="grid gap-2">` rows each `flex flex-wrap gap-3 rounded-[0.45rem] bg-elevated px-4 py-2 ring-1 ring-default` with `code`, `span`, `small`; lineage `ol` with links; `h2` definition + `<JsonBlock :code="JSON.stringify(data.definition, null, 2)" />`; `<UButton :to="localePath(`/issue?schema=${data.uid}`)">`.

- [ ] **Step 2: `transactions/[hash].vue`**

`PageHeader eyebrow="Explorer · XRPL"`; loading/error; `<MetadataList data-testid="explorer-metadata">`; registration `UCard` with header (`h2` + `StatusPill` in a flex row) and `MetadataList`; credential events `UCard` with a `grid gap-4` of `article`s (pill + `MetadataList compact`); `EmptyState`; `Pagination` (`firstTo` = `localePath(`/transactions/${transactionHash}`)` when `cursor`).

- [ ] **Step 3: `credentials/[generationId].vue`**

`PageHeader eyebrow="Explorer · Credential"` with title/lead as today; loading/error; heading actions row `flex flex-wrap items-center gap-3` (pill, copy `UButton outline sm`, status spans, subject action `UButton outline sm` with `data-testid="credential-subject-action"`); `<MetadataList data-testid="explorer-metadata">`; verification `section` with `<VerificationGrid v-if="activeReview" :report="activeReview.report" test-id-prefix="credential-dimension" data-testid="credential-dimensions" />` else `StatusBox warning data-testid="credential-verification-unavailable"`; payload `UCard` (`aria-labelledby`) containing paragraph, `MetadataList`, the consent block (`data-testid="credential-consent"`) with `StatusBox error` / `UCheckbox data-testid="payload-consent" :model-value="payloadConsentToken !== null" @update:model-value="setPayloadConsent(Boolean($event))"` / fetch `UButton data-testid="payload-fetch"`; `StatusBox success data-testid="credential-payload-checked"`; `StatusBox error` for `verificationError`; claims section with `data-testid="credential-claims"` and per-row `article`s keeping `:data-testid="`credential-claim-${row.name}`"` and `:class="{ 'opacity-60': !row.present }"`; trust `UCard`; timeline as `<UTimeline :items="timelineItems" />` where `timelineItems` is a computed added to the script block:

```ts
const timelineItems = computed(() =>
  (data.value?.detail.timeline ?? []).map((event) => ({
    value: `${event.transactionHash}:${event.nodeIndex}`,
    title: t(`credential.events.${event.eventType}`),
    description: `${t('explorer.ledger', { ledger: event.ledgerIndex })} · tx ${event.transactionIndex}`,
    event,
  })),
)
```

and a `#description` slot override is not needed; render the hash link and pill through the `#title` slot:

```vue
<UTimeline :items="timelineItems" class="mt-4">
  <template #title="{ item }">
    <span class="flex flex-wrap items-center gap-2">
      <StatusPill :value="item.event.eventType" />
      <strong>{{ item.title }}</strong>
    </span>
  </template>
  <template #description="{ item }">
    <p>{{ item.description }}</p>
    <p v-if="item.event.deletionCause"><code>{{ item.event.deletionCause }}</code></p>
    <NuxtLink :to="localePath(`/transactions/${item.event.transactionHash}`)"><code>{{ item.event.transactionHash }}</code></NuxtLink>
  </template>
</UTimeline>
```

(`t` and `localePath` must exist in the script block; add `const localePath = useLocalePath()` if missing. `t` is already destructured from `useI18n()` in this page; check and add if not.) `EmptyState` when the timeline is empty. Delete the `<style scoped>` block.

- [ ] **Step 4: `operations.vue`**

`PageHeader eyebrow="XRPL submission journal"` with `#actions` = export and refresh `UButton outline`; `StatusBox warning` local-only; `StatusBox error` for `pageError`; result message: `<StatusBox v-if="resultMessage" :tone="resultTone === 'error' ? 'error' : resultTone === 'success' ? 'success' : 'notice'">` (check the script's `resultTone` values and map each to a tone); `EmptyState` when no operations; otherwise `<div class="grid gap-4">` of `UCard data-testid="operation-card"` each with a header row (eyebrow + `h2` stage, buttons retry `solid`, reconfirm `outline data-testid="operation-reconfirm"`, abandon `outline`) and `MetadataList` rows unchanged.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec prettier --write apps/web/app/pages
pnpm --filter @xcs-protocol/web lint
git add apps/web/app/pages
git commit -m "Rebuild schema, transaction, credential and operations pages on Nuxt UI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Form pages, group 1 (verify, revoke, accept)

**Files:** templates of `apps/web/app/pages/verify.vue`, `revoke.vue`, `accept.vue`.

- [ ] **Step 1: `revoke.vue` (complete template, the reference for form pages)**

```vue
<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      eyebrow="Credential issuer"
      :title="$t('revoke.title')"
      :lead="$t('revoke.description')"
    />
    <StatusBox tone="warning">{{ $t('revoke.warning') }}</StatusBox>

    <UCard class="mb-6">
      <div class="grid gap-5">
        <UFormField label="Subject">
          <UInput id="revoke-subject" v-model.trim="subject" placeholder="r…" :disabled="busy" />
        </UFormField>
        <UFormField label="Schema UID">
          <UInput
            id="revoke-schema"
            v-model.trim="schemaUid"
            pattern="[0-9a-fA-F]{64}"
            :disabled="busy"
          />
        </UFormField>
        <div>
          <UButton :disabled="busy" @click="buildPreview">
            {{ busy ? $t('common.working') : $t('revoke.review') }}
          </UButton>
        </div>
      </div>
    </UCard>

    <StatusBox v-if="message" tone="error" data-testid="revoke-error" :title="messageDisplay">
      <p v-if="messageIsLocalized">
        <code>{{ message }}</code>
      </p>
    </StatusBox>

    <UCard v-if="credential && report" class="mb-6">
      <template #header>
        <h2 class="text-xl font-semibold">{{ $t('revoke.exactCredential') }}</h2>
      </template>
      <MetadataList>
        <dt>Issuer</dt>
        <dd>
          <code>{{ credential.issuer }}</code>
        </dd>
        <dt>Subject</dt>
        <dd>
          <code>{{ credential.subject }}</code>
        </dd>
        <dt>Schema UID</dt>
        <dd>
          <code>{{ credential.schemaUid }}</code>
        </dd>
        <dt>{{ $t('revoke.state') }}</dt>
        <dd><StatusPill :value="credential.state" /></dd>
        <dt>{{ $t('revoke.expiration') }}</dt>
        <dd>{{ expiration ?? $t('revoke.noExpiration') }}</dd>
        <dt>URI</dt>
        <dd>
          <code>{{ decodedUri ?? '—' }}</code>
        </dd>
        <dt>{{ $t('revoke.generation') }}</dt>
        <dd>
          <code>{{ credential.generationId }}</code>
        </dd>
      </MetadataList>
    </UCard>

    <TransactionPreview :transaction="transaction" :busy="busy" @confirm="submit" />
    <BusinessFinality
      v-if="result"
      :tx-hash="result.txHash"
      :engine-result="result.transactionResult"
      :ledger-index="result.ledgerIndex"
      :business-confirmation="result.businessConfirmation"
      :business-evidence="result.businessEvidence"
    />
    <UButton
      v-if="resultCredentialLink"
      color="neutral"
      variant="outline"
      data-testid="revoke-result-permalink"
      :to="resultCredentialLink"
    >
      {{ $t('revoke.openPermalink') }}
    </UButton>
  </UContainer>
</template>
```

`resultCredentialLink` is already a localized path in the script (built through `operationLinks`); verify by reading the script and, if it is not localized, wrap with `localePath(...)`.

- [ ] **Step 2: `verify.vue`**

Same structure. The generation lookup form: `<UCard as="form" novalidate @submit.prevent="openGeneration">` containing `<UFormField :label="$t('verify.generationLabel')" :help="$t('verify.generationHint')" :error="generationLookupError || undefined">` with a `flex gap-2` row of `UInput id="verify-generation" … :aria-describedby="generationLookupError ? 'verify-generation-error' : undefined"` and `UButton type="submit"`. Keep `<p v-if="generationLookupError" id="verify-generation-error" role="alert" class="text-sm text-error">` inside the field after the row (the e2e reads `#verify-generation-error`). Advanced lookup: `<UCollapsible :default-open="Boolean(issuer || subject || schemaUid)" class="mb-6"><UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" block>{{ $t('verify.advancedTitle') }} <small class="text-muted">{{ $t('verify.advancedDescription') }}</small></UButton><template #content><UCard class="mt-3">…three UFormFields (ids verify-issuer, verify-subject, verify-schema) + load button…</UCard></template></UCollapsible>`. Then `StatusBox error` for `error`; the review `UCard` with `MetadataList` and `<VerificationGrid :report="review.report" />`; the consent `StatusBox warning` block with `UCheckbox`; keep every existing `data-testid` in the remainder of the template (read the current file for the full list: `payload-consent`, `payload-fetch`, any `verify-*`).

- [ ] **Step 3: `accept.vue`**

Same structure. Action selector: `<UFormField :label="$t('accept.action')"><USelect id="subject-action" v-model="action" :items="[{ label: $t('accept.acceptAction'), value: 'accept' }, { label: $t('accept.rejectAction'), value: 'reject' }, { label: $t('accept.removeAction'), value: 'remove' }]" :disabled="busy" /></UFormField>`; inputs `issuer` and `accept-schema`; primary button with the same three-way label. Error `StatusBox data-testid="accept-error"`. Review `UCard` with `MetadataList`, `<VerificationGrid v-if="acceptanceReview" :report="acceptanceReview.report" />`, consent `StatusBox warning` containing `StatusBox error` or `<UCheckbox data-testid="payload-consent" :model-value="payloadConsent" :disabled="busy" :label="$t(payloadUsesLocalStore ? 'accept.localPayloadConsent' : 'accept.payloadConsent')" @update:model-value="setPayloadConsent(Boolean($event))" />`; issuer trust block `StatusBox warning data-testid="issuer-trust-acknowledgement"` with `UCheckbox :model-value="issuerTrustAcknowledgementToken !== null" @update:model-value="setIssuerTrustAcknowledgement(Boolean($event))"`; claims `JsonBlock` / error / digest line; block reason and safety `StatusBox`es; `TransactionPreview`, `BusinessFinality`, permalink `UButton data-testid="subject-result-permalink"`. Preserve every other `data-testid` found in the current file.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec prettier --write apps/web/app/pages
pnpm --filter @xcs-protocol/web lint
git add apps/web/app/pages
git commit -m "Rebuild verify, revoke and accept pages on Nuxt UI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Form pages, group 2 (issue, register, developers)

**Files:** templates of `apps/web/app/pages/issue.vue` (delete `<style scoped>`), `schemas/register.vue` (delete `<style scoped>`), `developers.vue`.

- [ ] **Step 1: `issue.vue`**

Root, `PageHeader`, `StatusBox warning` no-PII. Form `UCard` with fields `schema-uid`, `subject`; claims toolbar → `<UTabs v-model="claimsEditorMode" :items="[{ label: $t('issue.guidedMode'), value: 'guided' }, { label: $t('issue.jsonMode'), value: 'json' }]" :content="false" size="sm" />` (read the current toolbar for the exact label keys and any third button such as "load schema" which stays a `UButton outline sm`); guided claims as one `UFormField` per field with `:for="`claim-${field.name}`"` label, `USelect` for boolean/enum types and `UInput` otherwise, ids `claim-<name>` preserved; `StatusBox error` for `guidedClaimsError`; JSON mode `UTextarea id="claims" rows="12"`; local payload store block (`USelect id="payload-storage-mode"`, `StatusBox warning` with `UCheckbox v-model="localStoreAcknowledged"` and its button); `https-url` field; `expiration` field; build button. Error `StatusBox data-testid="issue-error"`. Canonical payload `UCard` with `JsonBlock`, download `UButton outline`, `StatusBox success data-testid="local-payload-stored"`, checking/proof boxes. Then `TransactionPreview`, `BusinessFinality`, and the links card (`UCard`) with the accept and permalink links as `UButton outline` keeping their `data-testid`s (read the file: `issue-accept-link`, `issue-credential-link` or similar).

- [ ] **Step 2: `schemas/register.vue`**

Editor mode toggle → `<UTabs :model-value="editorMode" :items="[{ label: $t('register.guidedMode'), value: 'guided' }, { label: $t('register.jsonMode'), value: 'json' }]" :content="false" size="sm" :disabled="pageBusy" @update:model-value="selectEditorMode($event as 'guided' | 'json')" />`. Template buttons as `UButton variant="link"`. Fields `schema-name` (`UInput`), `schema-description` (`UTextarea rows="3"`). Guided fields: `<fieldset class="grid gap-3"><legend class="font-semibold">…</legend>` with one row per field: `<div class="grid gap-3 sm:grid-cols-[1fr_10rem_auto_auto] sm:items-end">` holding `UFormField` name `UInput`, `UFormField` type `USelect :items="GUIDED_SCHEMA_FIELD_TYPES.map((type) => ({ label: type, value: type }))"`, `UCheckbox v-model="field.optional" :label="$t('register.optional')"`, remove `UButton variant="link"`; add-field `UButton outline sm`. JSON mode `UTextarea id="schema-json" rows="18"`. Remaining blocks (errors, preview, `TransactionPreview`, `BusinessFinality`, result links) follow the rules; preserve all `data-testid`s present in the current file.

- [ ] **Step 3: `developers.vue`**

`UContainer`, `PageHeader :eyebrow="$t('nav.docs')"`. Runtime `UCard` with `MetadataList compact` (keep `data-testid="developer-api-base"`, `developer-profile-id`) and `StatusBox error` for `profileError`. Tools: `grid gap-4 sm:grid-cols-3` of `UCard`s (REST with `UButton outline sm :href="apiDocumentationUrl" rel="noreferrer"`, SDK, CLI). Quickstart section: eyebrow/`h2`/intro, `<ol class="list-decimal pl-5">`, the generation form as `<UCard as="form" @submit.prevent="loadGeneration">` with `UFormField label="Generation ID" :help="$t('developers.quickstart.exactOnly')"` + `UInput id="developer-generation-id" data-testid="developer-generation-input" …` + `UButton type="submit" data-testid="developer-load-generation"`; `StatusBox error data-testid="developer-error"`; evidence `UCard data-testid="developer-evidence"` with `MetadataList compact` and note; local payload form `UCard as="form"` with `UTextarea id="developer-local-payload" data-testid="developer-payload-input" rows="12"`, `StatusBox warning` transmission, `UButton type="submit" data-testid="developer-verify-payload"`; then every remaining section of the current template (verification result, snippets via `CodeSnippet`, signer boundary, route catalog lists) converted with the rules, preserving every `data-testid`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec prettier --write apps/web/app/pages
pnpm --filter @xcs-protocol/web lint
pnpm --filter @xcs-protocol/web test
git add apps/web/app/pages
git commit -m "Rebuild issue, schema registration and developers pages on Nuxt UI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: CSP relaxation, security assertions, documentation

**Files:**

- Modify: `apps/web/nuxt.config.ts` (`'style-src-attr'`)
- Modify: `apps/web/e2e/securityAssertions.ts:15`
- Modify: `docs/known-limitations.md` (CSP bullet)
- Modify: `apps/web/README.md` (new "UI stack" paragraph after the first paragraph)

- [ ] **Step 1: nuxt.config**

Change `'style-src-attr': ["'none'"],` to:

```ts
        // Reka UI and Floating UI position overlays through inline style attributes.
        // Script execution stays nonce-gated with 'strict-dynamic'.
        'style-src-attr': ["'unsafe-inline'"],
```

- [ ] **Step 2: securityAssertions**

Change `'style-src-attr': ["'none'"],` to `'style-src-attr': ["'unsafe-inline'"],`.

- [ ] **Step 3: known-limitations**

Append to the bullet that starts with "Nitro emits the initial browser CSP in report-only mode":

```
  Inline `style` attributes are allowed (`style-src-attr 'unsafe-inline'`) because the Nuxt UI
  component library positions menus, popovers and toasts through them; script execution remains
  nonce-gated with `'strict-dynamic'`, which is the XSS control.
```

- [ ] **Step 4: web README**

Insert after the first paragraph:

```
## UI stack

The site is built on Nuxt UI 4 and Tailwind CSS 4. The XCS identity lives in
`app/assets/css/main.css` (theme tokens and Nuxt UI semantic variables) and `app/app.config.ts`
(component defaults). Repeated XCS patterns are the small kit in `app/components/` (`PageHeader`,
`StatusBox`, `StatusPill`, `MetadataList`, `VerificationGrid`, `JsonBlock`, `Pagination`,
`EmptyState`); pages compose Nuxt UI primitives with it and keep their workflow logic in
`composables/` and `utils/`.
```

- [ ] **Step 5: Run the security suites**

```bash
pnpm --filter @xcs-protocol/web exec playwright test e2e/security.spec.ts
pnpm --filter @xcs-protocol/core build && pnpm --filter @xcs-protocol/sdk build
XCS_BROWSER_E2E=0 XCS_LOCAL_PAYLOAD_STORE=0 pnpm --filter @xcs-protocol/web build
pnpm --filter @xcs-protocol/web test:e2e:security
```

Expected: PASS. If a `<style>` tag without nonce appears, identify its origin (Nuxt UI colors plugin uses `useHead`, which nuxt-security stamps; a failure means another source) and fix at the source, never by relaxing `style-src`.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write docs/known-limitations.md apps/web/README.md apps/web/e2e/securityAssertions.ts apps/web/nuxt.config.ts
git add apps/web/nuxt.config.ts apps/web/e2e/securityAssertions.ts docs/known-limitations.md apps/web/README.md
git commit -m "Allow inline style attributes for Nuxt UI overlays and document the UI stack

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Playwright locator updates and full pilot run

**Files:**

- Modify: `apps/web/e2e/pilot.spec.ts` (lines 689, 694, 711, 729–730, 739, 744, 748, 808, 824, 840, 843, 892, 919, 975, 1001, 1725)
- Modify: `apps/web/e2e/security.production.spec.ts:45`

- [ ] **Step 1: Replace class locators**

| Old                                                                                  | New                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page.locator('.explorer-search').filter({ has: page.locator('#explorer-search') })` | `page.getByTestId('explorer-search').filter({ has: page.locator('#explorer-search') })`                                                                                                                                                                                               |
| `page.locator('.result-card')`                                                       | `page.getByTestId('result-card')`                                                                                                                                                                                                                                                     |
| `page.locator('.primary-nav')`                                                       | `page.getByTestId('primary-nav')`                                                                                                                                                                                                                                                     |
| `page.locator('.create-primary-card[href$="/schemas/register"]')`                    | `page.getByTestId('create-primary-card').filter({ has: page.locator('[href$="/schemas/register"]') }).or(page.locator('[data-testid="create-primary-card"][href$="/schemas/register"]'))` — simpler: `page.locator('[data-testid="create-primary-card"][href$="/schemas/register"]')` |
| `page.locator('.create-primary-card[href$="/issue"]')`                               | `page.locator('[data-testid="create-primary-card"][href$="/issue"]')`                                                                                                                                                                                                                 |
| `page.locator('.landing-art img')`                                                   | `page.getByTestId('landing-art').locator('img')`                                                                                                                                                                                                                                      |
| `page.locator('.landing-hero')`                                                      | `page.getByTestId('landing-hero')`                                                                                                                                                                                                                                                    |
| `page.locator('.install-command')`                                                   | `page.getByTestId('install-command')`                                                                                                                                                                                                                                                 |
| `page.locator('.explorer-error')`                                                    | `page.getByTestId('explorer-error')`                                                                                                                                                                                                                                                  |
| `page.locator('.error-box')`                                                         | `page.getByTestId('status-error')` (if a test expects a page-specific error box such as `issue-error`, use that ID instead; read the surrounding lines)                                                                                                                               |
| `page.locator('.explorer-metadata')`                                                 | `page.getByTestId('explorer-metadata')`                                                                                                                                                                                                                                               |
| `page.locator('.testnet-banner, .controlled-pilot-banner')`                          | `page.getByTestId('testnet-banner')` (no element carries it; `toHaveCount(0)` still holds)                                                                                                                                                                                            |

- [ ] **Step 2: Run the whole browser gate**

```bash
pnpm test:e2e
```

Expected: every test in `pilot.spec.ts`, `developers.spec.ts`, `wallet-menu.spec.ts`, `security.spec.ts` and the production security suite passes. Fix template regressions at the source (missing test ID, wrong tone) rather than loosening a test.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write apps/web/e2e
git add apps/web/e2e
git commit -m "Point browser tests at test IDs instead of legacy CSS classes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: DigitalOcean App Platform support for the web app

**Files:**

- Create: `Dockerfile` (root)
- Rename: `.env.example` → `.env.compose.example`; create new `.env.example` (web contract)
- Modify: `.gitignore` (add `!.env.compose.example`), `.dockerignore` (add `!.env.compose.example` after `!.env.example`)
- Modify: `docs/runbooks/deployment.md` (new section "DigitalOcean App Platform for the web app"; two `.env.example` references), `docs/runbooks/indexer.md:5`

**Interfaces:** the contract names are exactly the `NUXT_*` variables read by `apps/web/nuxt.config.ts` and `docker-compose.yml`'s `web` service.

- [ ] **Step 1: Move the Compose contract**

```bash
git mv .env.example .env.compose.example
```

Add `!.env.compose.example` on its own line after `!.env.example` in `.gitignore` and in `.dockerignore` (after the `!**/.env.example` line as well: `!**/.env.compose.example`).

- [ ] **Step 2: Write the new root `.env.example`**

```dotenv
# Contract for the web app on DigitalOcean App Platform (gh deploy-setup).
# Names only; values live in Passbolt. The Compose stack contract is .env.compose.example.
# Private origin of the XCS read API for server-side rendering (VPC address, never a browser URL).
NUXT_API_BASE_URL=                        # config
# Same value as the API's XCS_INTERNAL_API_TOKEN; 32+ URL-safe characters.
NUXT_API_INTERNAL_TOKEN=                  # generate shared
# Narrow CIDR of the App Platform ingress that rewrites X-Forwarded-For; empty = direct exposure.
NUXT_TRUSTED_PROXY_CIDRS=                 # optional config
# Browser-visible HTTPS origin of the XCS read API.
NUXT_PUBLIC_API_BASE_URL=                 # config
# Network profile served by that API (for example commons-testnet-xcs-v0.1-controlled-pilot).
NUXT_PUBLIC_PROFILE_ID=                   # config
# Public wss:// XRPL submission endpoint; no credentials, no private indexer URL.
NUXT_PUBLIC_RPC_URL=                      # config
# Public Xaman application identifier; enables the Xaman adapter.
NUXT_PUBLIC_XAMAN_API_KEY=                # optional
# Deployment origin with a trailing slash, registered in the Xaman Developer Console.
NUXT_PUBLIC_XAMAN_REDIRECT_URL=           # optional config
# Public Reown project identifier; enables the WalletConnect adapter.
NUXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=    # optional
```

- [ ] **Step 3: Write the root `Dockerfile`**

No BuildKit-only syntax (App Platform builds without cache mounts).

```dockerfile
# Web app image for DigitalOcean App Platform (gh deploy-setup). Build context is the repo root.
# The Compose stack keeps using docker/Dockerfile.node for every service.
FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@10.34.4

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY patches ./patches
COPY packages ./packages
COPY apps ./apps
COPY config ./config

RUN pnpm install --frozen-lockfile
# Builds @xcs-protocol/core and @xcs-protocol/sdk first, then the Nuxt output.
RUN NODE_ENV=production pnpm --filter "@xcs-protocol/web..." build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV NITRO_PORT=3000
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/web/.output ./.output

USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
```

- [ ] **Step 4: Build and run the image locally (AGENTS.md rule)**

```bash
docker build -t xcs-web-app-platform:local .
docker run --rm -d --name xcs-web-check -p 127.0.0.1:3300:3000 \
  -e NUXT_API_BASE_URL=http://127.0.0.1:1 \
  -e NUXT_API_INTERNAL_TOKEN=local-image-check-token-0000000000000001 \
  -e NUXT_PUBLIC_API_BASE_URL=http://127.0.0.1:1 \
  -e NUXT_PUBLIC_PROFILE_ID=local-check \
  -e NUXT_PUBLIC_RPC_URL=wss://s.altnet.rippletest.net:51233 \
  xcs-web-app-platform:local
sleep 3
curl --silent --show-error --dump-header - --output /dev/null http://127.0.0.1:3300/ | head -20
docker logs xcs-web-check | tail -5
docker rm -f xcs-web-check
```

Expected: HTTP 200 with `content-security-policy-report-only`, `cache-control: private, no-store`, `x-frame-options: DENY`; the process runs as `node`. A startup error means a missing runtime variable or the validate plugins rejecting a value; fix the Dockerfile or contract, not the plugins.

- [ ] **Step 5: Docs**

In `docs/runbooks/deployment.md`, change "Copy `.env.example` to `.env`" (line ~251) to "Copy `.env.compose.example` to `.env`"; in `docs/runbooks/indexer.md` line 5 likewise. Add a new `##` section before "## Optional Testnet demo pinning":

```markdown
## DigitalOcean App Platform for the web app

The `gh deploy-setup` extension deploys a single Nuxt service from the repository root: the root
`Dockerfile` builds `@xcs-protocol/web`, and the root `.env.example` is that service's environment
contract (names only; values live in Passbolt). The Compose stack contract is
`.env.compose.example`. Run `gh deploy-setup` from the repository root; accept port `3000`.

The App Platform service hosts only the web app. PostgreSQL, the indexer and the read API keep
running from the Compose stack (or another host) in the same region and VPC:

| App Platform variable                   | Compose counterpart                               |
| --------------------------------------- | ------------------------------------------------- |
| `NUXT_API_BASE_URL`                     | `http://api:3001` → the API's private VPC address |
| `NUXT_API_INTERNAL_TOKEN`               | `XCS_INTERNAL_API_TOKEN_FILE` (same value)        |
| `NUXT_PUBLIC_API_BASE_URL`              | `XCS_PUBLIC_API_BASE_URL`                         |
| `NUXT_PUBLIC_PROFILE_ID`                | `XCS_PUBLIC_PROFILE_ID`                           |
| `NUXT_PUBLIC_RPC_URL`                   | `XCS_PUBLIC_RPC_URL`                              |
| `NUXT_PUBLIC_XAMAN_API_KEY`             | `XCS_PUBLIC_XAMAN_API_KEY`                        |
| `NUXT_PUBLIC_XAMAN_REDIRECT_URL`        | `XCS_PUBLIC_XAMAN_REDIRECT_URL`                   |
| `NUXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` | `XCS_PUBLIC_WALLET_CONNECT_PROJECT_ID`            |
| `NUXT_TRUSTED_PROXY_CIDRS`              | `XCS_TRUSTED_PROXY_CIDRS`                         |

Before the first deploy:

1. Expose the read API over HTTPS on its own hostname for browsers and add the App Platform domain
   to `XCS_ALLOWED_ORIGINS`. Give the web service the API's private VPC address in
   `NUXT_API_BASE_URL`; never reuse the public URL for the SSR hop.
2. Generate `NUXT_API_INTERNAL_TOKEN` through the tool (`# generate shared`) and place the same
   value in `XCS_INTERNAL_API_TOKEN_FILE` on the Compose host.
3. Register the App Platform origin with a trailing slash in the Xaman Developer Console when
   `NUXT_PUBLIC_XAMAN_API_KEY` is set.
4. Determine the address the platform ingress presents to the container (log one request) and set
   `NUXT_TRUSTED_PROXY_CIDRS` to that exact range; leaving it empty collapses every visitor into one
   SSR rate-limit budget behind the ingress.
5. After the first deploy, run the header checks from "Browser security-header rollout" against the
   App Platform domain: exactly one report-only CSP, one HSTS value, `private, no-store` on HTML,
   immutable caching on `/_nuxt/` assets.

The Compose `web` service and the Dockerfile in `docker/` are unchanged; App Platform builds the
root `Dockerfile` on every deploy from the configured branch.
```

- [ ] **Step 6: Verify the Compose model still renders**

```bash
cp .env.compose.example /tmp/xcs-compose-check.env
docker compose --env-file /tmp/xcs-compose-check.env -f docker-compose.yml config --quiet && echo compose-ok
```

Expected: `compose-ok`.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write docs/runbooks/deployment.md docs/runbooks/indexer.md
git add Dockerfile .env.example .env.compose.example .gitignore .dockerignore docs/runbooks
git commit -m "Add DigitalOcean App Platform support for the web app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Final verification and pull request

- [ ] **Step 1: Full monorepo verification**

```bash
pnpm verify
pnpm test:e2e
```

Expected: both PASS (format, lint, typecheck, unit tests, build for every package; browser gate).

- [ ] **Step 2: Production image of the Compose web service (unchanged Dockerfile, new dependency graph)**

```bash
docker build -f docker/Dockerfile.node --build-arg XCS_PACKAGE=@xcs-protocol/web -t xcs-web:migration-check .
```

Expected: build succeeds (proves `pnpm deploy --legacy` still prunes to a runnable `.output`).

- [ ] **Step 3: Open the pull request**

```bash
git push -u origin web-nuxt-ui-migration
gh pr create --title "Rebuild the web app on Nuxt UI 4 and add App Platform deployment support" --body-file <(cat <<'EOF'
## Summary
- Replace the hand-written stylesheet with Nuxt UI 4 / Tailwind 4 theme tokens that keep the XCS identity
- Add a default layout, error page, eight-component kit, and rebuild all 17 page templates (scripts unchanged)
- Relax only `style-src-attr` in the CSP for Nuxt UI overlays; script nonces unchanged
- Add `@nuxt/eslint` (Prettier-compatible) to the web lint step
- Add root `Dockerfile` and `.env.example` contract for `gh deploy-setup`; Compose contract moves to `.env.compose.example`

Spec: docs/superpowers/specs/2026-09-22-web-nuxt-ui-migration-design.md

## Test plan
- [ ] `pnpm verify`
- [ ] `pnpm test:e2e` (pilot, developers, wallet menu, security dev + production)
- [ ] Root `Dockerfile` built and started locally with the contract variables
- [ ] Compose web image built with `docker/Dockerfile.node`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```
