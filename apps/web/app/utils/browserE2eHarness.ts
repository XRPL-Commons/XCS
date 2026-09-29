import { sign as signMessageBytes } from 'ripple-keypairs'
import { decode, hashes, Wallet, type Client, type SubmittableTransaction } from 'xrpl'
import type {
  AccountInfo,
  ConnectOptions,
  NetworkInfo,
  SignedTransaction,
  Transaction,
  WalletAdapter,
} from 'xrpl-connect'

export const BROWSER_E2E_WALLET_ID = 'xcs-browser-e2e'
export const BROWSER_E2E_ACCOUNT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
export const BROWSER_E2E_SUBJECT_WALLET_ID = 'xcs-browser-e2e-subject'
export const BROWSER_E2E_SUBJECT_ACCOUNT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
export const BROWSER_E2E_GEMWALLET_ID = 'gemwallet'
export const BROWSER_E2E_OTSU_WALLET_ID = 'otsu'

interface BrowserE2eEffects {
  walletSignatures: number
  ledgerSubmissions: number
}

interface BrowserE2eControls {
  __xcsBrowserE2eAuthWallet?: boolean
  __xcsBrowserE2eWalletDiscoveryDelayMs?: number
  __xcsBrowserE2eCredentialObjects?: Record<string, unknown>[]
}

function browserE2eEffects(): BrowserE2eEffects {
  const runtime = globalThis as typeof globalThis & {
    __xcsBrowserE2eEffects?: BrowserE2eEffects
  }
  runtime.__xcsBrowserE2eEffects ??= { walletSignatures: 0, ledgerSubmissions: 0 }
  return runtime.__xcsBrowserE2eEffects
}

const NETWORK_ID = 1
const LEDGER_INDEX = 100_001
const LEDGER_HASH = 'cd'.repeat(32)
const LAST_LEDGER_SEQUENCE = LEDGER_INDEX + 20

const BROWSER_E2E_SIGNERS = new Map([
  [
    BROWSER_E2E_ACCOUNT,
    Wallet.fromEntropy(
      Uint8Array.from({ length: 16 }, (_, index) => index + 1),
      {
        masterAddress: BROWSER_E2E_ACCOUNT,
      },
    ),
  ],
  [
    BROWSER_E2E_SUBJECT_ACCOUNT,
    Wallet.fromEntropy(
      Uint8Array.from({ length: 16 }, (_, index) => 0xff - index),
      {
        masterAddress: BROWSER_E2E_SUBJECT_ACCOUNT,
      },
    ),
  ],
])

const BROWSER_E2E_WALLETS = [
  {
    id: BROWSER_E2E_WALLET_ID,
    name: 'XCS deterministic E2E wallet',
    address: BROWSER_E2E_ACCOUNT,
  },
  {
    id: BROWSER_E2E_SUBJECT_WALLET_ID,
    name: 'XCS deterministic E2E subject wallet',
    address: BROWSER_E2E_SUBJECT_ACCOUNT,
  },
  {
    id: BROWSER_E2E_GEMWALLET_ID,
    name: 'GemWallet',
    address: BROWSER_E2E_ACCOUNT,
  },
  {
    id: BROWSER_E2E_OTSU_WALLET_ID,
    name: 'Otsu Wallet',
    address: BROWSER_E2E_ACCOUNT,
  },
] as const

class BrowserE2eWalletAdapter implements WalletAdapter {
  public readonly capabilities = { sign: true, signAndSubmit: false, signMessage: false }
  private currentAccount: AccountInfo | null = null
  private staleOriginPermission: boolean

