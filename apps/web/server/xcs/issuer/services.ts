import type { DatabaseClient } from '../../lib/db/index.js'
import type { loadIssuerConfig } from './config'
import type { IssuerRepository } from './repository'

export interface IssuerServices {
  database: DatabaseClient
  repository: IssuerRepository
  config: NonNullable<ReturnType<typeof loadIssuerConfig>>
}

declare module 'h3' {
  interface H3EventContext {
    xcsIssuerServices?: IssuerServices
  }
}
