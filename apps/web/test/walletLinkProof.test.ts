import { createHash, ECDH, generateKeyPairSync, sign as nodeSign } from 'node:crypto'

import { deriveAddress, deriveKeypair, generateSeed, sign } from 'ripple-keypairs'
import { describe, expect, it, vi } from 'vitest'
import type { AccountInfo, WalletAdapter, WalletEvent } from 'xrpl-connect'

import { signWalletLinkChallenge, type WalletProofManager } from '../app/utils/walletLinkProof'
import { verifyWalletProof, type WalletProof } from '../server/xcs/auth/wallet-proof'

const message = 'XCS wallet link\norigin:https://xcs.example\nnetwork:testnet\nnonce:one-use'
const keypair = deriveKeypair(generateSeed({ algorithm: 'ecdsa-secp256k1' }))
const address = deriveAddress(keypair.publicKey)

function wallet(id = 'gemwallet') {
  const account: AccountInfo = {
    address,
    publicKey: keypair.publicKey,
    network: { id: 'testnet', name: 'Testnet', wss: 'wss://test.example' },
  }
  const listeners = new Map<WalletEvent, Set<() => void>>()
  const manager = {
    connected: true,
    account,
    wallet: { id } as WalletAdapter,
    supports: vi.fn(() => true),
    fetchAccount: vi.fn(async () => manager.account),
    signMessage: vi.fn(async (input: string) => ({
      message: input,
      signature: sign(
        id === 'metamask-snap' ? input : Buffer.from(input).toString('hex'),
        keypair.privateKey,
      ),
      publicKey: keypair.publicKey,
      signerAddress: address,
    })),
    on: vi.fn((event: WalletEvent, callback: () => void) => {
      const callbacks = listeners.get(event) ?? new Set()
      callbacks.add(callback)
      listeners.set(event, callbacks)
    }),
    off: vi.fn((event: WalletEvent, callback: () => void) => {
      listeners.get(event)?.delete(callback)
    }),
  }
  return {
    manager,
    emit: (event: WalletEvent) => listeners.get(event)?.forEach((callback) => callback()),
    api: manager as unknown as WalletProofManager,
  }
}

