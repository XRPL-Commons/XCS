import type { WalletSubmissionResult } from './useWallet'
import {
  clearIssuerEngineRecord,
  issuerOperationDefinitelyFailed,
  readIssuerEngineRecord,
  saveIssuerEngineRecord,
  type IssuerEngineRecord,
  type IssuerSchemaEngineContext,
} from '../utils/issuerEngine'
import { IndexedDbOperationJournal } from '../utils/operationJournal'

export function useIssuerEngineRecovery(context: () => IssuerSchemaEngineContext | undefined) {
  const pending = shallowRef<IssuerEngineRecord | null>(null)
  const saved = ref(false)
  const saving = ref(false)
  const error = ref('')
  const canRestart = ref(false)

  onMounted(async () => {
    const current = context()
    if (current) pending.value = readIssuerEngineRecord(localStorage, current.key)
    await checkFailure()
  })

  async function checkFailure(): Promise<boolean> {
    const current = context()
    const receipt = pending.value
    canRestart.value = false
    if (!current || !receipt) return false
    try {
      const operations = await new IndexedDbOperationJournal().list()
      if (pending.value === receipt && context()?.key === current.key) {
        canRestart.value = issuerOperationDefinitelyFailed(receipt, current.profileId, operations)
      }
    } catch {
      /* Missing local evidence must keep the original operation pending. */
    }
    return canRestart.value
  }

  async function restart(): Promise<void> {
    if (saving.value) return
    saving.value = true
    try {
      if (!(await checkFailure())) return
      const current = context()
      if (!current) return
      clearIssuerEngineRecord(localStorage, current.key)
      pending.value = null
      canRestart.value = false
      saved.value = false
      error.value = ''
    } finally {
      saving.value = false
    }
  }

  function stash(receipt: IssuerEngineRecord): void {
    const current = context()
    if (!current) return
    // A reload can reconcile the original signed transaction without issuing again.
    saveIssuerEngineRecord(localStorage, current.key, receipt)
    pending.value = receipt
    saved.value = false
    canRestart.value = false
  }

  async function retry(): Promise<void> {
    const current = context()
    const receipt = pending.value
    if (!current || !receipt || saving.value) return
    saving.value = true
    error.value = ''
    try {
      // The server independently requires the exact validated ledger evidence.
      await current.record(receipt)
      clearIssuerEngineRecord(localStorage, current.key)
      pending.value = null
      saved.value = true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving.value = false
      await checkFailure()
    }
  }

  async function finish(result: WalletSubmissionResult): Promise<void> {
    if (result.businessConfirmation === 'confirmed') await retry()
  }

  return { pending, saved, saving, error, canRestart, stash, retry, finish, checkFailure, restart }
}