  public constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly address: string,
  ) {
    this.staleOriginPermission = id === BROWSER_E2E_OTSU_WALLET_ID
    if (
      id === BROWSER_E2E_GEMWALLET_ID &&
      (globalThis as typeof globalThis & BrowserE2eControls).__xcsBrowserE2eAuthWallet
    ) {
      const signer = Wallet.fromEntropy(Uint8Array.from({ length: 16 }, (_, i) => 31 - i))
      this.address = signer.classicAddress
      BROWSER_E2E_SIGNERS.set(this.address, signer)
      this.capabilities.signMessage = true
    }
  }

  public async isAvailable(): Promise<boolean> {
    const delay = (globalThis as typeof globalThis & BrowserE2eControls)
      .__xcsBrowserE2eWalletDiscoveryDelayMs
    if (typeof delay === 'number' && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    return true
  }

  public async connect(options?: ConnectOptions): Promise<AccountInfo> {
    if (options?.network !== undefined && options.network !== 'testnet') {
      throw new Error('BROWSER_E2E_TESTNET_REQUIRED')
    }
    if (this.staleOriginPermission) {
      throw new Error('BROWSER_E2E_OTSU_STALE_PERMISSION_NOT_REVOKED')
    }
    this.currentAccount = {
      address: this.address,
      network: {
        id: 'testnet',
        name: 'XRPL Testnet (deterministic E2E)',
        wss: 'ws://127.0.0.1:1',
      },
    }
    return this.cloneCurrentAccount()!
  }

  public async disconnect(): Promise<void> {
    this.currentAccount = null
    this.staleOriginPermission = false
  }

  public async getAccount(): Promise<AccountInfo | null> {
    return this.cloneCurrentAccount()
  }

  public async getNetwork(): Promise<NetworkInfo> {
    return (
      this.currentAccount?.network ?? {
        id: 'testnet',
        name: 'XRPL Testnet (deterministic E2E)',
        wss: 'ws://127.0.0.1:1',
      }
    )
  }

  public async fetchAccount(): Promise<AccountInfo | null> {
    return this.cloneCurrentAccount()
  }

  public async sign(transaction: Transaction): Promise<SignedTransaction> {
    if (this.currentAccount === null) throw new Error('BROWSER_E2E_WALLET_NOT_CONNECTED')
    browserE2eEffects().walletSignatures += 1
    const signer = BROWSER_E2E_SIGNERS.get(this.currentAccount.address)
    if (signer === undefined) throw new Error('BROWSER_E2E_SIGNER_UNKNOWN')
    const signed = signer.sign(transaction)
    if (this.currentAccount.address === BROWSER_E2E_SUBJECT_ACCOUNT) {
      const txJson = decode(signed.tx_blob)
      return {
        hash: signed.hash,
        tx_json: txJson as Transaction,
        signature: String(txJson.TxnSignature),
        signerAddress: this.currentAccount.address,
      }
    }
    return {
      tx_blob: signed.tx_blob,
      hash: signed.hash,
      signerAddress: this.currentAccount.address,
    }
  }

  public async signAndSubmit(): Promise<never> {
    throw new Error('BROWSER_E2E_SIGN_AND_SUBMIT_FORBIDDEN')
  }

  public async signMessage(message: string) {
    if (!this.capabilities.signMessage || !this.currentAccount)
      throw new Error('BROWSER_E2E_SIGN_MESSAGE_UNSUPPORTED')
    const signer = BROWSER_E2E_SIGNERS.get(this.currentAccount.address)!
    const bytes = Array.from(new TextEncoder().encode(message), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
    return {
      message,
      signature: signMessageBytes(bytes, signer.privateKey),
      publicKey: signer.publicKey,
      signerAddress: this.currentAccount.address,
    }
  }

  private cloneCurrentAccount(): AccountInfo | null {
    if (this.currentAccount === null) return null
    // Real fetch-capable adapters commonly return a fresh object even when the
    // account and network are unchanged. Keep E2E coverage faithful to that.
    return {
      ...this.currentAccount,
      network: { ...this.currentAccount.network },
    }
  }
}

interface BrowserE2eClientShape {
  readonly networkID: number
  readonly buildVersion: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  autofill(transaction: SubmittableTransaction): Promise<SubmittableTransaction>
  submit(txBlob: string): Promise<{ result: Record<string, unknown> }>
  request(request: Record<string, unknown>): Promise<{ result: Record<string, unknown> }>
}

class BrowserE2eLedgerClient implements BrowserE2eClientShape {
  public readonly networkID = NETWORK_ID
  public readonly buildVersion = 'browser-e2e-no-rippled'
  private connected = false
  private readonly submitted = new Set<string>()

  public async connect(): Promise<void> {
    this.connected = true
  }

  public async disconnect(): Promise<void> {
    this.connected = false
  }

  public isConnected(): boolean {
    return this.connected
  }

  public async autofill(transaction: SubmittableTransaction): Promise<SubmittableTransaction> {
    this.assertConnected()
    return {
      ...transaction,
      Sequence: transaction.Sequence ?? 1,
      Fee: transaction.Fee ?? '12',
      LastLedgerSequence: transaction.LastLedgerSequence ?? LAST_LEDGER_SEQUENCE,
    }
  }

  public async submit(txBlob: string): Promise<{ result: Record<string, unknown> }> {
    this.assertConnected()
    browserE2eEffects().ledgerSubmissions += 1
    this.submitted.add(hashes.hashSignedTx(txBlob).toUpperCase())
    return {
      result: {
        engine_result: 'tesSUCCESS',
        engine_result_code: 0,
        engine_result_message: 'Synthetic browser E2E acceptance.',
      },
    }
  }

  public async request(
    request: Record<string, unknown>,
  ): Promise<{ result: Record<string, unknown> }> {
    this.assertConnected()
    if (request.command === 'feature') {
      const amendment = String(request.feature)
      return { result: { [amendment]: { enabled: true, supported: true } } }
    }
    if (request.command === 'tx') {
      const hash = String(request.transaction).toUpperCase()
      if (!this.submitted.has(hash)) {
        throw Object.assign(new Error('txnNotFound'), { data: { error: 'txnNotFound' } })
      }
      return {
        result: {
          validated: true,
          ledger_index: LEDGER_INDEX,
          meta: { TransactionResult: 'tesSUCCESS' },
        },
      }
    }
    if (request.command === 'ledger_current') {
      return { result: { ledger_current_index: LEDGER_INDEX } }
    }
    if (request.command === 'account_objects') {
      const controls = globalThis as typeof globalThis & BrowserE2eControls
      return {
        result: {
          account: request.account,
          account_objects: controls.__xcsBrowserE2eCredentialObjects ?? [],
          ledger_hash: LEDGER_HASH,
          ledger_index: LEDGER_INDEX,
          validated: true,
        },
      }
    }
    throw new Error(`BROWSER_E2E_XRPL_COMMAND_UNSUPPORTED:${String(request.command)}`)
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('BROWSER_E2E_XRPL_NOT_CONNECTED')
  }
}

export function createBrowserE2eWalletAdapters(): WalletAdapter[] {
  return BROWSER_E2E_WALLETS.map(
    ({ id, name, address }) => new BrowserE2eWalletAdapter(id, name, address),
  )
}

export function createBrowserE2eLedgerClient(): Client {
  return new BrowserE2eLedgerClient() as unknown as Client
}
