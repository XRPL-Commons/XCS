import type {
  JsonValue,
  NetworkProfile,
  RegisteredSchema,
  ResolvedSchema,
  SchemaDefinition,
} from './lib/xcs/index.js'
import type { AcquiredIndexerLease, IndexerLeaseToken } from './lib/db/indexer-fencing.js'

export type { NetworkProfile, RegisteredSchema, ResolvedSchema, SchemaDefinition }
export type { AcquiredIndexerLease, IndexerLeaseToken }

export type RegistryPolicy = 'blackholed' | 'controlled-testnet-pilot'
export type DatabaseScope = 'shared' | 'exclusive-profile'

export interface LedgerTransaction {
  hash: string
  transaction: Record<string, unknown>
  metadata: Record<string, unknown>
  transactionIndex: number
}

export interface ValidatedLedger {
  ledgerIndex: number
  ledgerHash: string
  parentHash: string
  accountRoot: string
  transactionRoot: string
  parentCloseTime: number
  closeTime: number
  closeTimeResolution: number
  closeFlags: number
  totalCoins: string
  transactions: LedgerTransaction[]
}

export interface LedgerRange {
  min: number
  max: number
}

export interface LedgerSourceTips {
  primary: number
  secondary: number
  effective: number
}

export interface LedgerSourcePreflight {
  networkId: number
  completeLedgerRanges: LedgerRange[]
  activationLedger: ValidatedLedger
  tips: LedgerSourceTips
}

export type SchemaRegistrationResult =
  | {
      status: 'accepted'
      transactionHash: string
      transactionIndex: number
      publisher: string
      schemaUid: string
      /** Exact parsed JCS memo committed by the XRPL transaction. */
      memoJson: JsonValue
      definition: SchemaDefinition
      resolved: ResolvedSchema
    }
  | {
      status: 'rejected'
      transactionHash: string
      transactionIndex: number
      publisher: string
      reasonCode: string
      memoJson?: unknown
    }

export type CredentialEventType = 'created' | 'accepted' | 'deleted'

export type CredentialDeletionCause =
  | 'issuer_revoked'
  | 'subject_rejected'
  | 'subject_removed'
  | 'expired_cleanup'
  | 'account_deleted'
  | 'self_deleted'

export interface CredentialMutation {
  transactionHash: string
  transactionIndex: number
  nodeIndex: number
  ledgerObjectId: string
  eventType: CredentialEventType
  issuer: string
  subject: string
  schemaUid: string
  uriHex?: string
  expiration?: number
  accepted: boolean
  deletionCause?: CredentialDeletionCause
  snapshot: Record<string, unknown>
}

export interface ExtractedCredentialMutations {
  mutations: CredentialMutation[]
  malformedCredentialNodes: number
}

export interface LedgerProjection {
  ledger: ValidatedLedger
  schemaRegistrations: SchemaRegistrationResult[]
  credentialMutations: CredentialMutation[]
  malformedCredentialNodes: number
}

export interface Checkpoint {
  ledgerIndex: number
  ledgerHash: string
  parentHash: string
  closeTime: number
  transactionCount: number
  transactionRoot: string | null
}

export type IndexerRuntimeState = 'starting' | 'catching_up' | 'ready' | 'halted'

export interface IndexerStatusUpdate {
  state: Exclude<IndexerRuntimeState, 'halted'>
  primarySourceTip?: number
  secondarySourceTip?: number
  lastAgreedLedgerIndex?: number
  lastAgreedLedgerHash?: string
}

export interface IndexerHaltStatus {
  primarySourceTip?: number
  secondarySourceTip?: number
  lastAgreedLedgerIndex?: number
  lastAgreedLedgerHash?: string
}

export interface SchemaCatalogEntry extends RegisteredSchema {
  resolved: ResolvedSchema
  description: string
  name: string
  transactionHash: string
}

export interface IndexerRepository {
  initializeProfile(profile: NetworkProfile): Promise<void>
  acquireLease(
    profileId: string,
    writerId: string,
    leaseDurationMs: number,
  ): Promise<AcquiredIndexerLease>
  renewLease(token: IndexerLeaseToken, leaseDurationMs: number): Promise<AcquiredIndexerLease>
  updateIndexerStatus(token: IndexerLeaseToken, status: IndexerStatusUpdate): Promise<void>
  releaseLease(token: IndexerLeaseToken): Promise<void>
  haltIndexer(token: IndexerLeaseToken, status: IndexerHaltStatus, errorCode: string): Promise<void>
  getLastCheckpoint(profileId: string): Promise<Checkpoint | undefined>
  getSchemaCatalog(profileId: string): Promise<SchemaCatalogEntry[]>
  persistLedger(
    profile: NetworkProfile,
    projection: LedgerProjection,
    token: IndexerLeaseToken,
    status: IndexerStatusUpdate,
  ): Promise<'inserted' | 'already_processed'>
}

export interface LedgerSource {
  connect(): Promise<void>
  disconnect(): Promise<void>
  preflight(profile: NetworkProfile): Promise<LedgerSourcePreflight>
  assertAmendmentEnabled(amendmentId: string): Promise<void>
  getValidatedLedgerIndex(): Promise<number>
  getValidatedLedgerTips(): Promise<LedgerSourceTips>
  getLedger(ledgerIndex: number): Promise<ValidatedLedger>
}
