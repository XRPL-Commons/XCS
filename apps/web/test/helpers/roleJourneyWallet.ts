import type { BrowserContext } from '@playwright/test'
import { sign } from 'ripple-keypairs'
import { decode, hashes, verifySignature, type Wallet } from 'xrpl'

/** Synthetic extension transport; the production GemWallet SDK and app signer stay real.
 * Ephemeral private keys remain in Node and never enter the browser or a log.
 */
export async function installJourneyWallet(context: BrowserContext, initial: Wallet) {
  let wallet = initial
  const signedMessages: Array<{ hex: boolean; address: string }> = []
  const errors: string[] = []
  await context.exposeBinding('__journeyGemRequest', async (_source, request) => {
    switch (request.type) {
      case 'REQUEST_IS_INSTALLED/V3':
        return { isInstalled: true }
      case 'REQUEST_GET_ADDRESS/V3':
        return { address: wallet.classicAddress }
      case 'REQUEST_GET_PUBLIC_KEY/V3':
        return { address: wallet.classicAddress, publicKey: wallet.publicKey }
      case 'REQUEST_GET_NETWORK/V3':
        return {
          chain: 'XRPL',
          network: 'Testnet',
          websocket: 'wss://s.altnet.rippletest.net:51233',
        }
      case 'REQUEST_SIGN_MESSAGE/V3': {
        const { message, isHex } = request.payload
        if (typeof message !== 'string' || message.length > 16384)
          throw new Error('Invalid synthetic signing input')
        signedMessages.push({ hex: Boolean(isHex), address: wallet.classicAddress })
        return {
          signedMessage: sign(
            isHex ? message : Buffer.from(message).toString('hex'),
            wallet.privateKey,
          ),
        }
      }
      default:
        errors.push(String(request.type))
        throw new Error('Unsupported synthetic GemWallet request')
    }
  })
  await context.addInitScript(() => {
    const bridge = window as unknown as {
      gemWallet: boolean
      __journeyGemRequest: (request: unknown) => Promise<unknown>
    }
    bridge.gemWallet = true
    window.addEventListener('message', async (event) => {
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        event.data?.source !== 'GEM_WALLET_MSG_REQUEST'
      )
        return
      const result = await bridge.__journeyGemRequest(event.data)
      // `messagedId` is the spelling in GemWallet API 3.8.0's actual content-script contract.
      window.postMessage(
        { source: 'GEM_WALLET_MSG_RESPONSE', messagedId: event.data.messageId, result },
        location.origin,
      )
    })
  })
  return {
    select: (value: Wallet) => {
      wallet = value
    },
    signedMessages,
    errors,
  }
}

/** Fully offline RPC transport. The real xrpl Client autofills, validates and submits.
 * Only after a valid signature is submitted does the caller project the synthetic ledger event.
 * This does not exercise a rippled consensus network or the indexer ingestion process.
 */
export async function installJourneyLedger(
  context: BrowserContext,
  options: {
    amendment: string
    ledgerHash: string
    project: (transaction: Record<string, unknown>, transactionHash: string) => Promise<void>
  },
) {
  const transactions = new Map<string, string>()
  const errors: string[] = []
  await context.routeWebSocket('**/*', (socket) => {
    socket.onMessage(async (raw) => {
      const request = JSON.parse(String(raw)) as Record<string, unknown>
      let result: unknown
      try {
        switch (request.command) {
          case 'server_info':
            result = {
              info: {
                network_id: 1,
                build_version: '2.5.0',
                load_factor: 1,
                validated_ledger: { seq: 10, hash: options.ledgerHash, base_fee_xrp: 0.00001 },
              },
            }
            break
          case 'feature':
            result = { [options.amendment]: { enabled: true, supported: true } }
            break
          case 'ledger_current':
            result = { ledger_current_index: 10 }
            break
          case 'ledger':
            result = {
              ledger_index: 10,
              ledger_hash: options.ledgerHash,
              validated: true,
              ledger: { ledger_index: 10 },
            }
            break
          case 'account_info':
            result = {
              account_data: {
                Account: request.account,
                Sequence: 1,
                Balance: '100000000',
                Flags: 0,
              },
            }
            break
          case 'account_objects':
            result = {
              account: request.account,
              account_objects: [],
              ledger_hash: options.ledgerHash,
              ledger_index: 10,
              validated: true,
            }
            break
          case 'submit': {
            const blob = String(request.tx_blob)
            if (!verifySignature(blob)) throw new Error('Invalid submitted signature')
            const transaction = decode(blob)
            const transactionHash = hashes.hashSignedTx(blob).toLowerCase()
            await options.project(transaction, transactionHash)
            transactions.set(transactionHash, blob)
            result = {
              engine_result: 'tesSUCCESS',
              tx_json: { ...transaction, hash: transactionHash },
              tx_blob: blob,
            }
            break
          }
          case 'tx': {
            const hash = String(request.transaction).toLowerCase()
            const blob = transactions.get(hash)
            if (!blob) throw new Error('Transaction was never submitted')
            result = {
              validated: true,
              ledger_index: decode(blob).TransactionType === 'CredentialCreate' ? 2 : 3,
              hash,
              meta: { TransactionResult: 'tesSUCCESS' },
              ...(request.binary ? { tx_blob: blob } : { tx_json: decode(blob) }),
            }
            break
          }
          default:
            throw new Error('Unsupported RPC method')
        }
        socket.send(JSON.stringify({ id: request.id, type: 'response', status: 'success', result }))
      } catch {
        errors.push(String(request.command))
        socket.send(
          JSON.stringify({
            id: request.id,
            type: 'response',
            status: 'error',
            error: 'testFixtureRejected',
          }),
        )
      }
    })
  })
  return { transactions, errors }
}
