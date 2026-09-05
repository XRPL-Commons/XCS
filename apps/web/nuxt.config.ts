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
const apiInternalToken =
  process.env.NUXT_API_INTERNAL_TOKEN ??
  (process.env.NODE_ENV === 'production' ? '' : 'xcs-development-internal-token-0001')
const production = process.env.NODE_ENV === 'production'
const cspConnectSources = ["'self'", 'https:', 'wss:', ...(production ? [] : ['http:', 'ws:'])]

export default defineNuxtConfig({
  compatibilityDate: '2026-08-19',
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  vite: {
    optimizeDeps: {
      // These linked workspace packages publish from dist. Force a fresh
      // pre-bundle on each server start so rebuilt package code cannot be
      // replaced by Nuxt's persistent dependency cache.
      force: true,
      include: ['@xcs-protocol/core', '@xcs-protocol/sdk'],
    },
  },
  modules: ['@nuxtjs/i18n', 'nuxt-security'],
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
    apiBaseUrl: 'http://localhost:3001',
    apiInternalToken,
    trustedProxyCidrs: process.env.NUXT_TRUSTED_PROXY_CIDRS ?? '',
    browserE2eMode,
    localPayloadStoreMode,
    public: {
      apiBaseUrl: 'http://localhost:3001',
      profileId: '',
      rpcUrl: 'wss://s.altnet.rippletest.net:51233',
      xamanApiKey: '',
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
        'style-src-attr': ["'none'"],
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
