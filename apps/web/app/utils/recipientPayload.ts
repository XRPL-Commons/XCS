import { parsePayloadUri } from '#xcs/core/index.js'
import { readCanonicalHttpsPayload, type ReadPayloadOptions } from './payloadPublication'

/** Explicit private review can send the session only to this site's managed /q object. */
export function readRecipientPayload(options: ReadPayloadOptions, siteOrigin: string) {
  const uri = parsePayloadUri(options.credentialUri)
  if (uri.kind !== 'https') throw new Error('RECIPIENT_PRIVATE_PAYLOAD_ORIGIN')
  const url = new URL(uri.fetchUrl)
  const origin = new URL(siteOrigin)
  if (
    origin.protocol !== 'https:' ||
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.search ||
    !/^\/q\/[0-9a-f]{18}$/.test(url.pathname)
  )
    throw new Error('RECIPIENT_PRIVATE_PAYLOAD_ORIGIN')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return readCanonicalHttpsPayload({
    ...options,
    fetchImpl: async (input, init) => {
      if (String(input) !== uri.fetchUrl) throw new Error('RECIPIENT_PRIVATE_PAYLOAD_ORIGIN')
      return fetchImpl(input, { ...init, credentials: 'same-origin', mode: 'same-origin' })
    },
  })
}
