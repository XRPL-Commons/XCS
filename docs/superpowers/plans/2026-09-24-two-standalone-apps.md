# Two Standalone Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the repository to two self-contained deployable apps, `apps/web` (Nuxt UI plus the former Fastify API as Nitro routes with an identical `/v1` contract) and `apps/indexer`, sharing only the `db/` schema folder, with per-app lockfiles, Dockerfiles and `.env.example` contracts, local-development Compose, per-app CI and two release images.

**Architecture:** Phase A folds the API into the web app while the pnpm workspace still links everything, so every suite keeps passing at each step: the Fastify route closures become a framework-free handler table (`createApiHandlers`) exercised by a tiny `inject` helper in tests, with thin Nitro adapters per route, a custom trusted-proxy-aware rate limiter, h3 CORS, an OpenAPI generator over the same route table, and e2e fixtures shadowing `/v1` in browser-e2e mode. Phase B moves the schema to `db/`, vendors `core`/`sdk`/`db` code into each app, and makes each app a standalone pnpm project. Phase C rewrites Compose, CI, release and docs.

**Tech Stack:** Nuxt 4 / Nitro (h3), Ajv, Drizzle ORM + drizzle-kit, postgres.js, tsup, Vitest, Playwright, pnpm 10.34.4, Docker.

**Spec:** `docs/superpowers/specs/2026-09-24-two-standalone-apps-design.md`

## Global Constraints

- Branch `two-standalone-apps`; commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Prettier (root config) formats every touched file: `pnpm exec prettier --write <files>`.
- The `/v1` contract, health routes, metrics routes, verification semantics and indexer behaviour do not change. Response JSON, status codes and `error` codes stay byte-compatible with `apps/api`.
- No app imports `@xcs-protocol/*` after Phase B. The only shared folder is `db/` (schema + migrations), imported through the `#db/*` alias.
- Vendored files carry a first-line header comment: `// Copied from packages/<pkg>/src/<path> at <short sha>; keep in sync by hand (see CONTRIBUTING.md).`
- Every task ends green: the commands listed in its verify step pass before the commit.
- Docker: no BuildKit-only syntax (`RUN --mount`, heredocs). Build context is the repository root. Runtime user is `node`.
- Env contracts use the deploy-tool markers on the same line as the variable: `# config`, `# optional`, `# generate`, `# generate shared`, `# held`. `NODE_ENV`, `PORT`, `SERVER_PRESET` never appear in a contract.
- Naming: routes keep the paths in the spec's route table; the API context is `event.context.xcs`; the handler table module is `apps/web/server/xcs/handlers.ts`.

## File map

Phase A (workspace intact):

- Create `apps/web/server/xcs/**` (moved API modules + `handlers.ts`, `http.ts`, `openapi.ts`, `e2e-fixtures.ts`), `apps/web/server/plugins/00-xcs-api.ts`, `apps/web/server/middleware/{00-cors,01-rate-limit}.ts`, `apps/web/server/utils/dispatch.ts`, `apps/web/server/api/v1/**` adapters, `apps/web/server/routes/{health,internal,documentation}/**`, `apps/web/test/server/**`.
- Modify `apps/web/nuxt.config.ts`, `apps/web/package.json`, `apps/web/app/composables/useXcsApi.ts`, `apps/web/app/pages/developers.vue`, `apps/web/playwright*.config.ts`, `apps/web/e2e/security*.ts`, root `package.json`.
- Delete `apps/web/server/middleware/internal-ssr-rate-limit.ts`, `apps/web/server/utils/internalSsrRateLimit.ts`, `apps/web/server/plugins/validate-internal-api-token.ts`, `apps/web/app/utils/internalSsrRateLimit.ts`, `apps/web/test/internalSsrRateLimit.test.ts`, `apps/web/server/routes/__e2e-api/**`, `apps/api/**`.

Phase B:

- Create `db/{schema,migrations,drizzle.config.ts}`, `apps/web/app/lib/xcs/{core,sdk}/**`, `apps/web/server/lib/db/**`, `apps/indexer/src/lib/{xcs,db}/**`, `apps/{web,indexer}/pnpm-lock.yaml`, `apps/{web,indexer}/Dockerfile`, `apps/{web,indexer}/.env.example`, `apps/indexer/README.md`.
- Modify `apps/{web,indexer}/package.json`, `tsconfig.json`, build configs, all import sites, `pnpm-workspace.yaml`, root `package.json`, `.gitignore`, `.dockerignore`, `docker-compose.yml`, `.env.compose.example`.
- Delete `packages/db/**`, root `Dockerfile`, root `.env.example`, `docker/**`, `docker-compose.secrets.yml`, `ops/ci/test-node-entrypoint.sh`.

Phase C: `.github/workflows/*.yml`, `ops/monitoring/prometheus/prometheus.yml`, docs, ADR 0004.

---

# Phase A: fold the API into the web app

### Task A1: Move the framework-free API modules and their tests into the web app

**Files:**

- Create: `apps/web/server/xcs/` with copies of every `apps/api/src/*.ts` except `app.ts`, `main.ts`, `index.ts` (keep `internal/network-safety.ts` as `apps/web/server/xcs/internal/network-safety.ts`).
- Create: `apps/web/test/server/` with copies of every `apps/api/test/*.test.ts` except `app.test.ts` and `postgres.integration.test.ts`; copy `postgres.integration.test.ts` to `apps/web/test/postgres.integration.test.ts`.
- Modify: `apps/web/package.json` (dependencies), `apps/web/vitest.config.ts`, `apps/web/tsconfig.json`.

