import type { DatabaseClient } from '../../lib/db/index.js'
import type { ApplicationRepository } from '../applications/domain'
import { PresentationRepository } from '../presentations/repository'
import type { EvidencePolicy } from '../presentations/evidence'
import { VerifierRepository } from './repository'

export interface VerifierDependencies {
  database: DatabaseClient
  repository: ApplicationRepository
}

export function createVerifierServices(
  dependencies: VerifierDependencies,
  policy: EvidencePolicy = {},
) {
  const repository = new VerifierRepository(dependencies.database, dependencies.repository)
  const presentations = new PresentationRepository(
    dependencies.database,
    (db, session, result) => repository.record(db, session, result),
    policy,
  )
  return { repository, presentations }
}

export type VerifierServices = ReturnType<typeof createVerifierServices>

declare module 'h3' {
  interface H3EventContext {
    xcsVerifierServices?: () => VerifierServices
  }
}
