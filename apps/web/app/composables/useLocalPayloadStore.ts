import { parsePayloadUri } from '#xcs/core/index.js'
import { inspectLocalTestPayloadLocation, readLocalTestPayload } from '~/utils/localPayloadStore'
import { resolveLocalPayloadStoreClientMode } from '~/utils/localPayloadStoreMode'
import {
  inspectPilotHttpsPayloadHost,
  readCanonicalHttpsPayload,
  type HttpsPayloadRead,
  type ReadPayloadOptions,
} from '~/utils/payloadPublication'

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

  return {
    enabled: readonly(enabled),
    readPayload,
    inspectPayloadLocation,
  }
}
