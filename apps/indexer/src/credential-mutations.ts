import { parsePayloadUri } from '@xcs-protocol/core'
import { isValidClassicAddress } from 'xrpl'

import { decodeHexUtf8 } from './serialization.js'

import type {
  CredentialDeletionCause,
  CredentialMutation,
  ExtractedCredentialMutations,
  LedgerTransaction,
} from './types.js'

export const CREDENTIAL_ACCEPTED_FLAG = 0x0001_0000

type NodeKind = 'CreatedNode' | 'ModifiedNode' | 'DeletedNode'

interface NormalizedNode {
  kind: NodeKind
  ledgerObjectId: string
  fields: Record<string, unknown>
  previousFields: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeNode(value: unknown): NormalizedNode | undefined {
  const wrapper = record(value)
  if (wrapper === undefined) return undefined

  for (const kind of ['CreatedNode', 'ModifiedNode', 'DeletedNode'] as const) {
    const node = record(wrapper[kind])
    if (node === undefined || node.LedgerEntryType !== 'Credential') continue
    const ledgerObjectId = node.LedgerIndex
    if (typeof ledgerObjectId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(ledgerObjectId)) {
      return undefined
    }
    const fields = record(kind === 'CreatedNode' ? node.NewFields : node.FinalFields)
    if (fields === undefined) return undefined
    return {
      kind,
      ledgerObjectId: ledgerObjectId.toLowerCase(),
      fields,
      previousFields: record(node.PreviousFields) ?? {},
    }
  }
  return undefined
}

function uint32(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
    ? value
    : undefined
}

function isAccepted(fields: Record<string, unknown>): boolean {
  const flags = uint32(fields.Flags) ?? 0
  return (flags & CREDENTIAL_ACCEPTED_FLAG) !== 0
}

function deletionCause(
  transactionType: unknown,
  actor: unknown,
  fields: Record<string, unknown>,
  closeTime: number,
): CredentialDeletionCause {
  if (transactionType === 'AccountDelete') return 'account_deleted'
  if (transactionType === 'CredentialDelete') {
    if (actor === fields.Issuer) return 'issuer_revoked'
    if (actor === fields.Subject) {
      return isAccepted(fields) ? 'subject_removed' : 'subject_rejected'
    }
  }
  const expiration = uint32(fields.Expiration)
  if (expiration !== undefined && expiration <= closeTime) return 'expired_cleanup'
  return 'self_deleted'
}

export function extractCredentialMutations(
  transaction: LedgerTransaction,
  closeTime: number,
  knownSchemaUids: ReadonlySet<string>,
): ExtractedCredentialMutations {
  const affectedNodes = Array.isArray(transaction.metadata.AffectedNodes)
    ? transaction.metadata.AffectedNodes
    : []
  const mutations: CredentialMutation[] = []
  let malformedCredentialNodes = 0

  affectedNodes.forEach((rawNode, nodeIndex) => {
    const wrapper = record(rawNode)
    const containsCredential = ['CreatedNode', 'ModifiedNode', 'DeletedNode'].some(
      (kind) => record(wrapper?.[kind])?.LedgerEntryType === 'Credential',
    )
    if (!containsCredential) return

    const node = normalizeNode(rawNode)
    if (node === undefined) {
      malformedCredentialNodes += 1
      return
    }

    const issuer = node.fields.Issuer
    const subject = node.fields.Subject
    const credentialType = node.fields.CredentialType
    if (
      typeof issuer !== 'string' ||
      typeof subject !== 'string' ||
      !isValidClassicAddress(issuer) ||
      !isValidClassicAddress(subject) ||
      typeof credentialType !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(credentialType)
    ) {
      malformedCredentialNodes += 1
      return
    }

    const schemaUid = credentialType.toLowerCase()
    if (!knownSchemaUids.has(schemaUid)) return

    if (
      (node.fields.Flags !== undefined && uint32(node.fields.Flags) === undefined) ||
      (node.fields.Expiration !== undefined && uint32(node.fields.Expiration) === undefined) ||
      (node.previousFields.Flags !== undefined && uint32(node.previousFields.Flags) === undefined)
    ) {
      malformedCredentialNodes += 1
      return
    }

    const uriHex = node.fields.URI
    if (typeof uriHex !== 'string') {
      malformedCredentialNodes += 1
      return
    }
    try {
      parsePayloadUri(decodeHexUtf8(uriHex))
    } catch {
      malformedCredentialNodes += 1
      return
    }

    const accepted = isAccepted(node.fields)
    let eventType: CredentialMutation['eventType']
    if (node.kind === 'CreatedNode') {
      eventType = 'created'
    } else if (node.kind === 'DeletedNode') {
      eventType = 'deleted'
    } else {
      const previousFlags = uint32(node.previousFields.Flags)
      if (
        !accepted ||
        (previousFlags !== undefined && (previousFlags & CREDENTIAL_ACCEPTED_FLAG) !== 0)
      ) {
        return
      }
      eventType = 'accepted'
    }

    const expiration = uint32(node.fields.Expiration)
    const cause =
      eventType === 'deleted'
        ? deletionCause(
            transaction.transaction.TransactionType,
            transaction.transaction.Account,
            node.fields,
            closeTime,
          )
        : undefined

    mutations.push({
      transactionHash: transaction.hash,
      transactionIndex: transaction.transactionIndex,
      nodeIndex,
      ledgerObjectId: node.ledgerObjectId,
      eventType,
      issuer,
      subject,
      schemaUid,
      uriHex,
      ...(expiration === undefined ? {} : { expiration }),
      accepted,
      ...(cause === undefined ? {} : { deletionCause: cause }),
      snapshot: { ...node.fields },
    })
  })

  return { mutations, malformedCredentialNodes }
}
