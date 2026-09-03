import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'

import * as schema from './schema/index.js'

export type XcsDatabase = PostgresJsDatabase<typeof schema>

export interface DatabaseClient {
  db: XcsDatabase
  sql: Sql
  close: () => Promise<void>
}

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  if (databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL must not be empty')
  }

  const sqlClient = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  })

  return {
    db: drizzle(sqlClient, { schema }),
    sql: sqlClient,
    close: async () => sqlClient.end({ timeout: 5 }),
  }
}
