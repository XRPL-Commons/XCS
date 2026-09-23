import { describe, expect, it } from 'vitest'

import { loadApiConfig } from '../../server/xcs/config.js'
import {
  DisabledPayloadResolver,
  PayloadUnavailableError,
} from '../../server/xcs/payload-resolver.js'

const INTERNAL_SSR_TOKEN = 'test-internal-ssr-token-000000000001'
const METRICS_TOKEN = 'test-operational-metrics-token-00000001'

describe('API configuration', () => {
  it('uses repository-standard XCS variables and disables fetching by default', () => {
    const config = loadApiConfig({
      XCS_DATABASE_URL: 'postgres://xcs:xcs@localhost/xcs',
      XCS_API_PORT: '3001',
      XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
    })
    expect(config).toMatchObject({
      databaseUrl: 'postgres://xcs:xcs@localhost/xcs',
      internalSsrToken: INTERNAL_SSR_TOKEN,
      trustedProxyCidrs: [],
      host: '0.0.0.0',
      port: 3001,
      allowedOrigins: ['http://localhost:3000'],
      payloadFetchEnabled: false,
      readinessMaxLedgerAgeSeconds: 120,
      operationalMetrics: { enabled: false },
      demoPinning: { enabled: false },
    })
  })

  it('accepts only explicit trusted proxy addresses and CIDRs', () => {
    expect(
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_TRUSTED_PROXY_CIDRS: '127.0.0.1,10.42.0.0/16,2001:db8::/32',
      }).trustedProxyCidrs,
    ).toEqual(['127.0.0.1', '10.42.0.0/16', '2001:db8::/32'])
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_TRUSTED_PROXY_CIDRS: '*',
      }),
    ).toThrow('explicit IP addresses or CIDRs')
    for (const catchAll of ['0.0.0.0/0', '::/0']) {
      expect(() =>
        loadApiConfig({
          XCS_DATABASE_URL: 'postgres://localhost/xcs',
          XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
          XCS_TRUSTED_PROXY_CIDRS: catchAll,
        }),
      ).toThrow('explicit IP addresses or CIDRs')
    }
  })

  it('requires a strong URL-safe internal SSR token', () => {
    expect(() => loadApiConfig({ XCS_DATABASE_URL: 'postgres://localhost/xcs' })).toThrow(
      'XCS_INTERNAL_API_TOKEN is required',
    )
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: 'too-short',
      }),
    ).toThrow('32 to 256 URL-safe random characters')
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: 'xcs-development-internal-token-0001',
      }),
    ).toThrow('32 to 256 URL-safe random characters')
  })

  it('requires a distinct strong token only when operational metrics are enabled', () => {
    expect(
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_METRICS_ENABLED: 'true',
        XCS_METRICS_TOKEN: METRICS_TOKEN,
      }).operationalMetrics,
    ).toEqual({ enabled: true, token: METRICS_TOKEN })
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_METRICS_ENABLED: 'true',
      }),
    ).toThrow('XCS_METRICS_TOKEN is required')
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_METRICS_ENABLED: 'true',
        XCS_METRICS_TOKEN: 'too-short',
      }),
    ).toThrow('XCS_METRICS_TOKEN must be 32 to 256 URL-safe random characters')
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_METRICS_ENABLED: 'true',
        XCS_METRICS_TOKEN: INTERNAL_SSR_TOKEN,
      }),
    ).toThrow('must be distinct')
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_METRICS_ENABLED: 'yes',
      }),
    ).toThrow('XCS_METRICS_ENABLED must be exactly true or false')
  })

  it('rejects an unsafe readiness staleness threshold', () => {
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_READINESS_MAX_LEDGER_AGE_SECONDS: '0',
      }),
    ).toThrow('XCS_READINESS_MAX_LEDGER_AGE_SECONDS')
  })

  it('rejects wildcard CORS and ambiguous booleans', () => {
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_ALLOWED_ORIGINS: '*',
      }),
    ).toThrow('cannot use *')
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_PAYLOAD_FETCH_ENABLED: 'yes',
      }),
    ).toThrow('exactly true or false')
  })

  it('rejects invalid or contradictory issuer trust configuration', () => {
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_TRUSTED_ISSUERS: 'not-an-address',
      }),
    ).toThrow('XCS_TRUSTED_ISSUERS')

    const issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_INTERNAL_API_TOKEN: INTERNAL_SSR_TOKEN,
        XCS_TRUSTED_ISSUERS: issuer,
        XCS_UNTRUSTED_ISSUERS: issuer,
      }),
    ).toThrow('must not overlap')
  })

  it('uses a network-free resolver when fetching is disabled', async () => {
    await expect(
      new DisabledPayloadResolver().resolve('https://example.test'),
    ).rejects.toBeInstanceOf(PayloadUnavailableError)
  })
})
