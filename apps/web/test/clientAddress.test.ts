import { describe, expect, it } from 'vitest'
import { createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { isInProcessRequest } from '../server/utils/inProcessRequest'
import { parseTrustedProxyCidrs, resolveClientAddress } from '../server/utils/clientAddress'

describe('client quota identity', () => {
  it('recognizes Nitro in-process requests by their server-owned structural marker', async () => {
    for (const address of ['198.51.100.10', '198.51.100.11']) {
      const request = new IncomingMessage(new Socket())
      Reflect.set(request, '__unenv__', { xcsClientAddress: address })
      const event = createEvent(request, new ServerResponse(request))
      expect(isInProcessRequest(event)).toBe(true)
    }
  })

  it('does not accept client-context headers as an internal SSR identity', async () => {
    const request = new IncomingMessage(new Socket())
    request.headers = {
      'xcs-client-address': '198.51.100.10',
      'x-xcs-client-key': 'a'.repeat(64),
      __unenv__: '{"xcsClientAddress":"198.51.100.10"}',
      'x-forwarded-for': '198.51.100.10',
    }
    const event = createEvent(request, new ServerResponse(request))
    expect(isInProcessRequest(event)).toBe(false)
  })

  it('ignores forwarded headers from untrusted peers', () => {
    expect(resolveClientAddress('198.51.100.10', '203.0.113.250', '')).toBe('198.51.100.10')
    expect(resolveClientAddress('::ffff:203.0.113.5', undefined, '')).toBe('203.0.113.5')
  })
  it('walks trusted proxies right-to-left, ignoring attacker-controlled prefixes', () => {
    for (const prefix of ['192.0.2.250', '203.0.113.251']) {
      expect(
        resolveClientAddress('10.42.0.5', `${prefix}, 198.51.100.10, 10.42.0.6`, '10.42.0.0/16'),
      ).toBe('198.51.100.10')
    }
    expect(resolveClientAddress('2001:db8:42::5', '198.51.100.10', '2001:db8:42::/48')).toBe(
      '198.51.100.10',
    )
  })
  it('fails closed for malformed chains, unresolved peers and wildcard ranges', () => {
    expect(resolveClientAddress('10.42.0.5', 'attacker, 198.51.100.10', '10.42.0.0/16')).toBe(
      '10.42.0.5',
    )
    expect(resolveClientAddress(undefined, '198.51.100.10', '')).toBe('unresolved-peer')
    for (const cidr of ['*', '0.0.0.0/0', '::/0'])
      expect(() => parseTrustedProxyCidrs(cidr)).toThrow('TRUSTED_PROXY_CIDRS_INVALID')
  })
})
