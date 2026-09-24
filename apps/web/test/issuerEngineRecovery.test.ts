import { ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIssuerEngineRecovery } from '../app/composables/useIssuerEngineRecovery'
import type { WalletSubmissionResult } from '../app/composables/useWallet'
import type { IssuerSchemaEngineContext } from '../app/utils/issuerEngine'
import { IndexedDbOperationJournal, type StoredOperation } from '../app/utils/operationJournal'

const references = new Map<string, string>()
const storage = {
  getItem: (key: string) => references.get(key) ?? null,
  setItem: (key: string, value: string) => {
    references.set(key, value)
  },
  removeItem: (key: string) => {
    references.delete(key)
  },
}
const receipt = {
  transactionHash: 'a'.repeat(64),
  payloadId: '12345678-1234-1234-1234-123456789abc',
  visibility: 'private' as const,
  publicFields: [],
}
const validated = (businessConfirmation: 'confirmed' | 'timeout') =>
  ({ txHash: receipt.transactionHash, businessConfirmation }) as WalletSubmissionResult

beforeEach(() => {
  references.clear()
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('shallowRef', shallowRef)
  vi.stubGlobal('onMounted', (fn: () => void) => fn())
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('indexedDB', {})
  vi.spyOn(IndexedDbOperationJournal.prototype, 'list').mockResolvedValue([])
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function context(record = vi.fn(async () => {})): IssuerSchemaEngineContext {
  return { key: 'account:invite', profileId: 'testnet', beforeSign: vi.fn(async () => {}), record }
}

function operation(overrides: Partial<StoredOperation> = {}): StoredOperation {
  return {
    operationId: 'operation',
    account: 'issuer',
    profileId: 'testnet',
    networkId: 1,
    transactionType: 'CredentialCreate',
    createdAt: '2026-09-24T00:00:00Z',
    updatedAt: '2026-09-24T00:00:01Z',
    stage: 'expired',
    txHash: receipt.transactionHash,
    lastLedgerSequence: 100,
    ...overrides,
  }
}

describe('issuer metadata recovery', () => {
  it('keeps signed references when ledger success is not yet indexed', async () => {
    const current = context()
    const recovery = useIssuerEngineRecovery(() => current)
    recovery.stash(receipt)
    await recovery.finish(validated('timeout'))
    expect(current.record).not.toHaveBeenCalled()
    expect(recovery.pending.value).toEqual(receipt)
    expect(recovery.saved.value).toBe(false)
  })
  it('records only after confirmed business evidence and clears completed references', async () => {
    const current = context()
    const recovery = useIssuerEngineRecovery(() => current)
    recovery.stash(receipt)
    await recovery.finish(validated('confirmed'))
    expect(current.record).toHaveBeenCalledExactlyOnceWith(receipt)
    expect(recovery.pending.value).toBeNull()
    expect(recovery.saved.value).toBe(true)
    expect(references.size).toBe(0)
  })
  it('reconciles the same reference after an interrupted recording request and reload', async () => {
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('NETWORK_UNAVAILABLE'))
      .mockResolvedValueOnce(undefined)
    const current = context(record)
    const first = useIssuerEngineRecovery(() => current)
    first.stash(receipt)
    await first.finish(validated('confirmed'))
    expect(first.error.value).toBe('NETWORK_UNAVAILABLE')
    const reloaded = useIssuerEngineRecovery(() => current)
    expect(reloaded.pending.value).toEqual(receipt)
    await reloaded.retry()
    expect(record).toHaveBeenNthCalledWith(2, receipt)
    expect(current.beforeSign).not.toHaveBeenCalled()
    expect(reloaded.saved.value).toBe(true)
  })
  it('does not restore another account or invitation recovery reference', () => {
    const current = context()
    useIssuerEngineRecovery(() => current).stash(receipt)
    expect(
      useIssuerEngineRecovery(() => ({ ...current, key: 'other-account:invite' })).pending.value,
    ).toBeNull()
    expect(
      useIssuerEngineRecovery(() => ({ ...current, key: 'account:other-invite' })).pending.value,
    ).toBeNull()
  })
  it.each([
    ['expired', operation()],
    [
      'validated tec failure',
      operation({ stage: 'validated', engineResult: 'tecNO_TARGET', ledgerIndex: 99 }),
    ],
  ])('permits an explicit new attempt after matching journal %s', async (_name, failed) => {
    vi.mocked(IndexedDbOperationJournal.prototype.list).mockResolvedValue([failed])
    const current = context()
    const recovery = useIssuerEngineRecovery(() => current)
    recovery.stash(receipt)
    expect(await recovery.checkFailure()).toBe(true)
    await recovery.restart()
    expect(recovery.pending.value).toBeNull()
    expect(references.size).toBe(0)
    expect(current.record).not.toHaveBeenCalled()
  })
  it.each([
    ['unknown', []],
    ['pending', [operation({ stage: 'pending' })]],
    ['generic failure', [operation({ stage: 'failed', engineResult: 'tefPAST_SEQ' })]],
    [
      'ledger success',
      [operation({ stage: 'validated', engineResult: 'tesSUCCESS', ledgerIndex: 99 })],
    ],
    ['unproven failure', [operation({ stage: 'validated', engineResult: 'tecNO_TARGET' })]],
    ['different transaction', [operation({ txHash: 'b'.repeat(64) })]],
    ['different network', [operation({ profileId: 'other-testnet' })]],
  ])('keeps references when evidence is %s', async (_name, operations) => {
    vi.mocked(IndexedDbOperationJournal.prototype.list).mockResolvedValue(operations)
    const recovery = useIssuerEngineRecovery(() => context())
    recovery.stash(receipt)
    expect(await recovery.checkFailure()).toBe(false)
    await recovery.restart()
    expect(recovery.pending.value).toEqual(receipt)
    expect(references.size).toBe(1)
  })
  it('rechecks evidence at the reset action instead of trusting a stale displayed result', async () => {
    const list = vi
      .mocked(IndexedDbOperationJournal.prototype.list)
      .mockResolvedValue([operation()])
    const recovery = useIssuerEngineRecovery(() => context())
    recovery.stash(receipt)
    expect(await recovery.checkFailure()).toBe(true)
    list.mockResolvedValue([])
    await recovery.restart()
    expect(recovery.pending.value).toEqual(receipt)
  })
})
