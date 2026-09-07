import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'

import { parsePayloadUri } from '@xcs-protocol/core'
import { Agent, fetch } from 'undici'

import { assertSafeHttpsPayloadUrl, isPublicAddress } from './internal/network-safety.js'
import type { PayloadResolver } from './types.js'

const MAX_PAYLOAD_BYTES = 1024 * 1024
const MAX_REDIRECTS = 2
const FETCH_TIMEOUT_MS = 5_000

export class PayloadUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PayloadUnavailableError'
  }
}

export class PayloadInvalidError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PayloadInvalidError'
  }
}

interface ResolvedAddress {
  address: string
  family: number
}

export interface PayloadResolverDependencies {
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>
  fetch?: typeof fetch
  createAgent?: (connect: { lookup: LookupFunction }) => Agent
}

export class DisabledPayloadResolver implements PayloadResolver {
  async resolve(_uri: string): Promise<Uint8Array> {
    throw new PayloadUnavailableError('Server-side payload fetching is disabled')
  }
}

async function systemLookup(hostname: string): Promise<readonly ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true })
}

function systemCreateAgent(connect: { lookup: LookupFunction }): Agent {
  return new Agent({ connect })
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new PayloadUnavailableError('Payload fetch timed out')
  return remaining
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new PayloadUnavailableError('Payload fetch timed out')),
          remainingTimeout(deadline),
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function resolvePublicAddress(
  hostname: string,
  lookupAll: NonNullable<PayloadResolverDependencies['lookup']>,
  deadline: number,
) {
  const literal =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const literalFamily = isIP(literal)
  if (literalFamily !== 0) {
    if (!isPublicAddress(literal)) {
      throw new PayloadUnavailableError('Payload hostname resolves to a non-public address')
    }
    return { address: literal, family: literalFamily }
  }

  let addresses: readonly ResolvedAddress[]
  try {
    addresses = await beforeDeadline(lookupAll(hostname), deadline)
  } catch (error) {
    if (error instanceof PayloadUnavailableError) throw error
    throw new PayloadUnavailableError('Payload hostname lookup failed', { cause: error })
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new PayloadUnavailableError('Payload hostname resolves to a non-public address')
  }
  return addresses[0]!
}

async function readLimited(response: Awaited<ReturnType<typeof fetch>>): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_PAYLOAD_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // The observed byte count already proves invalidity; cancellation is only cleanup.
      }
      throw new PayloadInvalidError('Payload exceeds the 1 MiB limit')
    }
    chunks.push(value)
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function fetchPinned(
  initialUrl: URL,
  dependencies: Required<PayloadResolverDependencies>,
): Promise<Uint8Array> {
  let currentUrl = initialUrl
  const deadline = Date.now() + FETCH_TIMEOUT_MS

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    try {
      assertSafeHttpsPayloadUrl(currentUrl)
    } catch (error) {
      throw new PayloadUnavailableError('Payload URL must use HTTPS without credentials', {
        cause: error,
      })
    }
    const resolved = await resolvePublicAddress(currentUrl.hostname, dependencies.lookup, deadline)
    const agent = dependencies.createAgent({
      lookup: (_hostname, _options, callback) => {
        callback(null, resolved.address, resolved.family)
      },
    })

    try {
      const response = await dependencies.fetch(currentUrl, {
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(remainingTimeout(deadline)),
        headers: { accept: 'application/json' },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (location === null || redirect === MAX_REDIRECTS) {
          throw new PayloadUnavailableError('Payload redirect limit exceeded')
        }
        currentUrl = new URL(location, currentUrl)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new PayloadUnavailableError(`Payload server returned HTTP ${response.status}`)
      }
      return await readLimited(response)
    } catch (error) {
      if (error instanceof PayloadUnavailableError || error instanceof PayloadInvalidError) {
        throw error
      }
      throw new PayloadUnavailableError('Payload fetch failed', { cause: error })
    } finally {
      try {
        await agent.close()
      } catch {
        // Cleanup failure cannot change already observed retrieval evidence.
      }
    }
  }

  throw new PayloadUnavailableError('Payload redirect limit exceeded')
}

async function fetchConfiguredGateway(url: URL, fetchImpl: typeof fetch): Promise<Uint8Array> {
  try {
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/octet-stream, application/json' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new PayloadUnavailableError(`IPFS gateway returned HTTP ${response.status}`)
    }
    return await readLimited(response)
  } catch (error) {
    if (error instanceof PayloadUnavailableError || error instanceof PayloadInvalidError)
      throw error
    throw new PayloadUnavailableError('IPFS gateway fetch failed', { cause: error })
  }
}

export class SafePayloadResolver implements PayloadResolver {
  private readonly ipfsGateway: URL
  private readonly dependencies: Required<PayloadResolverDependencies>

  constructor(ipfsGateway: string, dependencies: PayloadResolverDependencies = {}) {
    this.ipfsGateway = new URL(ipfsGateway.endsWith('/') ? ipfsGateway : `${ipfsGateway}/`)
    if (
      !['http:', 'https:'].includes(this.ipfsGateway.protocol) ||
      this.ipfsGateway.username !== '' ||
      this.ipfsGateway.password !== ''
    ) {
      throw new Error('IPFS gateway must be an HTTP(S) URL without credentials')
    }
    this.dependencies = {
      lookup: dependencies.lookup ?? systemLookup,
      fetch: dependencies.fetch ?? fetch,
      createAgent: dependencies.createAgent ?? systemCreateAgent,
    }
  }

  async resolve(uri: string): Promise<Uint8Array> {
    const parsed = parsePayloadUri(uri)
    if (parsed.kind === 'https') {
      return fetchPinned(new URL(parsed.fetchUrl), this.dependencies)
    }
    const url = new URL(`ipfs/${parsed.cid}`, this.ipfsGateway)
    return fetchConfiguredGateway(url, this.dependencies.fetch)
  }
}