**Interfaces:** Produces the modules under `~/server/xcs/*` with unchanged exports (`loadApiConfig`, `PostgresApiRepository`, `verifyCredential`, `StaticTrustPolicy`, `OperationalMetricsCollector`, `DemoPinningService`, `SafePayloadResolver`, `DisabledPayloadResolver`, `KuboPinStore`, presenters, schemas, errors).

- [ ] **Step 1: Copy modules and tests**

```bash
cd /Users/lucbocahut/xrpl/XCS
mkdir -p apps/web/server/xcs/internal apps/web/test/server
for f in apps/api/src/*.ts; do b=$(basename "$f"); case "$b" in app.ts|main.ts|index.ts) ;; *) cp "$f" "apps/web/server/xcs/$b";; esac; done
cp apps/api/src/internal/network-safety.ts apps/web/server/xcs/internal/network-safety.ts
for f in apps/api/test/*.test.ts; do b=$(basename "$f"); case "$b" in app.test.ts|postgres.integration.test.ts) ;; *) cp "$f" "apps/web/test/server/$b";; esac; done
cp apps/api/test/postgres.integration.test.ts apps/web/test/postgres.integration.test.ts
ls apps/api/test | grep -v '\.test\.ts$'   # copy any fixture/helper files it lists into apps/web/test/server/ too
```

- [ ] **Step 2: Fix imports**

In the copied modules, relative imports (`./x.js`) stay valid. Replace `../src/…` in the copied tests with `../../server/xcs/…`. `@xcs-protocol/core` and `@xcs-protocol/db` imports stay for now (Phase B replaces them).

- [ ] **Step 3: Dependencies**

Add to `apps/web/package.json` `dependencies` the runtime packages `apps/api/package.json` lists that the web app lacks (expected: `ajv`, `drizzle-orm`, `postgres`, `undici`, `@xcs-protocol/db` as `workspace:*`, `ipaddr.js` already present). Add `@xcs-protocol/db` also to `vite.optimizeDeps.include` only if the browser bundle ever imports it (it must not). Run `pnpm install`.

- [ ] **Step 4: Test config**

`apps/web/vitest.config.ts`: keep `environment: 'node'`, set `include: ['test/**/*.test.ts']`, `exclude: ['test/postgres.integration.test.ts']`, and add `resolve.alias` for `~` → `./app` and `#server` → `./server` if any test imports through them (prefer relative imports). Add script `"test:postgres": "XCS_REQUIRE_POSTGRES_TESTS=1 vitest run test/postgres.integration.test.ts"` to `apps/web/package.json`.

- [ ] **Step 5: Verify**

```bash
pnpm --filter @xcs-protocol/web test
pnpm --filter @xcs-protocol/web lint
```

Expected: all former API unit tests pass inside the web package; lint (ESLint + typecheck) passes. Fix ESLint findings in copied files with the smallest change (the API package had no ESLint).

- [ ] **Step 6: Commit** — "Move the read API modules into the web app"

---

### Task A2: Convert the Fastify routes into a framework-free handler table

**Files:**

- Create: `apps/web/server/xcs/http.ts` (request/reply shim types), `apps/web/server/xcs/handlers.ts` (from `apps/api/src/app.ts`), `apps/web/test/server/handlers.test.ts` (from `apps/api/test/app.test.ts`), `apps/web/test/server/inject.ts`.

**Interfaces (produced, used by A3–A5):**

```ts
// apps/web/server/xcs/http.ts
export type HttpMethod = 'GET' | 'POST'
export interface ApiRequest {
  params: Record<string, string>
  query: Record<string, string | string[] | undefined>
  body: unknown
  headers: Record<string, string | undefined>   // lower-case names
  ip: string                                    // resolved client address
}
export interface ApiReply { statusCode: number; headers: Record<string, string>; body: unknown }
export interface RouteSchema {
  params?: object; querystring?: object; body?: object; response?: Record<number, object>; hide?: boolean
}
export interface RouteDefinition {
  method: HttpMethod
  path: string                                  // Fastify style, e.g. '/v1/networks/:network/status'
  schema?: RouteSchema
  rateLimit?: false | { max: number; timeWindowMs: number }
  bodyLimitBytes?: number
  handle: (request: ApiRequest) => Promise<ApiReply>
}
export interface ApiHandlers {
  routes: RouteDefinition[]
  close(): Promise<void>
}
export class HttpError extends Error { constructor(public statusCode: number, public code: string, message?: string) }
export function createApiHandlers(options: CreateApiOptions): ApiHandlers   // in handlers.ts
```

`CreateApiOptions` keeps every field of the old `createApiOptions` except `logger`, `internalSsrToken`, `trustedProxyCidrs`, `globalRateLimit`, `verifyRateLimit` (rate limits become per-route `rateLimit` values: `/v1/**` 100 per minute, `/v1/verify` 20, pinning 10, health/metrics `false`).

- [ ] **Step 1: Write the reply shim** in `http.ts`

```ts
export function createReply() {
  const reply = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    sent: false,
  }
  return {
    code(status: number) {
      reply.statusCode = status
      return this
    },
    header(name: string, value: string) {
      reply.headers[name.toLowerCase()] = value
      return this
    },
    send(body: unknown) {
      reply.body = body
      reply.sent = true
      return reply
    },
    result(): ApiReply {
      return { statusCode: reply.statusCode, headers: reply.headers, body: reply.body }
    },
    get sent() {
      return reply.sent
    },
  }
}
```

- [ ] **Step 2: Transform `app.ts` into `handlers.ts`**

Mechanical rules, applied to every route in `apps/api/src/app.ts`:

