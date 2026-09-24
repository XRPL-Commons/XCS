import { canonicalJson, parseJson } from '#xcs/core/index.js'
import {
  createHostedPayloadLocation,
  publishHostedPayloadAndVerify,
  type PendingHostedPayload,
} from './hostedPayload'
import type { StoredOperation } from './operationJournal'

const PREFIX = 'xcs-hosted-publication-v1:'
const MAX_ENTRIES = 20
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface HostedPublicationJob {
  readonly id: string
  readonly createdAt: string
  readonly payload: PendingHostedPayload
}

type PublicationDraft = Omit<PendingHostedPayload, 'signedTransactionBlob' | 'transactionHash'>

/** The journal is written first. Recover from it if the second storage write was interrupted. */
export function recoverPublicationSignatures(
  jobs: HostedPublicationJob[],
  operations: StoredOperation[],
): HostedPublicationJob[] {
  return jobs.map((job) => {
    if (job.payload.transactionHash) return job
    const operation = operations.find(
      (item) =>
        item.business?.action === 'credential-issue' &&
        item.business.publicationJobId === job.id &&
        item.profileId === job.payload.network &&
        item.business.credentialUri === job.payload.credentialUri &&
        item.txHash &&
        item.txBlob,
    )
    return operation?.txHash && operation.txBlob
      ? validate({
          ...job,
          payload: {
            ...job.payload,
            transactionHash: operation.txHash,
            signedTransactionBlob: operation.txBlob,
          },
        })
      : job
  })
}

function validate(job: HostedPublicationJob): HostedPublicationJob {
  if (!job || !ID.test(job.id) || !Number.isFinite(Date.parse(job.createdAt))) {
    throw new Error('PAYLOAD_RECOVERY_INVALID')
  }
  const payload = job.payload
  if (!payload || typeof payload.network !== 'string' || !payload.network.length) {
    throw new Error('PAYLOAD_RECOVERY_INVALID')
  }
  const parsed = parseJson(payload.canonicalPayload)
  if (canonicalJson(parsed) !== payload.canonicalPayload)
    throw new Error('PAYLOAD_RECOVERY_INVALID')
  const location = createHostedPayloadLocation(
    new URL(payload.credentialUri).origin,
    payload.canonicalPayload,
  )
  if (payload.locator !== location.locator || payload.credentialUri !== location.credentialUri) {
    throw new Error('PAYLOAD_RECOVERY_INVALID')
  }
  const unsigned = payload.signedTransactionBlob === '' && payload.transactionHash === ''
  if (
    !unsigned &&
    (!/^[0-9a-f]{64}$/i.test(payload.transactionHash) ||
      !/^(?:[0-9a-f]{2}){1,65536}$/i.test(payload.signedTransactionBlob))
  ) {
    throw new Error('PAYLOAD_RECOVERY_INVALID')
  }
  return job
}

/** Per-job keys avoid overwriting another tab's queue. Never evict unpublished data. */
export function createHostedPublicationQueue(storage: Storage) {
  function inspect(): { jobs: HostedPublicationJob[]; invalidKeys: string[] } {
    const jobs: HostedPublicationJob[] = []
    const invalidKeys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(PREFIX)) continue
      const item = storage.getItem(key)
      if (item === null) continue
      try {
        const job = validate(JSON.parse(item) as HostedPublicationJob)
        if (key !== PREFIX + job.id) throw new Error('PAYLOAD_RECOVERY_INVALID')
        jobs.push(job)
      } catch {
        invalidKeys.push(key)
      }
    }
    return { jobs: jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), invalidKeys }
  }

  function list(): HostedPublicationJob[] {
    return inspect().jobs
  }

  function save(job: HostedPublicationJob): HostedPublicationJob {
    validate(job)
    try {
      storage.setItem(PREFIX + job.id, JSON.stringify(job))
    } catch (cause) {
      throw new Error('PAYLOAD_RECOVERY_STORAGE_UNAVAILABLE', { cause })
    }
    return job
  }

  function begin(payload: PublicationDraft): HostedPublicationJob {
    const { jobs, invalidKeys } = inspect()
    if (jobs.length + invalidKeys.length >= MAX_ENTRIES)
      throw new Error('PAYLOAD_RECOVERY_QUEUE_FULL')
    // Save the consented public bytes before invoking the wallet. If storage is
    // disabled or full, do not allow an irreversible ledger submission.
    return save({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      payload: { ...payload, transactionHash: '', signedTransactionBlob: '' },
    })
  }

  function signed(id: string, signature: { txHash: string; txBlob: string }): HostedPublicationJob {
    const job = list().find((item) => item.id === id)
    if (!job) throw new Error('PAYLOAD_RECOVERY_NOT_FOUND')
    return save({
      ...job,
      payload: {
        ...job.payload,
        transactionHash: signature.txHash,
        signedTransactionBlob: signature.txBlob,
      },
    })
  }

  function remove(id: string): void {
    if (!ID.test(id)) throw new Error('PAYLOAD_RECOVERY_INVALID')
    storage.removeItem(PREFIX + id)
  }

  function removeInvalid(key: string): void {
    if (!inspect().invalidKeys.includes(key)) throw new Error('PAYLOAD_RECOVERY_INVALID')
    storage.removeItem(key)
  }

  async function publish(
    id: string,
    publisher: Parameters<typeof publishHostedPayloadAndVerify>[1],
    fetchImpl?: typeof fetch,
    operations: StoredOperation[] = [],
  ) {
    const job = recoverPublicationSignatures(list(), operations).find((item) => item.id === id)
    if (!job?.payload.transactionHash) throw new Error('PAYLOAD_RECOVERY_SIGNATURE_MISSING')
    // This only uploads. The API independently requires a validated, indexed
    // CredentialCreate. Never submit a transaction or ask for a new signature.
    const proof = await publishHostedPayloadAndVerify(job.payload, publisher, fetchImpl)
    remove(id)
    return proof
  }

  return { list, inspect, begin, signed, remove, removeInvalid, publish }
}
