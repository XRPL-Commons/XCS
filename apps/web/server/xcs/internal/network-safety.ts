import ipaddr from 'ipaddr.js'

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast'
  } catch {
    return false
  }
}

export function assertSafeHttpsPayloadUrl(url: URL): void {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('Payload URL must use HTTPS without credentials')
  }
}
