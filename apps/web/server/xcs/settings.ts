import { readFileSync } from 'node:fs'

import { parseNetworkProfile, type NetworkProfile } from '#xcs/core'

/**
 * Checked-in behavioural settings for the web app and its `/v1` read API.
 *
 * The deployment contract in `apps/web/.env.example` holds secrets and values
 * that genuinely differ per deployment. Feature flags, gateway endpoints,
 * thresholds and the static pilot trust policy are behaviour, so they live here
 * and ship with the image instead. Flipping one is a reviewed code change and an
 * image rebuild; a secret store cannot change it.
 *
 * The values are strings because they are fed through exactly the same parsing
 * and validation as before: `loadApiConfig` still receives one
 * environment-shaped record and still reports the same errors under the same
 * names, so a bad edit here fails at start-up the way a bad variable used to.
 */
export const apiSettings = {
  /** XRPL Commons Identity endpoint used by the account workspace. */
  XCS_IDENTITY_ISSUER: 'https://account.xrpl.in',
  /** Session lifetimes for the account workspace. */
  XCS_AUTH_IDLE_SECONDS: '1800',
  XCS_AUTH_MAX_SECONDS: '28800',
  /** Issuer invitation lifetime. */
  XCS_ISSUER_INVITE_DAYS: '7',
  /** Server-side fetching of credential payloads. Off. */
  XCS_PAYLOAD_FETCH_ENABLED: 'false',
  /** Gateway used to fetch `ipfs://` payloads once the flag above is on. */
  XCS_IPFS_GATEWAY_URL: 'https://ipfs.io/',
  /**
   * Demonstration-only pinning endpoint. Off, and while it is off none of
   * `XCS_IPFS_API_URL`, `XCS_PINNING_NETWORKS` or the
   * `XCS_PINNING_IP_HASH_SECRET` secret is read at all.
   */
  XCS_DEMO_PINNING_ENABLED: 'false',
  /** Kubo RPC endpoint for the demo pinning service; the Compose service name. */
  XCS_IPFS_API_URL: 'http://ipfs:5001',
  /** Profile identifiers on which demo pinning is offered; none. */
  XCS_PINNING_NETWORKS: '',
  /** Readiness fails when the newest indexed ledger is older than this. */
  XCS_READINESS_MAX_LEDGER_AGE_SECONDS: '120',
  /** Static pilot trust policy; comma-separated XRPL classic addresses. */
  XCS_TRUSTED_ISSUERS: '',
  XCS_UNTRUSTED_ISSUERS: '',
} as const satisfies Record<string, string>

/**
 * The environment `loadApiConfig` parses in production: the process environment
 * with the checked-in settings applied on top, so a deployment variable of the
 * same name cannot reintroduce a retired setting or weaken a flag.
 */
export function apiEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, ...apiSettings }
}

/**
 * The network profile this deployment serves, when it names one.
 *
 * `XCS_NETWORK_PROFILE` is the one profile input that stays in the deployment
 * contract, for the same reason it does on the indexer side: every profile is a
 * separate published file that the operator creates (`config/networks/README.md`
 * forbids editing one in place), and the only profile committed here is the
 * deliberately invalid `testnet.example.json` template. There is therefore no
 * committed profile a code default could point at. Both apps must read the same
 * file, so the name is spelled the same way on both sides.
 */
export function loadNetworkProfile(
  environment: NodeJS.ProcessEnv = process.env,
): { profile: NetworkProfile; path: string } | undefined {
  const supplied = environment.XCS_NETWORK_PROFILE
  if (supplied === undefined || supplied.trim().length === 0) return undefined
  const path = supplied.trim()
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return { profile: parseNetworkProfile(input), path }
}

/**
 * The browser-visible profile identifier, derived from the profile file rather
 * than from a variable of its own.
 *
 * The retired `NUXT_PUBLIC_PROFILE_ID` duplicated the `profileId` inside that
 * file and nothing checked the two agreed, so a mismatch could have let the
 * interface label one network's data with another network's name. With one
 * source there is nothing to disagree with. A named profile is parsed and fails
 * closed; no profile yields the empty identifier, which is what an unset
 * `NUXT_PUBLIC_PROFILE_ID` already meant -- the network list is not filtered.
 */
export function publicProfileId(environment: NodeJS.ProcessEnv = process.env): string {
  return loadNetworkProfile(environment)?.profile.profileId ?? ''
}
