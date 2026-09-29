import { type HostedPayloadService, HostedPayloadError } from './hosted-payloads.js'
import { PayloadUnavailableError, PayloadInvalidError } from './payload-resolver.js'
import type { PayloadResolver } from './types.js'
import { parsePayloadUri } from '#xcs/core/index.js'
export class HostedPayloadResolver implements PayloadResolver {
  constructor(
    private readonly origin: string,
    private readonly hosted: HostedPayloadService,
    private readonly external: PayloadResolver,
  ) {}
  async resolve(uri: string) {
    const parsed = parsePayloadUri(uri)
    if (parsed.kind !== 'https') return this.external.resolve(uri)
    const url = new URL(parsed.fetchUrl)
    const match = /^\/p\/([0-9a-f]{18}|[0-9a-f]{20})$/u.exec(url.pathname)
    if (
      url.origin !== this.origin ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      match === null
    ) {
      return this.external.resolve(uri)
    }
    try {
      const payload = await this.hosted.get(match[1]!)
      return new TextEncoder().encode(payload.content)
    } catch (error) {
      if (error instanceof HostedPayloadError) {
        if (error.code === 'PAYLOAD_NOT_FOUND') {
          throw new PayloadUnavailableError('Hosted payload not found', { cause: error })
        }
        if (error.code === 'PAYLOAD_STORAGE_INTEGRITY_ERROR') {
          throw new PayloadInvalidError('Hosted payload storage integrity failed', { cause: error })
        }
      }
      throw error
    }
  }
}
