import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The OpenAPI document's `info.version` is this package's version; reading it
// here keeps the single source of truth in `package.json`.
const apiVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as {
    version: string
  }
).version

const browserE2eInput = process.env.XCS_BROWSER_E2E
if (browserE2eInput !== undefined && browserE2eInput !== '0' && browserE2eInput !== '1') {
  throw new Error('XCS_BROWSER_E2E must be exactly "0" or "1".')
}
if (browserE2eInput === '1' && process.env.NODE_ENV === 'production') {
  throw new Error('XCS_BROWSER_E2E cannot be enabled in production.')
}
const browserE2eMode = browserE2eInput === '1' ? 'enabled' : 'disabled'
const localPayloadStoreInput = process.env.XCS_LOCAL_PAYLOAD_STORE
if (
  localPayloadStoreInput !== undefined &&
  localPayloadStoreInput !== '0' &&
  localPayloadStoreInput !== '1'
) {
  throw new Error('XCS_LOCAL_PAYLOAD_STORE must be exactly "0" or "1".')
}
if (localPayloadStoreInput === '1' && process.env.NODE_ENV === 'production') {
  throw new Error('XCS_LOCAL_PAYLOAD_STORE cannot be enabled in production.')
}
const localPayloadStoreMode = localPayloadStoreInput === '1' ? 'enabled' : 'disabled'
const production = process.env.NODE_ENV === 'production'
const cspConnectSources = ["'self'", 'https:', 'wss:', ...(production ? [] : ['http:', 'ws:'])]

export default defineNuxtConfig({
  compatibilityDate: '2026-08-19',
  css: ['~/assets/css/main.css'],
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
  vite: {
    plugins: [
      {
        // `vaul-vue` ships its drawer CSS as a `vite-plugin-css-injected-by-js`
        // prelude that appends a runtime <style> tag. It nonces that tag from a
        // `meta[property="csp-nonce"]`, which production deliberately does not
        // expose, so the tag lands unnonced and violates `style-src`. The tag is
        // created even though nothing here renders a drawer: `UHeader` imports
        // `UDrawer` statically. Strip the prelude instead of weakening `style-src`.
        // Using `UDrawer`, or `UHeader` in `mode="drawer"`, would need its CSS back.
        // The strip is fail-closed: it matches the dist entry by exact path suffix and
        // throws if that module still builds a <style> element after the known prelude
        // regex failed, so an upstream change cannot silently restore the unnonced tag.
        name: 'xcs:strip-vaul-css-injection',
        transform(code: string, id: string) {
          const modulePath = id.split('?', 1)[0] ?? id
          if (!modulePath.endsWith('/vaul-vue/dist/index.js')) {
            return null
          }
          const stripped = code.replace(
            /^\(function\(\)\{[\s\S]*?vite-plugin-css-injected-by-js[\s\S]*?\}\)\(\);/u,
            '',
          )
          if (stripped === code) {
            if (/createElement\(\s*['"]style['"]\s*\)/u.test(code)) {
              throw new Error(
                `vaul-vue still injects a runtime <style> tag but the CSS injection prelude no longer matches; update the strip in nuxt.config.ts (module: ${modulePath}).`,
              )
            }
            return null
          }
          if (/createElement\(\s*['"]style['"]\s*\)/u.test(stripped)) {
            throw new Error(
              `vaul-vue still injects a runtime <style> tag after the CSS injection prelude was stripped; update the strip in nuxt.config.ts (module: ${modulePath}).`,
            )
          }
          return { code: stripped, map: null }
        },
      },
    ],
    optimizeDeps: {
      // These linked workspace packages publish from dist. Force a fresh
      // pre-bundle on each server start so rebuilt package code cannot be
      // replaced by Nuxt's persistent dependency cache.
      force: true,
      // `xrpl` and `xrpl-connect` are pulled in lazily by the wallet adapters, so
      // Vite only discovers them after the first page load and re-optimizes mid-run,
      // which 504s the in-flight module requests. Pre-bundle them up front.
      include: ['@xcs-protocol/core', '@xcs-protocol/sdk', 'xrpl', 'xrpl-connect'],
      // Served unbundled so the CSS-injection strip above also runs in dev.
      exclude: ['vaul-vue'],
    },
  },
  i18n: {
    defaultLocale: 'fr',
    strategy: 'prefix_except_default',
    locales: [
      { code: 'fr', language: 'fr-FR', name: 'Français', file: 'fr.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
    ],
    langDir: 'locales',
  },
  runtimeConfig: {
    apiVersion,
    browserE2eMode,
    localPayloadStoreMode,
    public: {
      profileId: '',
      rpcUrl: 'wss://s.altnet.rippletest.net:51233',
      xamanApiKey: '',
      xamanRedirectUrl: '',
      walletConnectProjectId: '',
      browserE2eMode,
      localPayloadStoreMode,
    },
  },
  security: {
    // A strict, explicit CSP is observed before enforcement. The module's
    // broader strict mode would also enable policies that have not passed the
    // Crossmark and GemWallet compatibility matrix.
    strict: false,
    contentSecurityPolicyReportOnly: true,
    nonce: true,
    headers: {
      contentSecurityPolicy: {
        'default-src': ["'none'"],
        'base-uri': ["'none'"],
        'connect-src': cspConnectSources,
        'font-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'frame-src': ["'none'"],
        'img-src': ["'self'", 'data:'],
        'manifest-src': ["'self'"],
        'media-src': ["'none'"],
        'object-src': ["'none'"],
        'script-src': ["'self'", "'strict-dynamic'", "'nonce-{{nonce}}'"],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", "'nonce-{{nonce}}'"],
        // Reka UI and Floating UI position overlays through inline style attributes.
        // Script execution stays nonce-gated with 'strict-dynamic'.
        'style-src-attr': ["'unsafe-inline'"],
        'worker-src': ["'self'"],
        'upgrade-insecure-requests': false,
      },
      crossOriginResourcePolicy: 'same-origin',
      crossOriginOpenerPolicy: 'same-origin-allow-popups',
      crossOriginEmbedderPolicy: false,
      originAgentCluster: '?1',
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: {
        maxAge: 15_552_000,
        includeSubdomains: false,
        preload: false,
      },
      xContentTypeOptions: 'nosniff',
      xDNSPrefetchControl: 'off',
      xDownloadOptions: 'noopen',
      xFrameOptions: 'DENY',
      xPermittedCrossDomainPolicies: 'none',
      xXSSProtection: '0',
      permissionsPolicy: {
        camera: [],
        'display-capture': [],
        fullscreen: [],
        geolocation: [],
        hid: ['self'],
        microphone: [],
        payment: [],
        usb: ['self'],
      },
    },
    // This slice adds response headers only. Existing API middleware and
    // application logging remain the owners of these separate concerns.
    requestSizeLimiter: false,
    rateLimiter: false,
    xssValidator: false,
    corsHandler: false,
    allowedMethodsRestricter: false,
    basicAuth: false,
    csrf: false,
    removeLoggers: false,
    sri: false,
    ssg: false,
    hidePoweredBy: true,
  },
  typescript: {
    strict: true,
    // Keep `nuxt typecheck` and production-build checking without injecting
    // vite-plugin-checker's nonced-unaware error overlay into the dev page.
    typeCheck: 'build',
  },
})
