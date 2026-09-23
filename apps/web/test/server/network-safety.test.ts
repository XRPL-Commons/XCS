import { describe, expect, it } from 'vitest'

import {
  assertSafeHttpsPayloadUrl,
  isPublicAddress,
} from '../../server/xcs/internal/network-safety.js'

describe('payload network safety', () => {
  it.each([
    '127.0.0.1',
    '::1',
    '169.254.1.1',
    'fe80::1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '100.64.0.1',
    '224.0.0.1',
    'ff02::1',
    '::ffff:127.0.0.1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public unicast address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )

  it.each([
    'http://public.example/payload',
    'file:///etc/passwd',
    'https://user:secret@public.example/payload',
  ])('rejects unsafe initial or redirect URL %s', (url) => {
    expect(() => assertSafeHttpsPayloadUrl(new URL(url))).toThrow()
  })

  it('accepts credential-free HTTPS URLs', () => {
    expect(() => assertSafeHttpsPayloadUrl(new URL('https://public.example/payload'))).not.toThrow()
  })
})
