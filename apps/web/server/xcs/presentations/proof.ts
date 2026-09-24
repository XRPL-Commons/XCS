import { eq } from 'drizzle-orm'
import {
  appPresentationProofs,
  appPresentations,
  type PresentationProofRequest,
} from '#db/schema/app'
import type { XcsDatabase } from '../../lib/db/index.js'
import { verifyWalletProof, type WalletProof } from '../auth/wallet-proof'
import type { managedCredentialRow } from '../recipient/repository'

export type HolderProof =
  | { status: 'not_provided' | 'invalid' }
  | ({
      status: 'verified'
      address: string
      networkId: number
      verifiedAt: string
      message: string
      purpose: 'presentation_authorization'
      keyAuthority: 'master_key_address_only'
    } & WalletProof)

type CredentialRow = Awaited<ReturnType<typeof managedCredentialRow>>

/** Fixed field order and JSON values avoid newline/field injection in wallet prompts. */
export function presentationProofMessage(request: PresentationProofRequest): string {
  return [
    'XCS presentation authorization v1',
    'I authorize this credential presentation with the scope and audience below.',
    'This is not a transaction, payment, wallet link or transfer of ownership.',
    'The challenge expires in five minutes; the presentation remains valid until revoked.',
    ...(
      [
        'version',
        'origin',
        'challengeId',
        'presentationId',
        'nonce',
        'issuedAt',
        'expiresAt',
        'profileId',
        'networkId',
        'generationId',
        'issuerAddress',
        'subjectAddress',
        'schemaUid',
        'payloadDigest',
        'visibility',
        'publicFields',
        'scope',
        'verifierOrganizationId',
      ] as const
    ).map((key) => `${key}: ${JSON.stringify(request[key])}`),
  ].join('\n')
}

export function proofMatchesCredential(
  request: PresentationProofRequest,
  row: CredentialRow,
): boolean {
  const m = row.metadata
  return (
    request.version === 1 &&
    request.profileId === m.profileId &&
    request.generationId === m.generationId &&
    request.networkId === row.networkId &&
    request.issuerAddress === m.issuerAddress &&
    request.subjectAddress === m.subjectAddress &&
    request.schemaUid === m.schemaUid &&
    request.payloadDigest === m.payloadDigest &&
    request.visibility === m.visibility &&
    JSON.stringify(request.publicFields) === JSON.stringify([...m.publicFields].sort())
  )
}

/** Historical signature evidence, not proof of the viewer's presence or current ledger key authority. */
export async function loadPresentationProof(
  db: XcsDatabase,
  id: string,
  row: CredentialRow,
): Promise<HolderProof> {
  const [proof] = await db
    .select()
    .from(appPresentationProofs)
    .where(eq(appPresentationProofs.presentationId, id))
  if (!proof) return { status: 'not_provided' }
  const [presentation] = await db.select().from(appPresentations).where(eq(appPresentations.id, id))
  const request = proof.request
  const issuedAt = Date.parse(request.issuedAt),
    expiresAt = Date.parse(request.expiresAt)
  if (
    !presentation ||
    request.presentationId !== id ||
    presentation.profileId !== request.profileId ||
    presentation.generationId !== request.generationId ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - issuedAt !== 300000 ||
    proof.verifiedAt.getTime() < issuedAt ||
    proof.verifiedAt.getTime() > expiresAt ||
    request.scope !== presentation.scope ||
    request.verifierOrganizationId !== presentation.verifierOrganizationId ||
    !proofMatchesCredential(request, row) ||
    presentationProofMessage(request) !== proof.message ||
    !verifyWalletProof(proof.message, row.metadata.subjectAddress, proof)
  )
    return { status: 'invalid' }
  return {
    status: 'verified',
    address: row.metadata.subjectAddress,
    networkId: row.networkId,
    verifiedAt: proof.verifiedAt.toISOString(),
    message: proof.message,
    signature: proof.signature,
    publicKey: proof.publicKey,
    scheme: proof.scheme,
    purpose: 'presentation_authorization',
    keyAuthority: 'master_key_address_only',
  }
}
