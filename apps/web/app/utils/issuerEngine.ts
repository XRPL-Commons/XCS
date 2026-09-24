import {
  parsePayloadUri,
  payloadDigest,
  type ResolvedSchema,
  type SchemaDefinition,
} from '#xcs/core/index.js'
import type { WalletSubmissionResult } from '../composables/useWallet'
import type { StoredOperation } from './operationJournal'

export interface IssuerWallet {
  address: string
  networkId: number
  verifiedAt?: string | null
}
export interface IssuerIssuanceContext {
  existingCredential?: { profileId: string; generationId: string } | null
  invite: {
    id: string
    organizationId: string
    profileId: string
    schemaUid: string
    claimedBy: string
    expiresAt: string
    revokedAt: string | null
    deliveryEmail?: string | null
  }
  schema: {
    schemaUid: string
    profileId: string
    name: string
    definition: SchemaDefinition
    resolvedDefinition: ResolvedSchema
    publisher: string
  }
  recipient: { id: string; displayName: string | null; wallets: IssuerWallet[] }
  organization: { id: string; name: string }
  issuerWallets: IssuerWallet[]
}
export interface IssuerCredentialDetail {
  profileId: string
  generationId: string
  schemaUid: string
  organizationId: string
  inviteId: string
  recipientUserId: string
  recipient?: { id: string; displayName: string | null }
  issuerAddress: string
  subjectAddress: string
  visibility: 'public' | 'private'
  publicFields: string[]
  payloadId: string | null
  creationTransactionHash: string
  status: {
    accepted: boolean | null
    expiration: number | null
    deletedLedgerIndex: number | null
    deletionCause: string | null
  }
  schema: { name: string }
}
export interface IssuerVisibility {
  visibility: 'public' | 'private'
  publicFields: string[]
}
export interface IssuerPayloadReceipt {
  payloadId: string
  credentialUri: string
  payloadDigest: string
}

export function assertIssuerPayloadReceipt(
  receipt: IssuerPayloadReceipt,
  canonicalPayload: string,
): void {
  const uri = parsePayloadUri(receipt.credentialUri)
  const digest = payloadDigest(canonicalPayload)
  if (
    uri.kind !== 'https' ||
    uri.digestHex !== digest ||
    receipt.payloadDigest !== digest ||
    new TextEncoder().encode(receipt.credentialUri).byteLength > 128
  ) {
    throw new Error('ISSUER_PAYLOAD_DIGEST_MISMATCH')
  }
}
export interface IssuerEngineRecord {
  transactionHash: string
  payloadId?: string
  visibility?: 'public' | 'private'
  publicFields?: string[]
}
export interface IssuerSchemaEngineContext {
  key: string
  profileId: string
  beforeSign: (publisher: string) => Promise<void>
  record: (receipt: IssuerEngineRecord) => Promise<void>
}
export interface IssuerIssueEngineContext extends IssuerSchemaEngineContext {
  inviteId: string
  existingCredential?: { profileId: string; generationId: string } | null
  schemaUid: string
  schemaName: string
  subjectAddress: string
  recipientLabel: string
  preparePayload: (
    canonicalPayload: string,
    visibility: IssuerVisibility,
  ) => Promise<IssuerPayloadReceipt>
}
export interface IssuerRevokeEngineContext {
  profileId: string
  generationId: string
  schemaUid: string
  schemaName: string
  issuerAddress: string
  subjectAddress: string
  recipientLabel: string
  beforeSign: (publisher: string) => Promise<void>
  onSigned?: (transactionHash: string) => void
  afterConfirmed?: (result: WalletSubmissionResult) => Promise<void>
}

export function assertIssuerWallet(wallets: readonly IssuerWallet[], address: string): void {
  if (!wallets.some((wallet) => wallet.address === address && wallet.networkId === 1)) {
    throw new Error('ISSUER_VERIFIED_WALLET_REQUIRED')
  }
}

