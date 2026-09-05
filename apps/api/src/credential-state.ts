import {
  projectCredentialLifecycle,
  XcsError,
  type CredentialLifecycleState,
} from '@xcs-protocol/core'
import type { CredentialGenerationRow } from '@xcs-protocol/db'

import { IndexerUnavailableError } from './ledger-freshness.js'

export function credentialGenerationState(
  generation: CredentialGenerationRow,
  closeTime: number,
): CredentialLifecycleState {
  try {
    return projectCredentialLifecycle({
      objectExists: generation.deletedLedgerIndex === null,
      accepted: generation.accepted,
      expiration: generation.expiration,
      closeTime,
    })
  } catch (error) {
    if (error instanceof XcsError && error.code === 'INVALID_RIPPLE_TIME') {
      throw new IndexerUnavailableError(
        'INDEXER_EVIDENCE_INVALID',
        'The indexed credential lifecycle evidence is incomplete or inconsistent.',
      )
    }
    throw error
  }
}
