import { createHash, createPublicKey, verify } from 'node:crypto'

import { deriveAddress, verify as verifyRippleSignature } from 'ripple-keypairs'

export interface WalletProof {
  signature: string
  publicKey: string
  scheme: 'ripple' | 'otsu'
}

/** Proves a master-key address only; regular keys and multisign accounts are unsupported. */
export function verifyWalletProof(message: string, address: string, proof: WalletProof): boolean {
  try {
    if (
      typeof message !== 'string' ||
      message.length === 0 ||
      Buffer.byteLength(message) > 8192 ||
      !proof ||
      typeof proof.publicKey !== 'string' ||
      typeof proof.signature !== 'string' ||
      !/^(?:02|03|ED)[0-9a-f]{64}$/iu.test(proof.publicKey) ||
      !/^(?:[0-9a-f]{2}){64,72}$/iu.test(proof.signature)
    ) {
      return false
    }
    const publicKey = proof.publicKey.toUpperCase()
    if (deriveAddress(publicKey) !== address) return false
    if (proof.scheme === 'ripple') {
      return verifyRippleSignature(
        Buffer.from(message, 'utf8').toString('hex'),
        proof.signature,
        publicKey,
      )
    }
    if (
      proof.scheme !== 'otsu' ||
      !/^(?:02|03)/u.test(publicKey) ||
      proof.signature.length !== 128
    ) {
      return false
    }
    const key = createPublicKey({
      key: Buffer.concat([
        // SubjectPublicKeyInfo: ecPublicKey + secp256k1 + compressed 33-byte point.
        Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex'),
        Buffer.from(publicKey, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    })
    // Otsu hashes UTF-8 once, then noble/curves v2 signs with its default prehash=true.
    const digest = createHash('sha256').update(message, 'utf8').digest()
    return verify(
      'sha256',
      digest,
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(proof.signature, 'hex'),
    )
  } catch {
    return false
  }
}
