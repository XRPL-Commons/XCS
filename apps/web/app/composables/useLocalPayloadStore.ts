import { parsePayloadUri } from '@xcs-protocol/core'
import {
  clearLocalTestPayloads,
  inspectLocalTestPayloadLocation,
  readLocalTestPayload,
  storeLocalTestPayload,
} from '~/utils/localPayloadStore'
import { resolveLocalPayloadStoreClientMode } from '~/utils/localPayloadStoreMode'
import {
  inspectPilotHttpsPayloadHost,
  readCanonicalHttpsPayload,
  type HttpsPayloadRead,
  type PayloadPublicationProof,
  type ReadPayloadOptions,
} from '~/utils/payloadPublication'

function exactBytesMatch(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  )
}

export function useLocalPayloadStore() {
  const config = useRuntimeConfig()
  const enabled = ref(false)

  onMounted(() => {
    enabled.value = resolveLocalPayloadStoreClientMode(
      config.public.localPayloadStoreMode,
      import.meta.dev,
      window.location.hostname,
    )
  })

  function browserStorage(): Storage {
    if (!import.meta.client || !enabled.value) throw new Error('LOCAL_PAYLOAD_STORE_DISABLED')
    try {
      return window.localStorage
    } catch (cause) {
      throw new Error('LOCAL_PAYLOAD_STORE_UNAVAILABLE', { cause })
    }
  }

  function publish(
    canonicalPayload: string,
    options: { readonly nonPersonalTestDataAcknowledged: boolean },
  ) {
    const publication = storeLocalTestPayload({
      storage: browserStorage(),
      content: canonicalPayload,
      nonPersonalTestDataAcknowledged: options.nonPersonalTestDataAcknowledged,
    })
    const read = readLocalTestPayload({
      storage: browserStorage(),
      credentialUri: publication.credentialUri,
    })
    if (!exactBytesMatch(read.content, canonicalPayload)) {
      throw new Error('LOCAL_PAYLOAD_BYTES_MISMATCH')
    }
    return publication
  }

  async function readPayload(options: ReadPayloadOptions): Promise<HttpsPayloadRead> {
    if (parsePayloadUri(options.credentialUri).kind === 'https') {
      return readCanonicalHttpsPayload(options)
    }
    return readLocalTestPayload({
      storage: browserStorage(),
      credentialUri: options.credentialUri,
      ...(options.now ? { now: options.now } : {}),
    })
  }

  function inspectPayloadLocation(credentialUri: string): string {
    if (parsePayloadUri(credentialUri).kind === 'https') {
      return inspectPilotHttpsPayloadHost(credentialUri)
    }
    try {
      return inspectLocalTestPayloadLocation({
        storage: browserStorage(),
        credentialUri,
      })
    } catch (cause) {
      throw new Error('LOCAL_PAYLOAD_NOT_AVAILABLE_IN_BROWSER', { cause })
    }
  }

  async function verifyPublication(input: {
    readonly canonicalPayload: string
    readonly credentialUri: string
  }): Promise<PayloadPublicationProof> {
    const read = await readPayload({ credentialUri: input.credentialUri })
    if (!exactBytesMatch(read.content, input.canonicalPayload)) {
      throw new Error('PUBLISHED_PAYLOAD_BYTES_MISMATCH')
    }
    return {
      fetchUrl: read.fetchUrl,
      digestHex: read.digestHex,
      byteLength: read.byteLength,
      checkedAt: read.checkedAt,
      credentialUri: input.credentialUri,
    }
  }

  function clear(): number {
    return clearLocalTestPayloads(browserStorage())
  }

  return {
    enabled: readonly(enabled),
    publish,
    readPayload,
    inspectPayloadLocation,
    verifyPublication,
    clear,
  }
}
