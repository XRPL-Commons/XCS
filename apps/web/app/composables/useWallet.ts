import type { NetworkProfile } from '#xcs/core/index.js'
import { useWallet as useXrplConnectWallet } from '@xrpl-commons/xrpl-connect-vue'
import {
  autofillXcsTransaction,
  connectAndValidateNetwork,
  getTransactionStatus,
  signPreparedAndSubmit,
  submitSignedTransaction,
  type ReliableSubmissionResult,
  type ValidatedSignature,
} from '#xcs/sdk/index.js'
import { encode, type SubmittableTransaction } from 'xrpl'
import { supportsFetchAccount, type AccountInfo, type Transaction } from 'xrpl-connect'
import {
  reconfirmValidatedBusinessOperation,
  waitForIndexedBusinessEvidence,
} from '~/utils/businessConfirmation'
import {
  canRetryOperation,
  IndexedDbOperationJournal,
  isConfirmableBusinessContext,
  isGenerationBoundBusinessContext,
  validateOperationBusinessContext,
  type BusinessConfirmation,
  type BusinessEvidence,
  type OperationBusinessContext,
  type StoredOperation,
} from '~/utils/operationJournal'
import { assertCredentialGenerationCurrent } from '~/utils/credentialReview'
import { assertPublicRpcUrl } from '~/utils/publicRpcUrl'
import { assertTransactionSigner } from '~/utils/transactions'
import { closeWalletRpc, finishWalletOperation } from '~/utils/walletOperationCleanup'
import { refreshWalletAccount } from '~/utils/walletConnection'
import { requiresGemWalletRawSigning, signGemWalletCredential } from '~/utils/gemWalletRawSigning'
import {
  OTSU_SIGNING_ACCOUNT_UNAVAILABLE,
  normalizeWalletTransactionError,
} from '~/utils/walletCompatibility'
import {
  assertValidatedTesSuccess,
  createWalletSigner,
  transactionForWalletSigning,
  validateStoredRecoveryMaterial,
} from '~/utils/walletSubmission'

const serverAccount = shallowRef<AccountInfo | null>(null)
const walletBusy = ref(false)
const operations = shallowRef<StoredOperation[]>([])
const preparedProfiles = new WeakMap<object, NetworkProfile>()
const preparedWalletSessions = new WeakMap<object, string>()
const rawSigningConsents = new WeakMap<object, string>()
let journal: IndexedDbOperationJournal | undefined

export interface WalletSubmissionResult extends ReliableSubmissionResult {
  readonly businessConfirmation?: Exclude<BusinessConfirmation, 'pending'> | undefined
  readonly businessEvidence?: BusinessEvidence | undefined
}

function operationJournal(): IndexedDbOperationJournal {
  if (!import.meta.client) throw new Error('WALLET_BROWSER_REQUIRED')
  journal ??= new IndexedDbOperationJournal()
  return journal
}

function assertWalletTestnet(connectedAccount: AccountInfo): void {
  if (connectedAccount.network.id !== 'testnet') throw new Error('WALLET_TESTNET_REQUIRED')
}

function walletSessionKey(account: AccountInfo | null, walletId: string | undefined): string {
  if (!account || !walletId) return ''
  return `${walletId}:${account.address}:${account.network.id}`
}

function assertWalletContext(
  transaction: Transaction,
  address: string,
  expectedSessionKey: string,
  account: AccountInfo | null,
  walletId: string | undefined,
): void {
  if (walletSessionKey(account, walletId) !== expectedSessionKey) {
    throw new Error('WALLET_CHANGED_AFTER_PREVIEW')
  }
  if (!account || account.address !== address) {
    throw new Error('WALLET_CHANGED_AFTER_PREVIEW')
  }
  assertWalletTestnet(account)
  assertTransactionSigner(transaction, address)
}

function sameProfile(left: NetworkProfile, right: NetworkProfile): boolean {
  return (
    left.profileId === right.profileId &&
    left.xcsVersion === right.xcsVersion &&
    left.networkId === right.networkId &&
    left.requiredAmendment === right.requiredAmendment &&
    left.registryAddress === right.registryAddress &&
    left.registrationAmountDrops === right.registrationAmountDrops &&
    left.activationLedgerIndex === right.activationLedgerIndex &&
    left.activationLedgerHash === right.activationLedgerHash
  )
}

