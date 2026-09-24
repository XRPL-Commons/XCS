import { describe, expect, it } from 'vitest'

import { parseTrustedProxyCidrs, resolveClientAddress } from '../../server/utils/clientAddress'

describe('rate-limit client address resolution', () => {
  it('uses forwarded addresses only behind an explicitly trusted immediate proxy', () => {
    const trusted = '10.42.0.0/16,2001:db8:42::/48'
    expect(resolveClientAddress('10.42.0.5', '198.51.100.10', trusted)).toBe('198.51.100.10')
    expect(resolveClientAddress('203.0.113.5', '198.51.100.10', trusted)).toBe('203.0.113.5')
    expect(resolveClientAddress('::ffff:203.0.113.5', undefined, trusted)).toBe('203.0.113.5')
  })

  it('accepts the parsed list form the API configuration produces', () => {
    expect(resolveClientAddress('127.0.0.1', '198.51.100.10', ['127.0.0.1'])).toBe('198.51.100.10')
    expect(resolveClientAddress('127.0.0.1', '198.51.100.10', [])).toBe('127.0.0.1')
    expect(resolveClientAddress('127.0.0.1', '198.51.100.10', undefined)).toBe('127.0.0.1')
  })

  it('walks a trusted proxy chain from right to left and ignores attacker-controlled prefixes', () => {
    const trusted = '10.42.0.0/16'
    const first = resolveClientAddress(
      '10.42.0.5',
      '192.0.2.250, 198.51.100.10, 10.42.0.6',
      trusted,
    )
    const rotatedPrefix = resolveClientAddress(
      '10.42.0.5',
      '203.0.113.251, 198.51.100.10, 10.42.0.6',
      trusted,
    )
    expect(first).toBe('198.51.100.10')
    expect(rotatedPrefix).toBe(first)
  })

  it('fails closed for malformed forwarded chains and proxy ranges', () => {
    expect(resolveClientAddress('10.42.0.5', 'attacker, 198.51.100.10', '10.42.0.0/16')).toBe(
      '10.42.0.5',
    )
    expect(resolveClientAddress(undefined, '198.51.100.10', '10.42.0.0/16')).toBe('unresolved-peer')
    expect(() => parseTrustedProxyCidrs('*')).toThrow('TRUSTED_PROXY_CIDRS_INVALID')
    expect(() => parseTrustedProxyCidrs('0.0.0.0/0')).toThrow('TRUSTED_PROXY_CIDRS_INVALID')
    expect(() => parseTrustedProxyCidrs('::/0')).toThrow('TRUSTED_PROXY_CIDRS_INVALID')
  })
})
