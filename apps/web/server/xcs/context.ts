import type { ApiConfig } from './config'
import type { ApiHandlers } from './http'

export interface XcsApiContext {
  config: ApiConfig
  handlers: ApiHandlers
  trustedProxyCidrs: string[]
  close(): Promise<void>
}

declare module 'h3' {
  interface H3EventContext {
    xcs: XcsApiContext
  }
}
