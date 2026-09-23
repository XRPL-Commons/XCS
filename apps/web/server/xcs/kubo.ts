import { fetch, FormData } from 'undici'

import type { ContentPinStore } from './types.js'

export class KuboPinStore implements ContentPinStore {
  private readonly rpcUrl: URL

  constructor(rpcUrl: string) {
    this.rpcUrl = new URL(rpcUrl.endsWith('/') ? rpcUrl : `${rpcUrl}/`)
    if (!['http:', 'https:'].includes(this.rpcUrl.protocol)) {
      throw new Error('Kubo RPC URL must use HTTP or HTTPS')
    }
    if (this.rpcUrl.username !== '' || this.rpcUrl.password !== '') {
      throw new Error('Kubo RPC URL must not contain credentials')
    }
  }

  async putRaw(content: Uint8Array, expectedCid: string): Promise<void> {
    const endpoint = new URL('api/v0/block/put', this.rpcUrl)
    endpoint.searchParams.set('format', 'raw')
    endpoint.searchParams.set('mhtype', 'sha2-256')
    endpoint.searchParams.set('pin', 'true')
    const form = new FormData()
    const payloadBuffer = content.slice().buffer as ArrayBuffer
    form.append(
      'file',
      new Blob([payloadBuffer], { type: 'application/octet-stream' }),
      'payload.json',
    )
    const response = await fetch(endpoint, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Kubo block/put returned HTTP ${response.status}`)
    const body: unknown = await response.json()
    if (
      typeof body !== 'object' ||
      body === null ||
      !('Key' in body) ||
      (body as { Key?: unknown }).Key !== expectedCid
    ) {
      throw new Error('Kubo returned an unexpected CID')
    }
  }

  async unpin(cid: string): Promise<void> {
    const endpoint = new URL('api/v0/pin/rm', this.rpcUrl)
    endpoint.searchParams.set('arg', cid)
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      const message = (await response.text()).slice(0, 512)
      if (!/not (?:recursively )?pinned/i.test(message)) {
        throw new Error(`Kubo pin/rm returned HTTP ${response.status}`)
      }
      return
    }
    await response.body?.cancel()
  }
}
