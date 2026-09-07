import type { NetworkProfile } from '@xcs-protocol/core'
import {
  autofillXcsTransaction,
  connectAndValidateNetwork,
  getTransactionStatus,
  signPreparedAndSubmit,
  submitSignedTransaction,
  type ReliableSubmissionResult,
} from '@xcs-protocol/sdk'
import type { SubmittableTransaction } from 'xrpl'
import {
  supportsFetchAccount,
  type AccountInfo,
  type NetworkInfo,
  type Transaction,
} from 'xrpl-connect'
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
import {
  assertWalletSupportsXcsTransaction,
  normalizeWalletTransactionError,
  walletCredentialSupport,
  type WalletCredentialSupport,
} from '~/utils/walletCompatibility'
import {
  assertValidatedTesSuccess,
  createWalletSigner,
  validateStoredRecoveryMaterial,
} from '~/utils/walletSubmission'

const account = shallowRef<AccountInfo | null>(null)
const walletError = ref<string | null>(null)
const walletBusy = ref(false)
const listenersInstalled = ref(false)
const operations = shallowRef<StoredOperation[]>([])
const preparedProfiles = new WeakMap<object, NetworkProfile>()
const preparedWalletSessions = new WeakMap<object, number>()
let walletSession = 0
let journal: IndexedDbOperationJournal | undefined

export interface WalletSubmissionResult extends ReliableSubmissionResult {
  readonly businessConfirmation?: Exclude<BusinessConfirmation, 'pending'> | undefined
  readonly businessEvidence?: BusinessEvidence | undefined
}

export interface WalletChoice {
  readonly id: string
  readonly name: string
  readonly available: boolean
  readonly credentialSupport: WalletCredentialSupport
  readonly url?: string | undefined
}

function operationJournal(): IndexedDbOperationJournal {
  if (!import.meta.client) throw new Error('WALLET_BROWSER_REQUIRED')
  journal ??= new IndexedDbOperationJournal()
  return journal
}

function assertWalletTestnet(connectedAccount: AccountInfo): void {
  if (connectedAccount.network.id !== 'testnet') throw new Error('WALLET_TESTNET_REQUIRED')
}

function replaceAccount(nextAccount: AccountInfo | null): void {
  walletSession += 1
  account.value = nextAccount
}

