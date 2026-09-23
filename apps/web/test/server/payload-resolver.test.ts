import type { LookupFunction } from 'node:net'

import { Agent, Response } from 'undici'
import { describe, expect, it, vi } from 'vitest'

import {
  PayloadInvalidError,
  PayloadUnavailableError,
  SafePayloadResolver,
} from '../../server/xcs/payload-resolver.js'

const HTTPS_URI =
  'https://issuer.example/credential.json#xcs-sha256=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const PUBLIC_LOOKUP = async () => [{ address: '8.8.8.8', family: 4 }]
const ONE_MIB = 1024 * 1024

describe('safe payload resolver', () => {
  it('classifies DNS failure and non-public DNS answers as unavailable without fetching', async () => {
    const fetch = vi.fn(async () => new Response('unexpected'))
    const failed = new SafePayloadResolver('https://gateway.example/', {
      lookup: async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
      },
      fetch,
    })
    const blocked = new SafePayloadResolver('https://gateway.example/', {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      fetch,
    })

    await expect(failed.resolve(HTTPS_URI)).rejects.toBeInstanceOf(PayloadUnavailableError)
    await expect(blocked.resolve(HTTPS_URI)).rejects.toBeInstanceOf(PayloadUnavailableError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('validates IP literals directly and does not pass bracketed IPv6 to DNS', async () => {
    const lookup = vi.fn(PUBLIC_LOOKUP)
    const fetch = vi.fn(async () => new Response('hello'))
    const resolver = new SafePayloadResolver('https://gateway.example/', { lookup, fetch })
    const publicIpv6 = HTTPS_URI.replace('issuer.example', '[2606:4700:4700::1111]')
    const privateIpv4 = HTTPS_URI.replace('issuer.example', '127.0.0.1')

    await expect(resolver.resolve(publicIpv6)).resolves.toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    )
    await expect(resolver.resolve(privateIpv4)).rejects.toBeInstanceOf(PayloadUnavailableError)
    expect(lookup).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([404, 429, 503])('classifies HTTP %s as unavailable', async (status) => {
    const resolver = new SafePayloadResolver('https://gateway.example/', {
      lookup: PUBLIC_LOOKUP,
      fetch: async () => new Response('unavailable', { status }),
    })

    await expect(resolver.resolve(HTTPS_URI)).rejects.toBeInstanceOf(PayloadUnavailableError)
  })

  it('rejects an unsafe redirect before issuing its next request', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/payload' } }),
    )
    const resolver = new SafePayloadResolver('https://gateway.example/', {
      lookup: PUBLIC_LOOKUP,
      fetch,
    })

    await expect(resolver.resolve(HTTPS_URI)).rejects.toBeInstanceOf(PayloadUnavailableError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('pins every HTTPS hop to the public address resolved for that hostname', async () => {
    const lookups = vi.fn(async (hostname: string) => [
      {
        address: hostname === 'issuer.example' ? '8.8.8.8' : '1.1.1.1',
        family: 4,
      },
    ])
    const pinnedAddresses: Array<{ address: string; family: number | undefined }> = []
    const agents: Agent[] = []
    const createAgent = vi.fn(({ lookup }: { lookup: LookupFunction }) => {
      const agent = new Agent()
      agents.push(agent)
      lookup('ignored.example', {}, (error, address, family) => {
        expect(error).toBeNull()
        expect(typeof address).toBe('string')
        pinnedAddresses.push({ address: address as string, family })
      })
      return agent
    })
    let fetchCalls = 0
    const fetch: typeof import('undici').fetch = async (_url, init) => {
      fetchCalls += 1
      expect(init?.dispatcher).toBe(agents.at(-1))
      return fetchCalls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example/credential.json' },
          })
        : new Response('hello')
    }
    const resolver = new SafePayloadResolver('https://gateway.example/', {
      lookup: lookups,
      fetch,
      createAgent,
    })

    await expect(resolver.resolve(HTTPS_URI)).resolves.toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    )
    expect(lookups.mock.calls.map(([hostname]) => hostname)).toEqual([
      'issuer.example',
      'cdn.example',
    ])
    expect(pinnedAddresses).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ])
    expect(createAgent).toHaveBeenCalledTimes(2)
    expect(fetchCalls).toBe(2)
  })

  it('classifies transport failure as unavailable', async () => {
    const resolver = new SafePayloadResolver('https://gateway.example/', {
      lookup: PUBLIC_LOOKUP,
      fetch: async () => {
        throw new Error('connection reset')
      },
    })

    await expect(resolver.resolve(HTTPS_URI)).rejects.toBeInstanceOf(PayloadUnavailableError)
  })

  it('bounds DNS lookup with the same retrieval deadline', async () => {
    vi.useFakeTimers()
    try {
      const resolver = new SafePayloadResolver('https://gateway.example/', {
        lookup: () => new Promise(() => undefined),
        fetch: async () => new Response('unexpected'),
      })
      const outcome = expect(resolver.resolve(HTTPS_URI)).rejects.toBeInstanceOf(
        PayloadUnavailableError,
      )

      await vi.advanceTimersByTimeAsync(5_001)
      await outcome
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies only observed bytes and ignores non-normative response headers', async () => {
    const resolver = new SafePayloadResolver('https://gateway.example/', {
      lookup: PUBLIC_LOOKUP,
      fetch: async () =>
        new Response('hello', {
          headers: {
            'content-length': String(ONE_MIB + 1),
            'content-type': 'application/octet-stream',
          },
        }),
    })

    await expect(resolver.resolve(HTTPS_URI)).resolves.toEqual(
      new Uint8Array([104, 101, 108, 108, 111]),
    )
  })

  it('accepts exactly one MiB of observed response bytes', async () => {
    const resolver = new SafePayloadResolver('https://gateway.example/', {
      lookup: PUBLIC_LOOKUP,
      fetch: async () => new Response(new Uint8Array(ONE_MIB)),
    })

    await expect(resolver.resolve(HTTPS_URI)).resolves.toHaveLength(ONE_MIB)
  })

  it('classifies one observed byte above one MiB as invalid', async () => {
    const resolver = new SafePayloadResolver('https://gateway.example/', {
      lookup: PUBLIC_LOOKUP,
      fetch: async () => new Response(new Uint8Array(ONE_MIB + 1)),
    })

    await expect(resolver.resolve(HTTPS_URI)).rejects.toBeInstanceOf(PayloadInvalidError)
  })
})
