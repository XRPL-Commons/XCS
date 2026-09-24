import { isIP } from 'node:net'
import { isValidClassicAddress } from 'xrpl'
import { adminSecret } from './admin/config'

export interface ApiConfig {
  databaseUrl: string
  payloadDatabaseUrl: string | undefined
  hostedPayloads:
    | { enabled: false }
    | { enabled: true; publicBaseUrl: string; ipHashSecret: string; networks: string[] }
  trustedProxyCidrs: string[]
  ipfsGateway: string
  trustedIssuers: string[]
  untrustedIssuers: string[]
  allowedOrigins: string[]
  payloadFetchEnabled: boolean
  readinessMaxLedgerAgeSeconds: number
  operationalMetrics:
    | { enabled: false }
    | {
        enabled: true
        token: string
      }
  demoPinning:
    | { enabled: false }
    | {
        enabled: true
        kuboRpcUrl: string
        ipHashSecret: string
        networks: string[]
      }
}

function operationalMetrics(environment: NodeJS.ProcessEnv): ApiConfig['operationalMetrics'] {
  const enabled = strictBoolean(environment.XCS_METRICS_ENABLED, false, 'XCS_METRICS_ENABLED')
  if (!enabled) return { enabled: false }

  const token = required(environment, 'XCS_METRICS_TOKEN')
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    throw new Error('XCS_METRICS_TOKEN must be 32 to 256 URL-safe random characters')
  }
  return { enabled: true, token }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = adminSecret(environment, name)
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}

function compatibleRequired(
  environment: NodeJS.ProcessEnv,
  primary: string,
  legacy: string,
): string {
  const value = adminSecret(environment, primary) || adminSecret(environment, legacy)
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${primary} is required`)
  }
  return value
}

function addressList(value: string | undefined, name: string): string[] {
  const addresses =
    value === undefined
      ? []
      : [
          ...new Set(
            value
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        ]
  const invalid = addresses.find((address) => !isValidClassicAddress(address))
  if (invalid !== undefined) throw new Error(`${name} contains an invalid classic address`)
  return addresses
}

function list(value: string | undefined, defaults: string[] = []): string[] {
  if (value === undefined) return defaults
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ]
}

function trustedProxyCidrs(value: string | undefined): string[] {
  return list(value).map((entry) => {
    const [address, prefix, ...rest] = entry.split('/')
    const version = address === undefined ? 0 : isIP(address)
    const validPrefix =
      prefix === undefined ||
      (/^[0-9]{1,3}$/u.test(prefix) &&
        Number(prefix) > 0 &&
        Number(prefix) <= (version === 4 ? 32 : 128))
    if (version === 0 || rest.length > 0 || !validPrefix) {
      throw new Error('XCS_TRUSTED_PROXY_CIDRS must contain only explicit IP addresses or CIDRs')
    }
    return entry
  })
}

function strictBoolean(value: string | undefined, defaultValue: boolean, name: string): boolean {
  if (value === undefined) return defaultValue
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be exactly true or false`)
}

