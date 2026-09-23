import type {
  CredentialEventRow,
  CredentialGenerationRow,
  DemoPinRow,
  IndexerStatusRow,
  LedgerCheckpointRow,
  NetworkProfileRow,
  PinChallengeRow,
  SchemaEventRow,
  SchemaRow,
} from '@xcs-protocol/db'

export interface SchemaCursor {
  ledgerIndex: number
  transactionIndex: number
  schemaUid: string
}

export interface SchemaPage {
  items: SchemaRow[]
  nextCursor?: string
}

export interface SchemaRegistrationCursor {
  ledgerIndex: number
  transactionIndex: number
  transactionHash: string
}

export interface DiscoveryStats {
  schemas: {
    total: number
    publishers: number
    minimumLedgerIndex: number | null
    maximumLedgerIndex: number | null
  }
  credentialGenerations: {
    total: number
    pending: number
    active: number
    expired: number
    deleted: number
    invalidEvidence: number
    minimumCreatedLedgerIndex: number | null
    maximumLastLedgerIndex: number | null
  }
}

export interface TransactionProjectionSummary {
  registration: SchemaEventRow | undefined
  firstCredentialEvent: CredentialEventRow | undefined
  credentialEventCount: number
}

export interface SchemaProjectionEvidence {
  schema: SchemaRow
  registration: SchemaEventRow
}

export interface ApiRepository {
  withConsistentSnapshot<T>(callback: (repository: ApiRepository) => Promise<T>): Promise<T>
  getDatabaseTime(): Promise<Date>
  ping(): Promise<void>
  listNetworks(): Promise<NetworkProfileRow[]>
  getNetwork(profileId: string): Promise<NetworkProfileRow | undefined>
  getIndexerStatus(profileId: string): Promise<IndexerStatusRow | undefined>
  getLatestCheckpoint(profileId: string): Promise<LedgerCheckpointRow | undefined>
  getSchema(profileId: string, schemaUid: string): Promise<SchemaRow | undefined>
  getSchemaProjectionEvidence(input: {
    profileId: string
    schemaUids: readonly string[]
  }): Promise<SchemaProjectionEvidence[]>
  getSchemaCatalogEvidence(input: {
    profileId: string
    targetUid: string
  }): Promise<SchemaProjectionEvidence[]>
  getSchemaRegistrationByTransaction(input: {
    profileId: string
    transactionHash: string
  }): Promise<SchemaEventRow | undefined>
  listSchemas(input: {
    profileId: string
    publisher?: string
    cursor?: SchemaCursor
    limit: number
  }): Promise<SchemaRow[]>
  searchSchemas(input: {
    profileId: string
    query?: string
    publisher?: string
    limit: number
  }): Promise<SchemaRow[]>
  listSchemaRegistrations(input: {
    profileId: string
    cursor?: SchemaRegistrationCursor
    limit: number
  }): Promise<SchemaEventRow[]>
  getDiscoveryStats(input: {
    profileId: string
    checkpointCloseTime: number
  }): Promise<DiscoveryStats>
  getCredential(input: {
    profileId: string
    issuer: string
    subject: string
    schemaUid: string
  }): Promise<CredentialGenerationRow | undefined>
  getCredentialGenerationById(input: {
    profileId: string
    generationId: string
  }): Promise<CredentialGenerationRow | undefined>
  getCredentialEvents(input: {
    profileId: string
    issuer: string
    subject: string
    schemaUid: string
    limit: number
  }): Promise<CredentialEventRow[]>
  getCredentialEventsByTransaction(input: {
    profileId: string
    transactionHash: string
    issuer: string
    subject: string
    schemaUid: string
    limit: number
  }): Promise<CredentialEventRow[]>
  getCredentialEventsByGeneration(input: {
    profileId: string
    generationId: string
    limit: number
  }): Promise<CredentialEventRow[]>
  getTransactionProjectionSummary(input: {
    profileId: string
    transactionHash: string
  }): Promise<TransactionProjectionSummary>
  getCredentialEventsByTransactionPage(input: {
    profileId: string
    transactionHash: string
    afterNodeIndex?: number
    limit: number
  }): Promise<CredentialEventRow[]>
}

export interface PayloadResolver {
  resolve(uri: string): Promise<Uint8Array>
}

export interface TrustPolicy {
  evaluate(issuer: string): 'trusted' | 'untrusted' | 'unknown'
}

export interface PinningRepository {
  createChallenge(input: {
    challengeId: string
    profileId: string
    wallet: string
    requesterIpHash: string
    message: string
    expiresAt: Date
  }): Promise<PinChallengeRow>
  getChallenge(challengeId: string): Promise<PinChallengeRow | undefined>
  reservePin(input: {
    pinId: string
    challengeId: string
    profileId: string
    wallet: string
    requesterIpHash: string
    cid: string
    byteLength: number
    expiresAt: Date
    now: Date
    dailyLimit: number
  }): Promise<DemoPinRow>
  markPinned(pinId: string, now: Date): Promise<void>
  markFailed(pinId: string, failureCode: string, now: Date): Promise<void>
  findExpiredPins(now: Date, limit: number): Promise<DemoPinRow[]>
  hasOtherActivePin(cid: string, excludingPinId: string, now: Date): Promise<boolean>
  markUnpinned(pinId: string, now: Date): Promise<void>
  deleteExpiredUnreferencedChallenges(now: Date, limit: number): Promise<number>
}

export interface ContentPinStore {
  putRaw(content: Uint8Array, expectedCid: string): Promise<void>
  unpin(cid: string): Promise<void>
}