1. `app.get<{ Params: P }>(path, { schema, config, onSend, bodyLimit }, async (request, reply) => body)` becomes an entry pushed onto `routes`:
   ```ts
   route('GET', path, { schema, rateLimit, bodyLimitBytes }, async (request, reply) => body)
   ```
   where `route()` wraps the closure: it creates a reply shim, awaits the closure, and returns `reply.sent ? reply.result() : { statusCode: reply.statusCode, headers: reply.headers, body: returnedValue }`. An `onSend` that set `cache-control` becomes `reply.header('cache-control', …)` at the top of the closure.
2. `config.rateLimit: false` → `rateLimit: false`; `config.rateLimit: { max, timeWindow: '1 minute' }` → `rateLimit: { max, timeWindowMs: 60_000 }`; routes without config get the default `{ max: 100, timeWindowMs: 60_000 }` under `/v1/` and `false` elsewhere.
3. `request.params.x` / `request.query.x` / `request.body` / `request.ip` map 1:1 to `ApiRequest`. Fastify coerced nothing (`coerceTypes: false`), so numeric query values were validated as strings; keep the schemas as they are.
4. Validation: `route()` validates `params`, then `querystring`, then `body` against `schema` with one shared Ajv instance (`new Ajv({ removeAdditional: false, coerceTypes: false, allErrors: false, strict: false })` plus `addSchema(xcsFieldDescriptorSchema)`); the first section that fails determines the response. A failure returns `{ statusCode: 400, body: { error: 'VALIDATION_ERROR', message } }` where `message` reproduces the old default schema error formatter verbatim — `` `${context}${error.instancePath} ${error.message}` `` with `context` being `params`, `querystring` or `body` and `error` the single Ajv error produced under `allErrors: false` (for example `querystring/limit must match pattern "^(?:[1-9]|[1-4][0-9]|50)$"` or `body must NOT have additional properties`). This is the envelope the old error handler produced for `error.validation`; it never flattens to a generic `'Invalid request'` string.
5. The old `setErrorHandler` becomes `mapError(error): ApiReply` exported from `handlers.ts`, applied by `route()` around the closure: `PinningError`, `SchemaProjectionInvalidError`, `IndexerUnavailableError`, `VerificationNetworkNotFoundError` → their `statusCode` and `code` exactly as today; `HttpError` → its status and code; anything else → 500 `{ error: 'INTERNAL_ERROR', message: 'Internal server error' }`.
6. Swagger/cors/rate-limit plugin registrations, `rateLimitKey`, `tokensMatch` for the SSR token, and the `INTERNAL_SSR_*` constants are dropped. `tokensMatch` stays for the metrics bearer token.
7. The metrics `onResponse` hook (429 counting) is replaced by an exported `recordRateLimited(routePath)` on the handlers object, called by the rate-limit middleware in A3.
8. `close()` resolves immediately (the Nitro plugin closes the database).

Keep the helper functions (`authoritativeTime`, `preflightAuthoritativeRead`, `requireAuthoritativeCheckpoint`, `readinessReason`) inside `createApiHandlers` unchanged.

- [ ] **Step 3: Write the test helper** `apps/web/test/server/inject.ts`

```ts
import { match } from 'path-to-regexp' // devDependency; or a hand-rolled ':param' matcher
export function createInjector(handlers: ApiHandlers) {
  return async function inject(options: {
    method: HttpMethod
    url: string
    payload?: unknown
    headers?: Record<string, string>
    ip?: string
  }) {
    const [pathname, search = ''] = options.url.split('?')
    const query = Object.fromEntries(new URLSearchParams(search))
    for (const route of handlers.routes) {
      if (route.method !== options.method) continue
      const matched = match(route.path.replaceAll(/:([A-Za-z0-9_]+)/g, ':$1'))(pathname)
      if (!matched) continue
      const reply = await route.handle({
        params: matched.params as Record<string, string>,
        query,
        body: options.payload,
        headers: lowerCase(options.headers ?? {}),
        ip: options.ip ?? '127.0.0.1',
      })
      return {
        statusCode: reply.statusCode,
        headers: reply.headers,
        json: () => reply.body as never,
        body: JSON.stringify(reply.body),
      }
    }
    return { statusCode: 404, headers: {}, json: () => ({ error: 'NOT_FOUND' }), body: '' }
  }
}
```

Then port `app.test.ts`: `createApi(options)` → `createApiHandlers(options)` + `const inject = createInjector(handlers)`; `app.inject({...})` → `inject({...})`; remove `internalSsrToken` cases (replace the two SSR-header rate-limit tests with an equivalent test of `recordRateLimited` in A3); `response.json()` stays. Assertions on status codes, bodies and `cache-control` headers stay verbatim.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @xcs-protocol/web test -- test/server/handlers.test.ts
pnpm --filter @xcs-protocol/web lint
```

Expected: every ported assertion passes (report the count versus the 127 original injections); lint passes.

- [ ] **Step 5: Commit** — "Turn the read API routes into a framework-free handler table"

---

### Task A3: Nitro composition, adapters, CORS, rate limiting, error mapping

**Files:**

- Create: `apps/web/server/plugins/00-xcs-api.ts`, `apps/web/server/utils/dispatch.ts`, `apps/web/server/middleware/00-cors.ts`, `apps/web/server/middleware/01-rate-limit.ts`, `apps/web/server/utils/clientAddress.ts` (moved from `internalSsrRateLimit.ts`: `parseTrustedProxyCidrs`, `resolveSsrClientAddress` renamed `resolveClientAddress`), all route adapters listed in the spec's route table, `apps/web/test/server/rateLimit.test.ts`, `apps/web/test/server/clientAddress.test.ts` (from the old `internalSsrRateLimit.test.ts` cases that concern address resolution).
- Modify: `apps/web/nuxt.config.ts` (runtimeConfig: remove `apiBaseUrl`, `apiInternalToken`, `trustedProxyCidrs`, `public.apiBaseUrl`; add nothing — the API reads `process.env` through `loadApiConfig`), `apps/web/app/composables/useXcsApi.ts`, `apps/web/app/pages/developers.vue`, `apps/web/server/plugins/validate-*.ts`.
- Delete: SSR hop files listed in the file map.

- [ ] **Step 1: Composition plugin**

```ts
// apps/web/server/plugins/00-xcs-api.ts
import { createDatabaseClient } from '@xcs-protocol/db'
import { createApiHandlers, type ApiHandlers } from '../xcs/handlers'
import { loadApiConfig, type ApiConfig } from '../xcs/config'
// … same imports as the old apps/api/src/main.ts for repositories, resolver, trust policy, pinning
export interface XcsApiContext { config: ApiConfig; handlers: ApiHandlers; trustedProxyCidrs: string[] }
declare module 'h3' { interface H3EventContext { xcs: XcsApiContext } }