function origins(value: string | undefined): string[] {
  const values = list(value, ['http://localhost:3000'])
  if (values.length === 0 || values.includes('*')) {
    throw new Error('XCS_ALLOWED_ORIGINS must contain explicit origins and cannot use *')
  }
  return values.map((origin) => {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Invalid explicit CORS origin: ${origin}`)
    }
    return origin
  })
}

function databaseUrl(environment: NodeJS.ProcessEnv, name: string, role: string): string {
  const value = required(environment, name)
  try {
    const url = new URL(value)
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      decodeURIComponent(url.username) !== role
    ) {
      throw new Error('invalid role')
    }
  } catch {
    // Connection URLs can contain secrets: never include their value or parser error.
    throw new Error(`${name} must be a PostgreSQL URL for the ${role} role`)
  }
  return value
}

function hostedPayloadBaseUrl(value: string): string {
  const parsed = new URL(value)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.origin !== value ||
    Buffer.byteLength(`${value}/p/${'0'.repeat(18)}#xcs-sha256=${'0'.repeat(64)}`, 'utf8') > 128
  ) {
    throw new Error(
      'XCS_PUBLIC_PAYLOAD_BASE_URL must be a short HTTPS origin that produces a URI of at most 128 bytes',
    )
  }
  return value
}

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const readinessMaxLedgerAgeSeconds = Number(
    environment.XCS_READINESS_MAX_LEDGER_AGE_SECONDS ?? '120',
  )
  if (
    !Number.isInteger(readinessMaxLedgerAgeSeconds) ||
    readinessMaxLedgerAgeSeconds < 10 ||
    readinessMaxLedgerAgeSeconds > 3_600
  ) {
    throw new Error('XCS_READINESS_MAX_LEDGER_AGE_SECONDS must be an integer between 10 and 3600')
  }
  const demoPinningEnabled = strictBoolean(
    environment.XCS_DEMO_PINNING_ENABLED,
    false,
    'XCS_DEMO_PINNING_ENABLED',
  )
  const demoPinning = demoPinningEnabled
    ? {
        enabled: true as const,
        kuboRpcUrl: required(environment, 'XCS_IPFS_API_URL'),
        ipHashSecret: required(environment, 'XCS_PINNING_IP_HASH_SECRET'),
        networks: list(environment.XCS_PINNING_NETWORKS),
      }
    : ({ enabled: false } as const)
  const trustedIssuers = addressList(environment.XCS_TRUSTED_ISSUERS, 'XCS_TRUSTED_ISSUERS')
  const hostedPayloadsEnabled = strictBoolean(
    environment.XCS_HOSTED_PAYLOADS_ENABLED,
    false,
    'XCS_HOSTED_PAYLOADS_ENABLED',
  )
  const hostedPayloads: ApiConfig['hostedPayloads'] = hostedPayloadsEnabled
    ? {
        enabled: true,
        publicBaseUrl: hostedPayloadBaseUrl(required(environment, 'XCS_PUBLIC_PAYLOAD_BASE_URL')),
        ipHashSecret: required(environment, 'XCS_PAYLOAD_STORAGE_IP_HASH_SECRET'),
        networks: list(environment.XCS_HOSTED_PAYLOAD_NETWORKS),
      }
    : { enabled: false }
  const untrustedIssuers = addressList(environment.XCS_UNTRUSTED_ISSUERS, 'XCS_UNTRUSTED_ISSUERS')
  if (trustedIssuers.some((issuer) => untrustedIssuers.includes(issuer))) {
    throw new Error('XCS_TRUSTED_ISSUERS and XCS_UNTRUSTED_ISSUERS must not overlap')
  }
  return {
    databaseUrl: compatibleRequired(environment, 'XCS_DATABASE_URL', 'DATABASE_URL'),
    payloadDatabaseUrl:
      hostedPayloadsEnabled || demoPinningEnabled
        ? databaseUrl(environment, 'XCS_PAYLOAD_DATABASE_URL', 'xcs_payload_writer')
        : undefined,
    hostedPayloads,
    trustedProxyCidrs: trustedProxyCidrs(environment.XCS_TRUSTED_PROXY_CIDRS),
    ipfsGateway:
      environment.XCS_IPFS_GATEWAY_URL ?? environment.IPFS_GATEWAY_URL ?? 'https://ipfs.io/',
    trustedIssuers,
    untrustedIssuers,
    allowedOrigins: origins(environment.XCS_ALLOWED_ORIGINS),
    payloadFetchEnabled: strictBoolean(
      environment.XCS_PAYLOAD_FETCH_ENABLED,
      false,
      'XCS_PAYLOAD_FETCH_ENABLED',
    ),
    readinessMaxLedgerAgeSeconds,
    operationalMetrics: operationalMetrics(environment),
    demoPinning,
  }
}
