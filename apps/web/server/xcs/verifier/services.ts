import type { IssuerServices } from '../issuer/services'
import { PresentationRepository } from '../presentations/repository'
import type { EvidencePolicy } from '../presentations/evidence'
import { VerifierRepository } from './repository'

export function createVerifierServices(issuer: IssuerServices, policy: EvidencePolicy = {}) {
  const repository = new VerifierRepository(issuer.database, issuer.repository)
  const presentations = new PresentationRepository(
    issuer.database,
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
