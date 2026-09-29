import { loadHostedPayloadConfig } from '../xcs/config'
import { loadIssuerConfig } from '../xcs/issuer/config'
import { apiEnvironment, publicProfileId } from '../xcs/settings'

/**
 * Publishes the browser-visible profile identifier, derived from the network
 * profile file this deployment serves rather than from a variable of its own.
 *
 * The retired `NUXT_PUBLIC_PROFILE_ID` duplicated the `profileId` already inside
 * that file, and nothing checked the two agreed: a mismatch would have let the
 * interface label one network's data with another network's name. It is no longer
 * a deployment input -- it is absent from `.env.example` -- and this plugin
 * overwrites whatever a stale secret store still supplies, so a leftover value
 * cannot take effect.
 *
 * Nitro's runtime config is frozen at first access, so the derived value is
 * handed to Nitro through the same `NUXT_PUBLIC_*` override it already applies to
 * `runtimeConfig.public`. This plugin therefore deliberately does not call
 * `useRuntimeConfig()`: it must not be the access that freezes the config. It is
 * named to sort before every other plugin for the same reason.
 *
 * Reading the profile fails closed -- an invalid or unreadable file stops the
 * server rather than serving a wrongly labelled site. No profile file yields the
 * empty identifier, which is what an unset `NUXT_PUBLIC_PROFILE_ID` already meant.
 */
export default defineNitroPlugin(() => {
  const environment = apiEnvironment()
  const hostedPayloads = loadHostedPayloadConfig(environment)
  process.env.NUXT_PUBLIC_PROFILE_ID = publicProfileId(environment)
  process.env.NUXT_PUBLIC_ISSUER_ENABLED = loadIssuerConfig(environment) === undefined ? '0' : '1'
  process.env.NUXT_PUBLIC_PAYLOAD_BASE_URL = hostedPayloads.enabled
    ? hostedPayloads.publicBaseUrl
    : ''
})