export function useWallet() {
  const { $xrplClientFactory } = useNuxtApp()
  const xrplConnect = import.meta.client ? useXrplConnectWallet() : undefined
  const walletManager = xrplConnect?.manager
  const disconnecting = ref(walletManager?.connected !== true)
  // rc.2's Vue binding waits for provider teardown before clearing its account.
  // Stop presenting that old account as usable as soon as disconnect starts.
  const invalidateSession = () => {
    disconnecting.value = true
  }
  const approveSession = () => {
    disconnecting.value = false
  }
  if (walletManager) {
    walletManager.on('disconnecting', invalidateSession)
    walletManager.on('connect', approveSession)
    onScopeDispose(() => {
      walletManager.off('disconnecting', invalidateSession)
      walletManager.off('connect', approveSession)
    })
  }
  const account = computed(() =>
    disconnecting.value ? null : (xrplConnect?.account.value ?? serverAccount.value),
  )
  const error = computed(() => xrplConnect?.error.value?.message ?? null)
  const busy = computed(() => walletBusy.value || xrplConnect?.connecting.value === true)
  const config = useRuntimeConfig()
  const {
    getActiveNetworkProfile,
    getCredential,
    getCredentialEventByTransaction,
    getNetworkReadiness,
    getSchemaRegistrationByTransaction,
  } = useXcsApi()

  async function assertBusinessGenerationCurrent(
    business: OperationBusinessContext | undefined,
    profileId: string,
  ): Promise<void> {
    if (!isGenerationBoundBusinessContext(business)) return
    const credential = await getCredential(
      business.issuer,
      business.subject,
      business.schemaUid,
      profileId,
    )
    assertCredentialGenerationCurrent(credential, business)
  }

  function loadIndexedBusinessEvidence(
    business: OperationBusinessContext,
    profileId: string,
    txHash: string,
  ): Promise<unknown> {
    return business.action === 'schema-register'
      ? getSchemaRegistrationByTransaction(txHash, profileId)
      : getCredentialEventByTransaction(
          business.issuer,
          business.subject,
          business.schemaUid,
          txHash,
          profileId,
        )
  }

  async function confirmBusinessEvent(
    business: OperationBusinessContext | undefined,
    profileId: string,
    txHash: string,
    operationStore: IndexedDbOperationJournal,
    operationId: string,
  ): Promise<Pick<WalletSubmissionResult, 'businessConfirmation' | 'businessEvidence'>> {
    if (!isConfirmableBusinessContext(business)) return {}
    try {
      const outcome = await waitForIndexedBusinessEvidence({
        business,
        txHash,
        loadEvidence: () => loadIndexedBusinessEvidence(business, profileId, txHash),
      })
      await operationStore.setBusinessConfirmation(
        operationId,
        outcome.confirmation,
        new Date().toISOString(),
        outcome.evidence,
      )
      return {
        businessConfirmation: outcome.confirmation,
        businessEvidence: outcome.evidence,
      }
    } catch (error) {
      const confirmation =
        error instanceof Error &&
        ['BUSINESS_EVIDENCE_MISMATCH', 'BUSINESS_EVIDENCE_RESPONSE_INVALID'].includes(error.message)
          ? 'mismatch'
          : 'timeout'
      await operationStore.setBusinessConfirmation(
        operationId,
        confirmation,
        new Date().toISOString(),
      )
      return { businessConfirmation: confirmation }
    }
  }

  function requireWalletManager() {
    if (!walletManager) throw new Error('WALLET_BROWSER_REQUIRED')
    return walletManager
  }

  async function refreshConnectedWallet(): Promise<void> {
    const manager = requireWalletManager()
    const adapter = manager.wallet
    if (!adapter || !supportsFetchAccount(adapter)) return
    // Xaman already binds every signature to the connected account. Its live
    // ping can omit optional network metadata, so the rc.2 adapter must not be
    // used as a second connection gate after the initial OAuth result.
    if (adapter.id === 'xaman') {
      if (!account.value) throw new Error('WALLET_NOT_CONNECTED')
      assertWalletTestnet(account.value)
      return
    }
    const refreshed = await refreshWalletAccount({
      manager,
      disconnect: () => xrplConnect!.disconnect(),
    })
    if (!refreshed) throw new Error('WALLET_NOT_CONNECTED')
    assertWalletTestnet(refreshed)
    if (
      !account.value ||
      account.value.address !== refreshed.address ||
      account.value.network.id !== refreshed.network.id
    ) {
      throw new Error('WALLET_CHANGED_AFTER_PREVIEW')
    }
  }

  async function prepare(
    transaction: Transaction,
    expectedProfile?: NetworkProfile,
  ): Promise<Transaction> {
    const manager = requireWalletManager()
    await refreshConnectedWallet()
    if (!account.value) throw new Error('WALLET_NOT_CONNECTED')
    assertWalletTestnet(account.value)
    assertTransactionSigner(transaction, account.value.address)
    const preparingSession = walletSessionKey(account.value, manager.wallet?.id)
    const preparingAddress = account.value.address

    const profile = await getActiveNetworkProfile()
    assertWalletContext(
      transaction,
      preparingAddress,
      preparingSession,
      account.value,
      manager.wallet?.id,
    )
    if (expectedProfile !== undefined && !sameProfile(expectedProfile, profile)) {
      throw new Error('NETWORK_PROFILE_CHANGED_BEFORE_PREVIEW')
    }
    const client = $xrplClientFactory(assertPublicRpcUrl(config.public.rpcUrl))
    try {
      await connectAndValidateNetwork(client, profile)
      assertWalletContext(
        transaction,
        preparingAddress,
        preparingSession,
        account.value,
        manager.wallet?.id,
      )
      const prepared = await autofillXcsTransaction(client, transaction)
      assertWalletContext(
        prepared.transaction,
        preparingAddress,
        preparingSession,
        account.value,
        manager.wallet?.id,
      )
      preparedProfiles.set(prepared.transaction, profile)
      preparedWalletSessions.set(prepared.transaction, preparingSession)
      return prepared.transaction
    } finally {
      await closeWalletRpc(client)
    }
  }

  async function signAndSubmit(
    transaction: Transaction,
    business?: OperationBusinessContext,
    assertCurrent?: () => void,
    afterSignatureValidated?: (signature: ValidatedSignature) => void | Promise<void>,
    afterLedgerValidated?: (result: ReliableSubmissionResult) => void | Promise<void>,
  ): Promise<WalletSubmissionResult> {
    const manager = requireWalletManager()
    await refreshConnectedWallet()
    if (!account.value) throw new Error('WALLET_NOT_CONNECTED')
    assertWalletTestnet(account.value)
    assertTransactionSigner(transaction, account.value.address)

    const preparedProfile = preparedProfiles.get(transaction)
    if (!preparedProfile) throw new Error('TRANSACTION_PREVIEW_REQUIRED')
    const preparedWalletSession = preparedWalletSessions.get(transaction)
    if (
      !preparedWalletSession ||
      preparedWalletSession !== walletSessionKey(account.value, manager.wallet?.id)
    ) {
      throw new Error('WALLET_CHANGED_AFTER_PREVIEW')
    }
    const rawSigning = requiresGemWalletRawSigning(manager.wallet?.id, transaction.TransactionType)
    const rawConsent = rawSigningConsents.get(transaction)
    rawSigningConsents.delete(transaction)
    if (rawSigning && rawConsent !== encode(transaction)) {
      throw new Error('GEMWALLET_RAW_SIGNING_CONSENT_REQUIRED')
    }
    const signingSession = preparedWalletSession
    const signingAddress = account.value.address
    const normalizedBusiness = business ? validateOperationBusinessContext(business) : undefined
    assertCurrent?.()
    const activeProfile = await getActiveNetworkProfile()
    assertWalletContext(
      transaction,
      signingAddress,
      signingSession,
      account.value,
      manager.wallet?.id,
    )
    assertCurrent?.()
    if (!sameProfile(preparedProfile, activeProfile)) {
      throw new Error('NETWORK_PROFILE_CHANGED_AFTER_PREVIEW')
    }

    walletBusy.value = true
    let client: ReturnType<typeof $xrplClientFactory> | undefined

    try {
      const operationId = crypto.randomUUID()
      const operationStore = operationJournal()
      client = $xrplClientFactory(assertPublicRpcUrl(config.public.rpcUrl))
      // Network identity is known before the wallet is asked to sign. The SDK
      // will refuse to sign or submit through an unvalidated client.
      await connectAndValidateNetwork(client, activeProfile)
      assertWalletContext(
        transaction,
        signingAddress,
        signingSession,
        account.value,
        manager.wallet?.id,
      )
      assertCurrent?.()
      const createdAt = new Date().toISOString()
      await operationStore.create({
        operationId,
        account: signingAddress,
        profileId: activeProfile.profileId,
        networkId: activeProfile.networkId,
        transactionType: String(transaction.TransactionType),
        createdAt,
        ...(normalizedBusiness ? { business: normalizedBusiness } : {}),
      })

      const walletSigner = createWalletSigner({ sign: (request) => manager.sign(request) })
      const signer = {
        sign: async (preparedTransaction: Readonly<SubmittableTransaction>) => {
          assertWalletContext(
            transaction,
            signingAddress,
            signingSession,
            account.value,
            manager.wallet?.id,
          )
          assertCurrent?.()
          const latestProfile = await getActiveNetworkProfile()
          if (!sameProfile(activeProfile, latestProfile)) {
            throw new Error('NETWORK_PROFILE_CHANGED_AFTER_PREVIEW')
          }
          await getNetworkReadiness(activeProfile.profileId)
          await refreshConnectedWallet()
          assertWalletContext(
            transaction,
            signingAddress,
            signingSession,
            account.value,
            manager.wallet?.id,
          )
          assertCurrent?.()
          try {
            if (rawSigning) {
              if (rawConsent !== encode(preparedTransaction)) {
                throw new Error('GEMWALLET_RAW_SIGNING_CONSENT_REQUIRED')
              }
              return await signGemWalletCredential(
                preparedTransaction as Transaction,
                account.value!,
              )
            }
            return await walletSigner.sign(
              transactionForWalletSigning(
                preparedTransaction as Transaction,
                manager.wallet?.id,
              ) as SubmittableTransaction,
            )
          } catch (error) {
            const normalized = await normalizeWalletTransactionError(
              error,
              manager.wallet,
              preparedTransaction.TransactionType,
            )
            if (normalized.message === OTSU_SIGNING_ACCOUNT_UNAVAILABLE) {
              // The provider exists but the session cannot access its selected
              // signing key. Do not leave XCS displaying a connected session
              // that cannot authorize the reviewed transaction.
              await manager.disconnect().catch(() => undefined)
            }
            throw normalized
          }
        },
      }

      const result = await signPreparedAndSubmit(
        client,
        transaction as SubmittableTransaction,
        signer,
        {
          journal: operationStore,
          operationId,
          allowSignerLastLedgerSequenceRefresh: manager.wallet?.id === 'xaman',
          onValidatedSignature: async (signature) => {
            const { txBlob, txHash, lastLedgerSequence } = signature
            await operationStore.persistSigned({
              operationId,
              txBlob,
              txHash,
              lastLedgerSequence,
              at: new Date().toISOString(),
            })
            await afterSignatureValidated?.(signature)
          },
          beforeSubmit: async () => {
            // The signature already proves which account authorized the exact
            // reviewed fields. Do not make the signed result depend on another
            // wallet session refresh; only re-run volatile application guards.
            assertCurrent?.()
            await assertBusinessGenerationCurrent(normalizedBusiness, activeProfile.profileId)
            assertCurrent?.()
            const latestProfile = await getActiveNetworkProfile()
            if (!sameProfile(activeProfile, latestProfile)) {
              throw new Error('NETWORK_PROFILE_CHANGED_AFTER_SIGNATURE')
            }
            await getNetworkReadiness(activeProfile.profileId)
            assertCurrent?.()
          },
        },
      )
      assertValidatedTesSuccess(result)
      await afterLedgerValidated?.(result)
      const businessResult = await confirmBusinessEvent(
        normalizedBusiness,
        activeProfile.profileId,
        result.txHash,
        operationStore,
        operationId,
      )
      preparedProfiles.delete(transaction)
      preparedWalletSessions.delete(transaction)
      return { ...result, ...businessResult }
    } finally {
      await finishWalletOperation(walletBusy, loadOperations, client)
    }
  }

  async function loadOperations(): Promise<StoredOperation[]> {
    if (!import.meta.client) return []
    operations.value = await operationJournal().list()
    return operations.value
  }

  async function retryOperation(operationId: string): Promise<WalletSubmissionResult> {
    walletBusy.value = true
    let client: ReturnType<typeof $xrplClientFactory> | undefined
    try {
      const operationStore = operationJournal()
      client = $xrplClientFactory(assertPublicRpcUrl(config.public.rpcUrl))
      const stored = (await operationStore.list()).find(
        (operation) => operation.operationId === operationId,
      )
      if (
        !stored ||
        !canRetryOperation(stored) ||
        !stored.txBlob ||
        !stored.txHash ||
        stored.lastLedgerSequence === undefined
      ) {
        throw new Error('OPERATION_NOT_RECOVERABLE')
      }
      validateStoredRecoveryMaterial({
        txBlob: stored.txBlob,
        txHash: stored.txHash,
        lastLedgerSequence: stored.lastLedgerSequence,
        account: stored.account,
        transactionType: stored.transactionType,
        networkId: stored.networkId,
      })

      const activeProfile = await getActiveNetworkProfile()
      if (
        stored.profileId !== activeProfile.profileId ||
        stored.networkId !== activeProfile.networkId
      ) {
        throw new Error('OPERATION_NETWORK_PROFILE_MISMATCH')
      }
      await connectAndValidateNetwork(client, activeProfile)
      const business = stored.business
        ? validateOperationBusinessContext(stored.business)
        : undefined
      const status = await getTransactionStatus(client, stored.txHash, stored.lastLedgerSequence)
      let result: ReliableSubmissionResult
      if (status.status === 'validated' || status.status === 'expired') {
        await operationStore.append({
          operationId,
          at: new Date().toISOString(),
          stage: status.status,
          txHash: status.txHash,
          lastLedgerSequence: status.lastLedgerSequence,
          ledgerIndex: status.ledgerIndex,
          engineResult: status.transactionResult,
        })
        result = { ...status, operationId }
      } else {
        if (
          ['CredentialAccept', 'CredentialDelete'].includes(stored.transactionType) &&
          !isGenerationBoundBusinessContext(business)
        ) {
          throw new Error('OPERATION_GENERATION_CONTEXT_REQUIRED')
        }
        await assertBusinessGenerationCurrent(business, activeProfile.profileId)
        await operationStore.assertBusinessLockOwned(operationId)
        // A signed blob can survive a browser or process restart for safe
        // recovery. Re-enter the same fail-closed readiness boundary used by
        // first submissions before creating any new XRPL side effect.
        await getNetworkReadiness(activeProfile.profileId)
        await operationStore.assertBusinessLockOwned(operationId)
        result = await submitSignedTransaction(client, stored.txBlob, {
          journal: operationStore,
          operationId,
        })
      }
      assertValidatedTesSuccess(result)
      const businessResult = await confirmBusinessEvent(
        business,
        activeProfile.profileId,
        result.txHash,
        operationStore,
        operationId,
      )
      return { ...result, ...businessResult }
    } finally {
      await finishWalletOperation(walletBusy, loadOperations, client)
    }
  }

  async function reconfirmOperation(operationId: string) {
    walletBusy.value = true
    try {
      const operationStore = operationJournal()
      const stored = (await operationStore.list()).find(
        (operation) => operation.operationId === operationId,
      )
      if (!stored) throw new Error('OPERATION_NOT_FOUND')

      const activeProfile = await getActiveNetworkProfile()
      if (
        stored.profileId !== activeProfile.profileId ||
        stored.networkId !== activeProfile.networkId
      ) {
        throw new Error('OPERATION_NETWORK_PROFILE_MISMATCH')
      }
      const business = stored.business
        ? validateOperationBusinessContext(stored.business)
        : undefined
      if (!isConfirmableBusinessContext(business)) {
        throw new Error('OPERATION_BUSINESS_CONTEXT_REQUIRED')
      }
      const txHash = stored.txHash
      if (!txHash) throw new Error('OPERATION_TRANSACTION_HASH_REQUIRED')

      return await reconfirmValidatedBusinessOperation({
        operation: stored,
        loadEvidence: () => loadIndexedBusinessEvidence(business, activeProfile.profileId, txHash),
        persist: (confirmation, at, evidence) =>
          operationStore.setBusinessConfirmation(operationId, confirmation, at, evidence),
      })
    } finally {
      await finishWalletOperation(walletBusy, loadOperations)
    }
  }

  async function abandonOperation(operationId: string): Promise<void> {
    walletBusy.value = true
    try {
      await operationJournal().abandon(operationId)
    } finally {
      await finishWalletOperation(walletBusy, loadOperations)
    }
  }

  return {
    account,
    walletId: computed(() => (account.value ? walletManager?.wallet?.id : undefined)),
    consentToRawSigning(transaction: Transaction) {
      rawSigningConsents.set(transaction, encode(transaction))
    },
    busy,
    error,
    operations: readonly(operations),
    prepare,
    signAndSubmit,
    loadOperations,
    retryOperation,
    reconfirmOperation,
    abandonOperation,
  }
}