/** Recheck server-owned recipient and schema bindings; email delivery is not identity proof. */
export function assertIssuanceContextUnchanged(
  expected: IssuerIssuanceContext,
  current: IssuerIssuanceContext,
  subject: string,
  publisher: string,
): void {
  if (current.existingCredential) throw new Error('ISSUER_INVITE_ALREADY_ISSUED')
  if (
    current.invite.id !== expected.invite.id ||
    current.invite.organizationId !== expected.invite.organizationId ||
    current.invite.profileId !== expected.invite.profileId ||
    current.invite.schemaUid !== expected.invite.schemaUid ||
    current.invite.claimedBy !== expected.invite.claimedBy ||
    current.recipient.id !== expected.recipient.id ||
    current.schema.schemaUid !== expected.schema.schemaUid ||
    current.invite.revokedAt !== null ||
    !current.recipient.wallets.some(
      (wallet) => wallet.address === subject && wallet.networkId === 1,
    )
  ) {
    throw new Error('ISSUER_CONTEXT_CHANGED')
  }
  assertIssuerWallet(current.issuerWallets, publisher)
}

export function claimPublicPointer(name: string): string {
  return `/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`
}

/** The editor offers whole top-level fields; nested selector validation remains server-owned. */
export function issuerVisibilityPreview(
  claims: Record<string, unknown>,
  setting: IssuerVisibility,
): { public: Record<string, unknown>; private: Record<string, unknown> } {
  const visible = Object.create(null) as Record<string, unknown>
  const hidden = Object.create(null) as Record<string, unknown>
  for (const [name, value] of Object.entries(claims)) {
    const target =
      setting.visibility === 'public' || setting.publicFields.includes(claimPublicPointer(name))
        ? visible
        : hidden
    target[name] = value
  }
  return { public: visible, private: hidden }
}

const HASH = /^[0-9a-f]{64}$/i
/** Store only transaction/object references, never claims, delivery contacts or bearer tokens. */
export function saveIssuerEngineRecord(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  receipt: IssuerEngineRecord,
): void {
  if (!HASH.test(receipt.transactionHash)) throw new Error('ISSUER_TRANSACTION_HASH_INVALID')
  storage.setItem(
    `xcs-issuer-engine:${key}`,
    JSON.stringify({
      transactionHash: receipt.transactionHash,
      ...(receipt.payloadId === undefined ? {} : { payloadId: receipt.payloadId }),
      ...(receipt.visibility === undefined ? {} : { visibility: receipt.visibility }),
      ...(receipt.publicFields === undefined ? {} : { publicFields: receipt.publicFields }),
    }),
  )
}
export function readIssuerEngineRecord(
  storage: Pick<Storage, 'getItem'>,
  key: string,
): IssuerEngineRecord | null {
  try {
    const raw: unknown = JSON.parse(storage.getItem(`xcs-issuer-engine:${key}`) ?? 'null')
    if (!raw || typeof raw !== 'object') return null
    const record = raw as Record<string, unknown>
    if (typeof record.transactionHash !== 'string' || !HASH.test(record.transactionHash))
      return null
    if (
      record.payloadId !== undefined &&
      (typeof record.payloadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.payloadId))
    )
      return null
    if (
      record.visibility !== undefined &&
      record.visibility !== 'private' &&
      record.visibility !== 'public'
    )
      return null
    if (
      record.publicFields !== undefined &&
      (!Array.isArray(record.publicFields) ||
        record.publicFields.some((field) => typeof field !== 'string'))
    )
      return null
    return {
      transactionHash: record.transactionHash,
      ...(typeof record.payloadId === 'string' ? { payloadId: record.payloadId } : {}),
      ...(record.visibility === 'private' || record.visibility === 'public'
        ? { visibility: record.visibility }
        : {}),
      ...(Array.isArray(record.publicFields)
        ? { publicFields: record.publicFields as string[] }
        : {}),
    }
  } catch {
    return null
  }
}
export function clearIssuerEngineRecord(storage: Pick<Storage, 'removeItem'>, key: string): void {
  storage.removeItem(`xcs-issuer-engine:${key}`)
}

/** A timeout, rejected RPC call or generic failed stage does not prove ledger absence. */
export function issuerOperationDefinitelyFailed(
  receipt: IssuerEngineRecord,
  profileId: string,
  operations: readonly StoredOperation[],
): boolean {
  return operations.some((operation) => {
    if (
      operation.txHash?.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
      operation.profileId !== profileId
    )
      return false
    if (operation.stage === 'expired')
      return Number.isSafeInteger(operation.lastLedgerSequence) && operation.lastLedgerSequence! > 0
    return (
      operation.stage === 'validated' &&
      typeof operation.engineResult === 'string' &&
      /^tec[A-Z_]+$/.test(operation.engineResult) &&
      Number.isSafeInteger(operation.ledgerIndex) &&
      operation.ledgerIndex! > 0
    )
  })
}