function assertWalletContext(transaction: Transaction, address: string, session: number): void {
  if (walletSession !== session) throw new Error('WALLET_CHANGED_AFTER_PREVIEW')
  if (!account.value || account.value.address !== address) {
    throw new Error('WALLET_CHANGED_AFTER_PREVIEW')
  }
  assertWalletTestnet(account.value)
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
  const { $walletManager, $xrplClientFactory } = useNuxtApp()
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

  if (import.meta.client && !listenersInstalled.value) {
    listenersInstalled.value = true
    $walletManager.on('connect', (connectedAccount) => {
      const nextAccount = connectedAccount as AccountInfo
      try {
        assertWalletTestnet(nextAccount)
        replaceAccount(nextAccount)
        walletError.value = null
      } catch (error) {
        replaceAccount(null)
        walletError.value = error instanceof Error ? error.message : String(error)
      }
    })
    $walletManager.on('disconnect', () => {
      replaceAccount(null)
    })
    $walletManager.on('accountChanged', (changedAccount) => {
      const nextAccount = changedAccount as AccountInfo
      try {
        assertWalletTestnet(nextAccount)
        replaceAccount(nextAccount)
        walletError.value = null
      } catch (error) {
        replaceAccount(null)
        walletError.value = error instanceof Error ? error.message : String(error)
      }
    })
    $walletManager.on('networkChanged', (changedNetwork) => {
      if (!account.value) return
      const nextAccount = {
        ...account.value,
        network: changedNetwork as NetworkInfo,
      }
      try {
        assertWalletTestnet(nextAccount)
        replaceAccount(nextAccount)
        walletError.value = null
      } catch (error) {
        replaceAccount(null)
        walletError.value = error instanceof Error ? error.message : String(error)
      }
    })
    $walletManager.on('error', (error) => {
      walletError.value = error instanceof Error ? error.message : String(error)
    })
  }

  function safeWalletUrl(value: string | undefined): string | undefined {
    if (!value) return undefined
    try {
      const url = new URL(value)
      return url.protocol === 'https:' ? url.href : undefined
    } catch {
      return undefined
    }
  }

  async function refreshConnectedWallet(): Promise<void> {
    const adapter = $walletManager.wallet
    if (!adapter || !supportsFetchAccount(adapter)) return
    const refreshed = await $walletManager.fetchAccount()
    if (!refreshed) {
      replaceAccount(null)
      throw new Error('WALLET_NOT_CONNECTED')
    }
    assertWalletTestnet(refreshed)
    if (
      !account.value ||
      account.value.address !== refreshed.address ||
      account.value.network.id !== refreshed.network.id
    ) {
      replaceAccount(refreshed)
      return
    }
    account.value = refreshed
  }

  async function walletChoices(): Promise<WalletChoice[]> {
    let availableIds = new Set<string>()
    try {
      availableIds = new Set(
        (await $walletManager.getAvailableWallets()).map((wallet) => wallet.id),
      )
    } catch (error) {
      walletError.value = error instanceof Error ? error.message : String(error)
    }

    return $walletManager.wallets.map((wallet) => {
      const url = safeWalletUrl(wallet.url)
      return {
        id: wallet.id,
        name: wallet.name,
        available: availableIds.has(wallet.id),
        credentialSupport: walletCredentialSupport(wallet.id),
        ...(url ? { url } : {}),
      }
    })
  }

  async function connect(walletId: string) {
    walletBusy.value = true
    walletError.value = null
    try {
      const connectedAccount = await $walletManager.connect(walletId, { network: 'testnet' })
      assertWalletTestnet(connectedAccount)
      replaceAccount(connectedAccount)
    } catch (error) {
      replaceAccount(null)
      walletError.value = error instanceof Error ? error.message : String(error)
      if ($walletManager.connected) await $walletManager.disconnect().catch(() => undefined)
      throw error
    } finally {
      walletBusy.value = false
    }
  }

  async function disconnect() {
    await $walletManager.disconnect()
    replaceAccount(null)
  }

  async function prepare(
    transaction: Transaction,
    expectedProfile?: NetworkProfile,
  ): Promise<Transaction> {
    await refreshConnectedWallet()
    if (!account.value) throw new Error('WALLET_NOT_CONNECTED')
    assertWalletTestnet(account.value)
    assertTransactionSigner(transaction, account.value.address)
    assertWalletSupportsXcsTransaction($walletManager.wallet, transaction.TransactionType)
    const preparingSession = walletSession
    const preparingAddress = account.value.address

    const profile = await getActiveNetworkProfile()
    assertWalletContext(transaction, preparingAddress, preparingSession)
    if (expectedProfile !== undefined && !sameProfile(expectedProfile, profile)) {
      throw new Error('NETWORK_PROFILE_CHANGED_BEFORE_PREVIEW')
    }
    const client = $xrplClientFactory(assertPublicRpcUrl(config.public.rpcUrl))
    try {
      await connectAndValidateNetwork(client, profile)
      assertWalletContext(transaction, preparingAddress, preparingSession)
      const prepared = await autofillXcsTransaction(client, transaction)
      assertWalletContext(prepared.transaction, preparingAddress, preparingSession)
      preparedProfiles.set(prepared.transaction, profile)
      preparedWalletSessions.set(prepared.transaction, walletSession)
      return prepared.transaction
    } finally {
      if (client.isConnected()) await client.disconnect()
    }
  }

  async function signAndSubmit(
    transaction: Transaction,
    business?: OperationBusinessContext,
    assertCurrent?: () => void,
    afterSignatureValidated?: () => void | Promise<void>,
    afterLedgerValidated?: (result: ReliableSubmissionResult) => void | Promise<void>,
  ): Promise<WalletSubmissionResult> {
    await refreshConnectedWallet()
    if (!account.value) throw new Error('WALLET_NOT_CONNECTED')
    assertWalletTestnet(account.value)
    assertTransactionSigner(transaction, account.value.address)

    const preparedProfile = preparedProfiles.get(transaction)
    if (!preparedProfile) throw new Error('TRANSACTION_PREVIEW_REQUIRED')
    if (preparedWalletSessions.get(transaction) !== walletSession) {
      throw new Error('WALLET_CHANGED_AFTER_PREVIEW')
    }
    assertWalletSupportsXcsTransaction($walletManager.wallet, transaction.TransactionType)
    const signingSession = walletSession
    const signingAddress = account.value.address
    const normalizedBusiness = business ? validateOperationBusinessContext(business) : undefined
    assertCurrent?.()
    const activeProfile = await getActiveNetworkProfile()
    assertWalletContext(transaction, signingAddress, signingSession)
    assertCurrent?.()
    if (!sameProfile(preparedProfile, activeProfile)) {
      throw new Error('NETWORK_PROFILE_CHANGED_AFTER_PREVIEW')
    }

    walletBusy.value = true
    walletError.value = null
    const operationId = crypto.randomUUID()
    const operationStore = operationJournal()
    const client = $xrplClientFactory(assertPublicRpcUrl(config.public.rpcUrl))

    try {
      // Network identity is known before the wallet is asked to sign. The SDK
      // will refuse to sign or submit through an unvalidated client.
      await connectAndValidateNetwork(client, activeProfile)
      assertWalletContext(transaction, signingAddress, signingSession)
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

      const walletSigner = createWalletSigner($walletManager)
      const signer = {
        sign: async (preparedTransaction: Readonly<SubmittableTransaction>) => {
          assertWalletContext(transaction, signingAddress, signingSession)
          assertCurrent?.()
          const latestProfile = await getActiveNetworkProfile()
          if (!sameProfile(activeProfile, latestProfile)) {
            throw new Error('NETWORK_PROFILE_CHANGED_AFTER_PREVIEW')
          }
          await getNetworkReadiness(activeProfile.profileId)
          await refreshConnectedWallet()
          assertWalletContext(transaction, signingAddress, signingSession)
          assertCurrent?.()
          try {
            return await walletSigner.sign(preparedTransaction)
          } catch (error) {
            throw normalizeWalletTransactionError(
              error,
              $walletManager.wallet,
              preparedTransaction.TransactionType,
            )
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
          allowSignerLastLedgerSequenceRefresh: $walletManager.wallet?.id === 'xaman',
          onValidatedSignature: async ({ txBlob, txHash, lastLedgerSequence }) => {
            await operationStore.persistSigned({
              operationId,
              txBlob,
              txHash,
              lastLedgerSequence,
              at: new Date().toISOString(),
            })
          },
          beforeSubmit: async () => {
            // The signature already proves which account authorized the exact
            // reviewed fields. Do not make the signed result depend on another
            // wallet session refresh; only re-run volatile application guards.
            assertCurrent?.()
            await assertBusinessGenerationCurrent(normalizedBusiness, activeProfile.profileId)
            await afterSignatureValidated?.()
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
      await loadOperations().catch(() => undefined)
      if (client.isConnected()) await client.disconnect()
      walletBusy.value = false
    }
  }

  async function loadOperations(): Promise<StoredOperation[]> {
    if (!import.meta.client) return []
    operations.value = await operationJournal().list()
    return operations.value
  }

  async function retryOperation(operationId: string): Promise<WalletSubmissionResult> {
    walletBusy.value = true
    walletError.value = null
    const operationStore = operationJournal()
    const client = $xrplClientFactory(assertPublicRpcUrl(config.public.rpcUrl))
    try {
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
      await loadOperations().catch(() => undefined)
      if (client.isConnected()) await client.disconnect()
      walletBusy.value = false
    }
  }

  async function reconfirmOperation(operationId: string) {
    walletBusy.value = true
    walletError.value = null
    const operationStore = operationJournal()
    try {
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
      await loadOperations().catch(() => undefined)
      walletBusy.value = false
    }
  }

  async function abandonOperation(operationId: string): Promise<void> {
    walletBusy.value = true
    walletError.value = null
    try {
      await operationJournal().abandon(operationId)
    } finally {
      await loadOperations().catch(() => undefined)
      walletBusy.value = false
    }
  }

  return {
    account: readonly(account),
    busy: readonly(walletBusy),
    error: readonly(walletError),
    operations: readonly(operations),
    walletChoices,
    connect,
    disconnect,
    prepare,
    signAndSubmit,
    loadOperations,
    retryOperation,
    reconfirmOperation,
    abandonOperation,
  }
}