export default defineNitroPlugin((nitro) => {
  const runtime = useRuntimeConfig()
  const context = runtime.browserE2eMode === 'enabled' && import.meta.dev
    ? createBrowserE2eContext()                                   // Task A4
    : createProductionContext()
  nitro.hooks.hook('request', (event) => { event.context.xcs = context })
  nitro.hooks.hook('close', () => context.close())
})

function createProductionContext(): XcsApiContext & { close(): Promise<void> } {
  const config = loadApiConfig(process.env)
  const database = createDatabaseClient(config.databaseUrl)   // lazy: no connection until first query
  // repository, pinningService, resolver, trustPolicy, operationalMetrics exactly as apps/api/src/main.ts
  const handlers = createApiHandlers({ … })
  const janitor = pinningService && setInterval(() => void pinningService.unpinExpired().catch(() => {}), 3_600_000)
  janitor?.unref()
  return { config, handlers, trustedProxyCidrs: config.trustedProxyCidrs, async close() { if (janitor) clearInterval(janitor); await database.close() } }
}
```

`loadApiConfig`: delete `internalSsrToken`, `host`, `port` handling (Nitro owns the listener), keep everything else. The metrics-token "distinct from internal token" rule goes away with it.

- [ ] **Step 2: Dispatch adapter**

```ts
// apps/web/server/utils/dispatch.ts
export async function dispatch(event: H3Event, method: HttpMethod, path: string) {
  const { handlers, trustedProxyCidrs } = event.context.xcs
  const route = handlers.routes.find((r) => r.method === method && r.path === path)
  if (!route) throw createError({ statusCode: 404, data: { error: 'NOT_FOUND' } })
  const body =
    method === 'POST' ? await readJsonBody(event, route.bodyLimitBytes ?? 1_048_576) : undefined
  const reply = await route.handle({
    params: getRouterParams(event, { decode: true }),
    query: getQuery(event) as ApiRequest['query'],
    body,
    headers: Object.fromEntries(
      Object.entries(getRequestHeaders(event)).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
    ),
    ip: resolveClientAddress(
      getRequestIP(event),
      getRequestHeader(event, 'x-forwarded-for'),
      trustedProxyCidrs,
    ),
  })
  for (const [name, value] of Object.entries(reply.headers)) setResponseHeader(event, name, value)
  setResponseStatus(event, reply.statusCode)
  return reply.body
}
async function readJsonBody(event: H3Event, limit: number) {
  const length = Number(getRequestHeader(event, 'content-length') ?? '0')
  if (length > limit) throw createError({ statusCode: 413, data: { error: 'PAYLOAD_TOO_LARGE' } })
  const raw = await readRawBody(event, 'utf8')
  if (raw === undefined || raw.length === 0) return undefined
  if (Buffer.byteLength(raw, 'utf8') > limit)
    throw createError({ statusCode: 413, data: { error: 'PAYLOAD_TOO_LARGE' } })
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw createError({
      statusCode: 400,
      data: { error: 'VALIDATION_ERROR', message: (error as Error).message },
    })
  }
}
```

A body that is not valid JSON never reaches the handler table, so it has no schema context to name. It returns `VALIDATION_ERROR` with the JSON parser's own message; schema failures inside `route()` carry the formatter message described in Task A2 rule 4 instead.

Each adapter file is three lines, for example `apps/web/server/api/v1/networks/[network]/status.get.ts`:

```ts
export default defineEventHandler((event) => dispatch(event, 'GET', '/v1/networks/:network/status'))
```

Create one adapter per row of the spec's route table (health and metrics under `server/routes/`). Error envelope: add `nitro.errorHandler: '~/server/error.ts'` in `nuxt.config.ts` whose handler emits `{ error, message }` from `error.data` for API paths (`/v1/**`, `/health/**`, `/internal/**`) and defers to Nuxt's default renderer otherwise.

- [ ] **Step 3: CORS and rate limiting middleware**

```ts
// apps/web/server/middleware/00-cors.ts
export default defineEventHandler((event) => {
  if (!event.path.startsWith('/v1/')) return
  const { config } = event.context.xcs
  handleCors(event, {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: false,
    preflight: { statusCode: 204 },
  })
})
```

```ts
// apps/web/server/middleware/01-rate-limit.ts  (fixed-window counters per key, in memory, pruned hourly)
export default defineEventHandler((event) => {
  const { handlers, trustedProxyCidrs } = event.context.xcs
  const route = handlers.routes.find(
    (r) => r.method === event.method && matchesPath(r.path, event.path),
  )
  if (!route || route.rateLimit === false) return
  const key = `${route.path}|${resolveClientAddress(getRequestIP(event), getRequestHeader(event, 'x-forwarded-for'), trustedProxyCidrs)}`
  const { allowed, retryAfterSeconds } = limiter.hit(key, route.rateLimit)
  if (allowed) return
  handlers.recordRateLimited(route.path)
  setResponseHeader(event, 'retry-after', String(retryAfterSeconds))
  throw createError({
    statusCode: 429,
    data: { error: 'RATE_LIMITED', message: 'Rate limit exceeded' },
  })
})
```

`limiter` is a module-level `Map<string, { count: number; windowStart: number }>`; export `createLimiter(now = Date.now)` from `server/xcs/rate-limit.ts` so `rateLimit.test.ts` can test the window logic with a fake clock (allowed up to `max`, 429 after, reset after the window). Check the old `rateLimitResponseSchema` body shape in `http-schemas.ts` and use exactly that body.

- [ ] **Step 4: Remove the SSR hop**

`useXcsApi.ts`: delete the `internalSsrRequest` block; `const apiFetch = $fetch` and `baseURL = '/v1'` on both sides (on the server Nitro serves same-origin `$fetch` in-process). Update every call to drop the `/v1` prefix or keep the prefix and set `baseURL = ''`; keep one consistent style. `developers.vue`: `apiBaseUrl = useRequestURL().origin`, `apiDocumentationUrl = `${apiBaseUrl}/documentation``. Delete the SSR-hop files and the `NUXT_API_*` runtime keys; `validate-internal-api-token.ts` goes; keep `validate-public-rpc.ts`, `validate-browser-e2e.ts`, `validate-local-payload-store.ts`, `no-store-html.ts` (extend the latter so `/v1/**` JSON is not marked `no-store` unless the handler set it).

- [ ] **Step 5: Verify**

```bash
pnpm --filter @xcs-protocol/web lint
pnpm --filter @xcs-protocol/web test
XCS_DATABASE_URL=postgres://127.0.0.1:1/xcs NUXT_IGNORE_LOCK=1 pnpm --filter @xcs-protocol/web dev --port 3140 &   # background
curl -s -i http://127.0.0.1:3140/health/live | head -5          # 200 {"status":"ok"} with cache-control: no-store
curl -s -i http://127.0.0.1:3140/health/ready | head -3         # 503 database_unavailable
curl -s -i http://127.0.0.1:3140/v1/networks/x/status | head -3 # 503 or 404 envelope, never a Nuxt HTML error page
```

Expected as commented. Stop the dev server.

- [ ] **Step 6: Commit** — "Serve the read API from Nitro with CORS and rate limiting"

---

### Task A4: Browser e2e fixtures on `/v1`, Playwright configs, security suites

**Files:**

- Create: `apps/web/server/xcs/e2e-fixtures.ts` (from `server/routes/__e2e-api/v1/[...path].get.ts` and `verify.post.ts`, as functions `fixtureGet(path, query)` and `fixtureVerify(body)` returning `ApiReply`), `createBrowserE2eContext()` in `00-xcs-api.ts` that builds an `ApiHandlers` whose routes call those functions (same paths as the real table; unknown paths 404).
- Modify: `apps/web/playwright.config.ts` (drop `NUXT_API_BASE_URL`, `NUXT_PUBLIC_API_BASE_URL`; keep `XCS_BROWSER_E2E=1`), `apps/web/playwright.security.config.ts` (drop `NUXT_API_INTERNAL_TOKEN`; add `XCS_DATABASE_URL: 'postgres://127.0.0.1:1/xcs'`, `XCS_ALLOWED_ORIGINS: 'http://127.0.0.1:3101'`), `apps/web/e2e/security.spec.ts` (the "browser E2E JSON route outside the HTML CSP" test now targets `/v1/networks`), `apps/web/e2e/security.production.spec.ts` (add: `GET /v1/networks` in the production build returns 503 with `error: 'INDEXER_STATUS_UNAVAILABLE'` or `database_unavailable` envelope and never fixture data; `GET /health/live` is 200 `no-store`).
- Delete: `apps/web/server/routes/__e2e-api/**`.

- [ ] **Step 1–3:** implement, run `pnpm --filter @xcs-protocol/web test:e2e` and the production security suite (`pnpm test:e2e` from the root still works because the workspace is intact). Expected: 33 + the new production assertions pass.
- [ ] **Step 4: Commit** — "Serve browser e2e fixtures from the /v1 routes in test mode"

---

### Task A5: OpenAPI at `/documentation`, delete `apps/api`, root wiring

**Files:**

- Create: `apps/web/server/xcs/openapi.ts` (`buildOpenApiDocument(routes: RouteDefinition[], version: string)` → OpenAPI 3.1 with `paths` from each non-hidden route's `schema` (params → `parameters` in path, querystring properties → query parameters, body → `requestBody`, response map → `responses`), Fastify `:param` → `{param}`), `apps/web/server/routes/documentation/openapi.json.get.ts`, `apps/web/server/routes/documentation/index.get.ts` (server-rendered HTML page: title, list of routes with method/path/summary, link to the JSON; inline `<style>` with the CSP nonce from `event.context.security?.nonce` — verify the attribute name in nuxt-security's runtime, or use a `<link>` to a static stylesheet in `public/`), `apps/web/test/server/openapi.test.ts` (document has every `/v1` route, no `/internal` route, valid against `openapi-types` shape checks).
- Delete: `apps/api/**`.
- Modify: root `package.json` (`test:postgres`: `pnpm --filter @xcs-protocol/core build && pnpm --filter @xcs-protocol/db build && pnpm --filter @xcs-protocol/indexer test:postgres && pnpm --filter @xcs-protocol/web test:postgres`), `docs/runbooks/deployment.md` and `docs/runbooks/monitoring.md` (only the lines that name the api service and port 3001: point them at the web app; the full rewrite is Task C2), `docker-compose.yml` (temporary: drop the `api` service, give `web` the api env block and `depends_on: db-bootstrap`, and keep it building through `docker/Dockerfile.node` until Task B4; `operations.yml` expectation list updated to `db-bootstrap indexer postgres web`), `ops/monitoring/prometheus/prometheus.yml` (scrape `web:3000`).

- [ ] Verify: `pnpm verify` at the root, `pnpm test:e2e`, `pnpm test:postgres` against a local PostgreSQL 18 (start one with `docker run --rm -d -e POSTGRES_PASSWORD=… -p 5433:5432 postgres:18-alpine` and set `XCS_TEST_DATABASE_URL`), `docker compose config --quiet`.
- [ ] Commit — "Retire apps/api: the web app serves the read API and its OpenAPI document"

---

# Phase B: shared schema folder and standalone apps

### Task B1: Move the schema to `db/`, vendor the db runtime code, retire `packages/db`

**Files:**

- Create: `db/schema/*.ts` (moved from `packages/db/src/schema/`), `db/migrations/` (moved from `packages/db/drizzle/`, including `meta/`), `db/drizzle.config.ts`, `db/README.md` (what the folder is, how to generate and apply migrations, "not a package").
- Create: `apps/indexer/src/lib/db/{client,indexer-fencing,transactions,provision,bootstrap}.ts`, `apps/indexer/src/lib/db/bin/{bootstrap,migrate}.ts`, `apps/web/server/lib/db/{client,transactions}.ts` (no fencing copy: leases are indexer-only) (copies with the header comment; imports of `./schema/index.js` rewritten to `#db/schema`).
- Modify: `apps/indexer/{package.json,tsconfig.json,tsup.config.ts}`, `apps/web/{nuxt.config.ts,tsconfig.json,vitest.config.ts}`, every `@xcs-protocol/db` import site in both apps and their tests (`grep -rn "@xcs-protocol/db" apps/`), `.github/workflows/ci.yml` (migrations-committed check → `pnpm --filter @xcs-protocol/indexer db:generate && git diff --exit-code -- db/migrations`), root `package.json` (`test:postgres` no longer builds db).
- Delete: `packages/db/**`.

Alias wiring:

```ts
// apps/web/nuxt.config.ts
alias: { '#db': fileURLToPath(new URL('../../db', import.meta.url)) },
nitro: { alias: { '#db': fileURLToPath(new URL('../../db', import.meta.url)) } },
typescript: { tsConfig: { compilerOptions: { paths: { '#db/*': ['../../../db/*'] } } } },
```

```ts
// apps/indexer/tsup.config.ts
import { defineConfig } from 'tsup'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/main.ts',
    'src/maintenance.ts',
    'src/fixture-cli.ts',
    'src/lib/db/bin/bootstrap.ts',
    'src/lib/db/bin/migrate.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  esbuildOptions(o) {
    o.alias = { '#db': fileURLToPath(new URL('../../db', import.meta.url)) }
  },
})
```

`apps/indexer/tsconfig.json`: `"paths": { "#db/*": ["../../db/*"] }`, `include` adds `"../../db/**/*.ts"`. `db/drizzle.config.ts`: `schema: './schema/index.ts'`, `out: './migrations'`, url from `XCS_BOOTSTRAP_DATABASE_URL` → `XCS_DATABASE_URL`. Indexer scripts: `db:generate` = `drizzle-kit generate --config ../../db/drizzle.config.ts`, `db:migrate` = `tsx src/lib/db/bin/migrate.ts` (uses `drizzle-orm/postgres-js/migrator` with `migrationsFolder` resolved to `../../db/migrations` in dev and `./db/migrations` in the image — read `XCS_MIGRATIONS_DIR` with that default), `db:bootstrap` = `tsx src/lib/db/bin/bootstrap.ts`.