describe('wallet proof cryptography', () => {
  it.each(['ecdsa-secp256k1', 'ed25519'] as const)(
    'verifies genuine ripple %s signatures',
    (algorithm) => {
      const keys = deriveKeypair(generateSeed({ algorithm }))
      const proof: WalletProof = {
        publicKey: keys.publicKey,
        signature: sign(Buffer.from(message).toString('hex'), keys.privateKey),
        scheme: 'ripple',
      }
      expect(verifyWalletProof(message, deriveAddress(keys.publicKey), proof)).toBe(true)
      expect(
        verifyWalletProof(`${message}-another-nonce`, deriveAddress(keys.publicKey), proof),
      ).toBe(false)
      expect(verifyWalletProof(message, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', proof)).toBe(false)
      expect(
        verifyWalletProof(message, deriveAddress(keys.publicKey), { ...proof, scheme: 'otsu' }),
      ).toBe(false)
    },
  )

  it('verifies the exact compact double-SHA256 signature produced by Otsu noble v2', () => {
    // Generated with Otsu's installed noble/curves v2 sign(sha256(utf8), key).
    const publicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    const proof: WalletProof = {
      publicKey,
      signature:
        '00ce986cd9e70d524391229c2e9efd07f5000ecc948ee7f303b2eff807dd3d5a3133428382215669e4d17a7635f41fafd77de3de12aed8b0af09d8073bd13c12',
      scheme: 'otsu',
    }
    expect(
      verifyWalletProof(
        'XCS wallet link compatibility fixture v1',
        deriveAddress(publicKey),
        proof,
      ),
    ).toBe(true)
    expect(verifyWalletProof(message, deriveAddress(publicKey), proof)).toBe(false)
  })

  it('accepts compact Otsu signatures, rejects single-hash and wrong scheme', () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
    const der = keys.publicKey.export({ type: 'spki', format: 'der' })
    const publicKey = Buffer.from(
      ECDH.convertKey(der.subarray(-65), 'secp256k1', undefined, undefined, 'compressed'),
    ).toString('hex')
    const proof: WalletProof = {
      publicKey,
      signature: nodeSign('sha256', createHash('sha256').update(message).digest(), {
        key: keys.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('hex'),
      scheme: 'otsu',
    }
    expect(verifyWalletProof(message, deriveAddress(publicKey), proof)).toBe(true)
    expect(
      verifyWalletProof(message, deriveAddress(publicKey), { ...proof, scheme: 'ripple' }),
    ).toBe(false)
    const singleHash = nodeSign('sha256', Buffer.from(message), {
      key: keys.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('hex')
    expect(
      verifyWalletProof(message, deriveAddress(publicKey), { ...proof, signature: singleHash }),
    ).toBe(false)
  })

  it.each([
    { signature: 'zz'.repeat(64) },
    { signature: 'a'.repeat(127) },
    { publicKey: '02' + '00'.repeat(32) },
    { scheme: 'unknown' },
    { publicKey: 'ED' },
  ])('rejects malformed proof %j without throwing', (change) => {
    const proof = {
      publicKey: keypair.publicKey,
      signature: sign(Buffer.from(message).toString('hex'), keypair.privateKey),
      scheme: 'ripple',
      ...change,
    } as WalletProof
    expect(verifyWalletProof(message, address, proof)).toBe(false)
  })
})

describe('wallet link challenge signing', () => {
  it('preserves the Otsu text challenge and selects its exact signature scheme', async () => {
    const fixture = wallet('otsu')
    const publicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    const otsuAddress = deriveAddress(publicKey)
    const challenge = 'XCS wallet link compatibility fixture v1'
    fixture.manager.account = { ...fixture.manager.account, address: otsuAddress, publicKey }
    fixture.manager.signMessage.mockResolvedValueOnce({
      message: challenge,
      publicKey,
      signature:
        '00ce986cd9e70d524391229c2e9efd07f5000ecc948ee7f303b2eff807dd3d5a3133428382215669e4d17a7635f41fafd77de3de12aed8b0af09d8073bd13c12',
      signerAddress: otsuAddress,
    })
    const proof = await signWalletLinkChallenge(fixture.api, { address: otsuAddress }, challenge)
    expect(proof.scheme).toBe('otsu')
    expect(fixture.manager.signMessage).toHaveBeenCalledWith(challenge)
    expect(verifyWalletProof(challenge, otsuAddress, proof)).toBe(true)
  })

  it.each(['gemwallet', 'metamask-snap'])('signs verifiable challenges through %s', async (id) => {
    const fixture = wallet(id)
    const proof = await signWalletLinkChallenge(
      fixture.api,
      { address, networkId: 'testnet' },
      message,
    )
    expect(verifyWalletProof(message, address, proof)).toBe(true)
    expect(fixture.manager.signMessage).toHaveBeenCalledWith(
      id === 'metamask-snap' ? Buffer.from(message).toString('hex') : message,
    )
    expect(fixture.manager.fetchAccount).toHaveBeenCalledTimes(2)
    expect(fixture.manager.off).toHaveBeenCalledTimes(5)
  })

  it.each(['xaman', 'crossmark', 'walletconnect', 'ledger', 'xyra', 'custom'])(
    'rejects unverified %s formats even when a capability is declared',
    async (id) => {
      const fixture = wallet(id)
      await expect(signWalletLinkChallenge(fixture.api, { address }, message)).rejects.toThrow(
        'WALLET_LINK_UNSUPPORTED',
      )
      expect(fixture.manager.signMessage).not.toHaveBeenCalled()
    },
  )

  it('requires the capability and expected network before signing', async () => {
    const fixture = wallet()
    fixture.manager.supports.mockReturnValue(false)
    await expect(signWalletLinkChallenge(fixture.api, { address }, message)).rejects.toThrow(
      'WALLET_LINK_UNSUPPORTED',
    )
    fixture.manager.supports.mockReturnValue(true)
    await expect(
      signWalletLinkChallenge(fixture.api, { address, networkId: 'mainnet' }, message),
    ).rejects.toThrow('WALLET_LINK_SESSION_CHANGED')
    expect(fixture.manager.signMessage).not.toHaveBeenCalled()
  })

  it.each(['account', 'network', 'reconnect', 'adapter'])(
    'rejects %s changes while the wallet signs',
    async (change) => {
      const fixture = wallet()
      fixture.manager.signMessage.mockImplementationOnce(async (input) => {
        if (change === 'account')
          fixture.manager.account = { ...fixture.manager.account, address: 'different' }
        if (change === 'network')
          fixture.manager.account = {
            ...fixture.manager.account,
            network: { ...fixture.manager.account.network, id: 'mainnet' },
          }
        if (change === 'reconnect') fixture.emit('connect')
        if (change === 'adapter') fixture.manager.wallet = { id: 'gemwallet' } as WalletAdapter
        return {
          message: input,
          publicKey: keypair.publicKey,
          signature: 'a'.repeat(128),
          signerAddress: address,
        }
      })
      await expect(signWalletLinkChallenge(fixture.api, { address }, message)).rejects.toThrow(
        'WALLET_LINK_SESSION_CHANGED',
      )
      expect(fixture.manager.off).toHaveBeenCalledTimes(5)
    },
  )

  it('rejects a changed returned message and a key that does not own the expected address', async () => {
    const fixture = wallet()
    const returned = {
      message: 'different',
      publicKey: keypair.publicKey,
      signature: 'a'.repeat(128),
      signerAddress: address,
    }
    fixture.manager.signMessage.mockResolvedValueOnce(returned)
    await expect(signWalletLinkChallenge(fixture.api, { address }, message)).rejects.toThrow(
      'WALLET_LINK_PROOF_INVALID',
    )
    fixture.manager.signMessage.mockResolvedValueOnce({
      ...returned,
      message,
      publicKey: deriveKeypair(generateSeed()).publicKey,
    })
    await expect(signWalletLinkChallenge(fixture.api, { address }, message)).rejects.toThrow(
      'WALLET_LINK_PROOF_INVALID',
    )
  })
})
