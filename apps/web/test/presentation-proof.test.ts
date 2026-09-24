import { ECDSA, Wallet } from 'xrpl'
import { sign } from 'ripple-keypairs'
import { describe, expect, it } from 'vitest'
import type { PresentationProofRequest } from '#db/schema/app'
import { verifyWalletProof } from '../server/xcs/auth/wallet-proof'
import { presentationProofMessage } from '../server/xcs/presentations/proof'

const wallet = Wallet.generate()
const request: PresentationProofRequest = {
  version: 1,
  origin: 'https://xcs.test',
  challengeId: '00000000-0000-4000-8000-000000000001',
  presentationId: '00000000-0000-4000-8000-000000000002',
  nonce: 'a'.repeat(43),
  issuedAt: '2026-09-24T12:00:00.000Z',
  expiresAt: '2026-09-24T12:05:00.000Z',
  profileId: 'testnet',
  networkId: 1,
  generationId: 'a'.repeat(64),
  issuerAddress: Wallet.generate().address,
  subjectAddress: wallet.address,
  schemaUid: 'b'.repeat(64),
  payloadDigest: 'c'.repeat(64),
  visibility: 'private',
  publicFields: ['/course'],
  scope: 'public',
  verifierOrganizationId: null,
}

describe('presentation signature purpose and disclosure', () => {
  it('uses a deterministic unambiguous message and verifies both supported XRPL master-key curves', () => {
    for (const algorithm of [ECDSA.ed25519, ECDSA.secp256k1]) {
      const holder = Wallet.generate(algorithm)
      const message = presentationProofMessage({ ...request, subjectAddress: holder.address })
      expect(message).toBe(presentationProofMessage({ ...request, subjectAddress: holder.address }))
      expect(message).toContain('not a transaction, payment, wallet link')
      expect(
        verifyWalletProof(message, holder.address, {
          scheme: 'ripple',
          publicKey: holder.publicKey,
          signature: sign(Buffer.from(message).toString('hex'), holder.privateKey),
        }),
      ).toBe(true)
    }
  })
  it('cryptographically binds every selected audience, disclosure and credential field', () => {
    const message = presentationProofMessage(request)
    const proof = {
      scheme: 'ripple' as const,
      publicKey: wallet.publicKey,
      signature: sign(Buffer.from(message).toString('hex'), wallet.privateKey),
    }
    for (const replacement of [
      { origin: 'https://other.test' },
      { profileId: 'other-profile' },
      { networkId: 2 },
      { generationId: 'd'.repeat(64) },
      { schemaUid: 'd'.repeat(64) },
      { payloadDigest: 'd'.repeat(64) },
      { subjectAddress: Wallet.generate().address },
      { issuerAddress: Wallet.generate().address },
      { publicFields: ['/secret'] },
      { visibility: 'public' as const },
      { scope: 'full' as const },
      { verifierOrganizationId: '00000000-0000-4000-8000-000000000003' },
      { presentationId: '00000000-0000-4000-8000-000000000003' },
      { challengeId: '00000000-0000-4000-8000-000000000003' },
      { nonce: 'b'.repeat(43) },
      { issuedAt: '2026-09-24T12:01:00.000Z' },
      { expiresAt: '2026-09-24T12:06:00.000Z' },
    ])
      expect(
        verifyWalletProof(
          presentationProofMessage({ ...request, ...replacement }),
          wallet.address,
          proof,
        ),
      ).toBe(false)
    expect(
      verifyWalletProof(
        message.replace('XCS presentation authorization v1', 'XCS wallet ownership proof'),
        wallet.address,
        proof,
      ),
    ).toBe(false)
  })
  it('escapes untrusted profile and selector strings so they cannot introduce wallet-prompt fields', () => {
    const message = presentationProofMessage({
      ...request,
      profileId: 'profile\nscope: "full"',
      publicFields: ['/course\nverifierOrganizationId: "other"'],
    })
    expect(message.split('\n').filter((line) => line.startsWith('scope:'))).toEqual([
      'scope: "public"',
    ])
    expect(
      message.split('\n').filter((line) => line.startsWith('verifierOrganizationId:')),
    ).toEqual(['verifierOrganizationId: null'])
  })
})