- [ ] Verify: `pnpm verify`, `pnpm test:postgres` (both apps), `pnpm --filter @xcs-protocol/indexer db:generate` produces no diff, `grep -rn "@xcs-protocol/db" apps/ packages/` → no hits.
- [ ] Commit — "Share the database schema through db/ and retire packages/db"

---

### Task B2: Vendor `core` and `sdk` into the web app and make it standalone

**Files:**

- Create: `apps/web/app/lib/xcs/core/**` (every `packages/core/src/*.ts`, header comment added), `apps/web/app/lib/xcs/sdk/**` (every `packages/sdk/src/*.ts`; `@xcs-protocol/core` imports → `../core`), `apps/web/test/lib/xcs/{core,sdk}/**` (copies of both packages' test folders, imports rewritten), `apps/web/pnpm-lock.yaml`.
- Modify: every `@xcs-protocol/core|sdk` import in `apps/web/app`, `apps/web/server`, `apps/web/test` → `~/lib/xcs/core` / `~/lib/xcs/sdk` (server files use the relative path `../../app/lib/xcs/core` or a `#xcs/*` alias to `app/lib/xcs`; pick the alias and declare it like `#db`), `apps/web/package.json` (remove `workspace:*` deps; add the runtime deps of core and sdk: `@noble/hashes`, `@scure/base`, `canonicalize`, `jsonc-parser`, `multiformats`, `tr46`, `xrpl`; add every dev tool the app needs itself: `typescript`, `vitest`, `@vitest/coverage-v8`, `prettier`, `eslint`, `tsx`; add `"pnpm": { "overrides": { "js-yaml@>=4.0.0 <4.3.2": "^4.3.2", "svgo@>=4.0.0 <4.1.0": ">=4.1.0" }, "patchedDependencies": { "xrpl-connect@1.0.0-rc.0": "patches/xrpl-connect@1.0.0-rc.0.patch" } }` with the patch file copied to `apps/web/patches/`), `apps/web/vite.optimizeDeps.include` (drop the two workspace names).
- Add scripts to `apps/web/package.json`: `"format:check": "prettier --check ."`, `"verify": "pnpm format:check && pnpm lint && pnpm test && pnpm build"`.
- Modify: `pnpm-workspace.yaml` → `packages: ['packages/*']` (apps removed) — do this in B3 after the indexer is standalone; for this task run `pnpm install` inside `apps/web` with `--ignore-workspace` to produce `apps/web/pnpm-lock.yaml`, and add `apps/web/.npmrc` with `ignore-workspace-root-check=true`.

- [ ] Verify: `cd apps/web && pnpm install --frozen-lockfile && pnpm verify && pnpm test:e2e && pnpm test:e2e:security`; `grep -rn "@xcs-protocol/" apps/web --include=*.ts --include=*.vue -l | grep -v developerQuickstart` → only `package.json` name.
- [ ] Commit — "Make the web app standalone with vendored protocol code"

---

### Task B3: Vendor `core` into the indexer and make it standalone; workspace becomes packages only

**Files:**

- Create: `apps/indexer/src/lib/xcs/**` (the `packages/core` modules reachable from the four imported symbols plus their transitive local imports: run `grep -n "^import" packages/core/src/{network,payload-uri,schema-uid,schema,json,errors}.ts` and follow until closed; copy those files with the header comment), `apps/indexer/test/lib/xcs/**` (the matching core tests), `apps/indexer/pnpm-lock.yaml`, `apps/indexer/.npmrc`.
- Modify: `@xcs-protocol/core` imports in `apps/indexer/src` and `test` → `./lib/xcs` relative paths; `apps/indexer/package.json` (remove workspace deps; add core's runtime deps that the copied modules use — check each copied file's imports; add dev tools `tsup`, `tsx`, `typescript`, `vitest`, `@vitest/coverage-v8`, `prettier`, `drizzle-kit`, `@types/node`; scripts `format:check`, `verify`; the same `pnpm.overrides`), `pnpm-workspace.yaml` → `packages/*` only, root `package.json` scripts:

```json
"build": "turbo run build && pnpm --dir apps/web build && pnpm --dir apps/indexer build",
"lint": "turbo run lint && pnpm --dir apps/web lint && pnpm --dir apps/indexer lint",
"test": "turbo run test && pnpm --dir apps/web test && pnpm --dir apps/indexer test",
"typecheck": "turbo run typecheck && pnpm --dir apps/web typecheck && pnpm --dir apps/indexer typecheck",
"test:e2e": "pnpm --dir apps/web test:e2e && pnpm --dir apps/web test:e2e:security",
"test:postgres": "pnpm --dir apps/indexer test:postgres && pnpm --dir apps/web test:postgres",
"install:apps": "pnpm --dir apps/web install --frozen-lockfile && pnpm --dir apps/indexer install --frozen-lockfile",
"verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
```

`.prettierignore` adds `apps/*/pnpm-lock.yaml`. Root `pnpm install` no longer installs the apps; document `pnpm install && pnpm install:apps` in README (Task C2).

- [ ] Verify: `pnpm install && pnpm install:apps && pnpm verify`; `cd apps/indexer && pnpm test:postgres`; `grep -rn "@xcs-protocol/" apps/ --include=*.ts -l` → only `package.json` names and `developerQuickstart.ts` strings.
- [ ] Commit — "Make the indexer standalone and reduce the workspace to packages"

---

### Task B4: Per-app Dockerfiles and contracts, local-dev Compose, root cleanup

**Files:**

- Create: `apps/web/Dockerfile`, `apps/indexer/Dockerfile`, `apps/web/.env.example`, `apps/indexer/.env.example` (exact contents in the spec), `apps/web/.dockerignore` is not read (context is root): extend the root `.dockerignore` instead (`**/node_modules`, `**/.output`, `**/dist`, `**/test-results`, `**/playwright-report`, `packages/**` are excluded from the build context).
- Delete: root `Dockerfile`, root `.env.example`, `docker/`, `docker-compose.secrets.yml`, `ops/ci/test-node-entrypoint.sh`.
- Modify: `docker-compose.yml` (services `postgres`, `db-bootstrap`, `indexer`, `web`; `build: { context: ., dockerfile: apps/<name>/Dockerfile }`; env from `.env` plain values; `db-bootstrap` runs `node dist/lib/db/bin/bootstrap.js` in the indexer image; `web` `depends_on: db-bootstrap` completed and exposes 3000; `monitoring`/`demo-pinning` profiles kept; hardening kept), `docker-compose.dev.yml`, `.env.compose.example` (only the variables the four services and profiles use; no `*_FILE`), `.gitignore` (`!apps/*/.env.example`; drop `!.env.compose.example` if the file stays, keep it), `docs/runbooks/deployment.md` Compose commands (minimal edits; full rewrite in C2).

```dockerfile
# apps/web/Dockerfile — build context: repository root
FROM node:24-alpine AS build
RUN npm install -g pnpm@10.34.4
WORKDIR /workspace
COPY apps/web ./apps/web
COPY db ./db
COPY config ./config
WORKDIR /workspace/apps/web
RUN pnpm install --frozen-lockfile
RUN NODE_ENV=production pnpm build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV NITRO_PORT=3000
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/web/.output ./.output
COPY --chown=node:node config ./config
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
```

```dockerfile
# apps/indexer/Dockerfile — build context: repository root
FROM node:24-alpine AS build
RUN npm install -g pnpm@10.34.4
WORKDIR /workspace
COPY apps/indexer ./apps/indexer
COPY db ./db
COPY config ./config
WORKDIR /workspace/apps/indexer
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV XCS_MIGRATIONS_DIR=/workspace/db/migrations
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/apps/indexer/dist ./dist
COPY --from=build --chown=node:node /workspace/apps/indexer/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/indexer/package.json ./package.json
COPY --chown=node:node db/migrations ./db/migrations
COPY --chown=node:node config ./config
USER node
CMD ["node", "dist/main.js"]
```

- [ ] Verify (AGENTS.md rule): `docker build -f apps/web/Dockerfile -t xcs-web:local .` and `docker build -f apps/indexer/Dockerfile -t xcs-indexer:local .`; run the web image with the contract variables (`XCS_DATABASE_URL=postgres://127.0.0.1:1/xcs`, `XCS_ALLOWED_ORIGINS=http://localhost:3000`, `NUXT_PUBLIC_PROFILE_ID`, `NUXT_PUBLIC_RPC_URL=wss://s.altnet.rippletest.net:51233`) → `/health/live` 200 as uid 1000; `cp .env.compose.example .env && docker compose config --quiet && docker compose up --build -d && docker compose ps` → `db-bootstrap` exited 0, `indexer` and `web` up, `curl http://127.0.0.1:3000/health/ready` → 503 `indexer_not_initialized` (no profile indexed yet) then `docker compose down -v`.
- [ ] Commit — "Give each app its own Dockerfile and env contract; Compose is local development only"

---

# Phase C: CI, release, docs

### Task C1: Workflows, security scans, Prometheus target

- `.github/workflows/ci.yml`: jobs `packages` (root install, `pnpm format:check`, `turbo run lint typecheck test build`), `web` (`pnpm --dir apps/web install --frozen-lockfile`, `pnpm --dir apps/web verify`, Playwright install + `test:e2e` + `test:e2e:security`, report artifact), `indexer` (install, verify, Postgres service, `test:postgres`, `db:generate` + `git diff --exit-code -- db/migrations`), plus a `web-postgres` step in the `indexer` job (or its own job) running `pnpm --dir apps/web test:postgres` against the same service after `db:bootstrap`.
- `operations.yml`: build both Dockerfiles, Compose smoke test with the new service list, keep the pinned actions.
- `security.yml`: `pnpm audit --prod --audit-level high` and the license check for the root lockfile and for each app (`--dir apps/web`, `--dir apps/indexer`); Trivy scan unchanged.
- `release-artifacts.yml`: build, scan, SBOM, sign and attest `xcs-web` and `xcs-indexer` from `apps/<name>/Dockerfile`; remove the `db` image and the `SERVICE in api indexer db` loops (now `web indexer`).
- `ops/monitoring/prometheus/prometheus.yml`: `web:3000`; rules/tests that reference `xcs-api` job labels renamed to `xcs-web` (keep the metric names).
- Verify: `node ops/ci/check-action-pins.mjs .github/workflows/*.yml`, `actionlint` if installed, `docker compose config --quiet`, and a push to the branch to watch the workflows run (report each job).
- Commit — "Run CI, security and release workflows per app"

### Task C2: Documentation and ADR

- `README.md` (packages list, data flow, development commands: `pnpm install && pnpm install:apps`, per-app `pnpm --dir apps/<name> dev`), `docs/architecture.md`, `docs/database.md`, `docs/TESTING.md`, `docs/runbooks/deployment.md` (App Platform per app from `apps/<name>`; external database bootstrap with `pnpm --dir apps/indexer db:bootstrap`; Compose is local development), `docs/runbooks/indexer.md`, `docs/runbooks/monitoring.md`, `docs/known-limitations.md` (SSR hop paragraph removed; standalone-copies note added), `CONTRIBUTING.md` (mirroring rule), `apps/web/README.md` (API section listing the routes and `/documentation`), new `apps/indexer/README.md`, new `docs/adr/0004-two-standalone-apps.md` (context, decision, consequences: two services, no shared code between apps, `db/` schema folder, external database, `apps/api` and `packages/db` retired, hand-mirrored copies), `AGENTS.md` first bullet updated (Compose is local-dev; the image build rule now names both app Dockerfiles).
- Verify: `pnpm format:check`; `grep -rn "apps/api\|packages/db\|Dockerfile.node\|NUXT_API_" README.md docs CONTRIBUTING.md AGENTS.md apps/*/README.md` → no hits except ADR history and the superseded spec/plan files.
- Commit — "Document the two-app layout and record ADR 0004"

### Task C3: Final verification and pull request

- Fresh-clone check: `git clone --no-local . /tmp/xcs-fresh && cd /tmp/xcs-fresh && pnpm install && pnpm install:apps && pnpm verify`; then `rm -rf packages` in the clone and confirm `pnpm --dir apps/web verify` and `pnpm --dir apps/indexer verify` still pass (proves the apps do not depend on packages).
- `pnpm test:e2e`, `pnpm test:postgres`, both image builds and the Compose smoke test again on the final head.
- CLI check: with the web dev server running against the Postgres from the Compose stack after one bootstrap, `pnpm --filter @xcs-protocol/cli exec node dist/bin.js verify --api http://127.0.0.1:3000 …` returns the same envelope the API returned (a 404/503 envelope is acceptable evidence with an empty database).
- Push and open the PR with `gh pr create` (body: summary, spec link, the deviation notes, test plan; it closes #26 and #28; attribution line), then report.
