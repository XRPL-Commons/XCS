export type HttpMethod = 'GET' | 'POST'

export interface ApiRequest {
  params: Record<string, string>
  query: Record<string, string | string[] | undefined>
  body: unknown
  headers: Record<string, string | undefined>
  ip: string
}

export interface ApiReply {
  statusCode: number
  headers: Record<string, string>
  body: unknown
}

export interface RouteSchema {
  params?: object
  querystring?: object
  body?: object
  response?: Record<number, object>
  hide?: boolean
}

export interface RouteRateLimit {
  max: number
  timeWindowMs: number
  /**
   * Which bucket the budget is counted in. The previous HTTP framework gave a
   * route its own counter store only when the route declared its own
   * `config.rateLimit`; every route that fell through to the global config
   * shared one store keyed by the client alone. `'shared'` reproduces that
   * single cross-route budget, `'route'` a per-route one.
   */
  scope: 'shared' | 'route'
}

export interface RouteDefinition {
  method: HttpMethod
  path: string
  schema?: RouteSchema
  rateLimit?: false | RouteRateLimit
  bodyLimitBytes?: number
  /**
   * The `cache-control` value the previous response hook used to set. It is
   * applied to every response of the route, including validation failures and
   * mapped errors.
   */
  cacheControl?: string
  handle: (request: ApiRequest) => Promise<ApiReply>
}

export interface ApiHandlers {
  routes: RouteDefinition[]
  recordRateLimited(routePath: string): void
  close(): Promise<void>
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'HttpError'
  }
}

export interface ReplyShim {
  code(status: number): ReplyShim
  header(name: string, value: string): ReplyShim
  type(contentType: string): ReplyShim
  send(body: unknown): ApiReply
  result(): ApiReply
  readonly sent: boolean
}

export function createReply(): ReplyShim {
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
    type(contentType: string) {
      reply.headers['content-type'] = contentType
      return this
    },
    send(body: unknown) {
      reply.body = body
      reply.sent = true
      return { statusCode: reply.statusCode, headers: reply.headers, body: reply.body }
    },
    result(): ApiReply {
      return { statusCode: reply.statusCode, headers: reply.headers, body: reply.body }
    },
    get sent() {
      return reply.sent
    },
  }
}
