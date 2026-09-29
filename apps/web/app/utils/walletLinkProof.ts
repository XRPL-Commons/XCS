import { deriveAddress } from 'xrpl'
import type { AccountInfo, WalletEvent, WalletManager } from 'xrpl-connect'

export type WalletProofManager = Pick<
  WalletManager,
  'connected' | 'account' | 'wallet' | 'supports' | 'fetchAccount' | 'signMessage' | 'on' | 'off'
>

export interface WalletLinkProof {
  signature: string
  publicKey: string
  scheme: 'ripple' | 'otsu'
}

/**
 * Link only a master-key address. Regular keys and multisign accounts need a separate
 * authorization protocol. Xaman/Crossmark/WalletConnect/Ledger lack message proofs;
 * Xyra's signature encoding is unverified, so connection alone never enables linking.
 */
export async function signWalletLinkChallenge(
  manager: WalletProofManager,
  expectedAccount: { address: string; networkId?: string },
  message: string,
): Promise<WalletLinkProof> {
  const adapter = manager.wallet
  if (
    !adapter ||
    !['gemwallet', 'metamask-snap', 'otsu'].includes(adapter.id) ||
    !manager.supports('signMessage')
  ) {
    throw new Error('WALLET_LINK_UNSUPPORTED')
  }
  if (!message || new TextEncoder().encode(message).length > 8192) {
    throw new Error('WALLET_LINK_CHALLENGE_INVALID')
  }
  const networkId = expectedAccount.networkId ?? manager.account?.network.id
  let changed = false
  const assertAccount = (account: AccountInfo | null) => {
    if (
      changed ||
      !manager.connected ||
      manager.wallet !== adapter ||
      !account ||
      account.address !== expectedAccount.address ||
      account.network.id !== networkId
    ) {
      throw new Error('WALLET_LINK_SESSION_CHANGED')
    }
  }
  assertAccount(manager.account)
  const invalidate = () => {
    changed = true
  }
  const events: WalletEvent[] = [
    'connect',
    'disconnecting',
    'disconnect',
    'accountChanged',
    'networkChanged',
  ]
  for (const event of events) manager.on(event, invalidate)
  try {
    assertAccount(await manager.fetchAccount())
    assertAccount(manager.account)
    // The Snap passes its argument straight to ripple-keypairs, which expects hex.
    const signingMessage =
      adapter.id === 'metamask-snap'
        ? Array.from(new TextEncoder().encode(message), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('')
        : message
    const signed = await manager.signMessage(signingMessage)
    assertAccount(manager.account)
    assertAccount(await manager.fetchAccount())
    assertAccount(manager.account)
    if (
      signed.message !== signingMessage ||
      signed.signerAddress !== expectedAccount.address ||
      !/^(?:02|03|ED)[0-9a-f]{64}$/iu.test(signed.publicKey) ||
      !/^(?:[0-9a-f]{2}){64,72}$/iu.test(signed.signature) ||
      deriveAddress(signed.publicKey.toUpperCase()) !== expectedAccount.address
    ) {
      throw new Error('WALLET_LINK_PROOF_INVALID')
    }
    if (
      adapter.id === 'otsu' &&
      (!/^(?:02|03)/u.test(signed.publicKey) || signed.signature.length !== 128)
    ) {
      throw new Error('WALLET_LINK_PROOF_INVALID')
    }
    return {
      signature: signed.signature,
      publicKey: signed.publicKey,
      scheme: adapter.id === 'otsu' ? 'otsu' : 'ripple',
    }
  } finally {
    for (const event of events) manager.off(event, invalidate)
  }
}
