import { describe, expect, it } from 'vitest'

import { loadApiConfig, loadHostedPayloadConfig } from '../../server/xcs/config.js'
import {
  DisabledPayloadResolver,
  PayloadUnavailableError,
} from '../../server/xcs/payload-resolver.js'

const METRICS_TOKEN = 'test-operational-metrics-token-00000001'

describe('API configuration', () => {
  it('uses repository-standard XCS variables and disables fetching by default', () => {
    const config = loadApiConfig({
      XCS_DATABASE_URL: 'postgres://xcs:xcs@localhost/xcs',
    })
    expect(config).toMatchObject({
      databaseUrl: 'postgres://xcs:xcs@localhost/xcs',
      trustedProxyCidrs: [],
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
        XCS_TRUSTED_PROXY_CIDRS: '127.0.0.1,10.42.0.0/16,2001:db8::/32',
      }).trustedProxyCidrs,
    ).toEqual(['127.0.0.1', '10.42.0.0/16', '2001:db8::/32'])
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_TRUSTED_PROXY_CIDRS: '*',
      }),
    ).toThrow('explicit IP addresses or CIDRs')
    for (const catchAll of ['0.0.0.0/0', '::/0']) {
      expect(() =>
        loadApiConfig({
          XCS_DATABASE_URL: 'postgres://localhost/xcs',
          XCS_TRUSTED_PROXY_CIDRS: catchAll,
        }),
      ).toThrow('explicit IP addresses or CIDRs')
    }
  })

  it('enables operational metrics from a valid token alone', () => {
    expect(
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_METRICS_TOKEN: METRICS_TOKEN,
      }).operationalMetrics,
    ).toEqual({ enabled: true, token: METRICS_TOKEN })
  })

  it('leaves operational metrics off when no token is supplied', () => {
    expect(
      loadApiConfig({ XCS_DATABASE_URL: 'postgres://localhost/xcs' }).operationalMetrics,
    ).toEqual({ enabled: false })
    for (const blank of ['', '   ']) {
      expect(
        loadApiConfig({
          XCS_DATABASE_URL: 'postgres://localhost/xcs',
          XCS_METRICS_TOKEN: blank,
        }).operationalMetrics,
      ).toEqual({ enabled: false })
    }
  })

  it('rejects a malformed token rather than silently disabling the routes', () => {
    for (const token of ['too-short', `${METRICS_TOKEN}!`, 'a'.repeat(257)]) {
      expect(() =>
        loadApiConfig({
          XCS_DATABASE_URL: 'postgres://localhost/xcs',
          XCS_METRICS_TOKEN: token,
        }),
      ).toThrow('XCS_METRICS_TOKEN must be 32 to 256 URL-safe random characters')
    }
  })

  it('rejects an unsafe readiness staleness threshold', () => {
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_READINESS_MAX_LEDGER_AGE_SECONDS: '0',
      }),
    ).toThrow('XCS_READINESS_MAX_LEDGER_AGE_SECONDS')
  })

  it('rejects wildcard CORS and ambiguous booleans', () => {
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_ALLOWED_ORIGINS: '*',
      }),
    ).toThrow('cannot use *')
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_PAYLOAD_FETCH_ENABLED: 'yes',
      }),
    ).toThrow('exactly true or false')
  })

  it('rejects invalid or contradictory issuer trust configuration', () => {
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_TRUSTED_ISSUERS: 'not-an-address',
      }),
    ).toThrow('XCS_TRUSTED_ISSUERS')

    const issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
    expect(() =>
      loadApiConfig({
        XCS_DATABASE_URL: 'postgres://localhost/xcs',
        XCS_TRUSTED_ISSUERS: issuer,
        XCS_UNTRUSTED_ISSUERS: issuer,
      }),
    ).toThrow('must not overlap')
  })

  it('derives hosted payload publication from one complete server contract', () => {
    const hostedEnvironment = {
      XCS_PUBLIC_PAYLOAD_BASE_URL: 'https://p.xcs.test',
      XCS_PAYLOAD_STORAGE_IP_HASH_SECRET: 'test-only-hosted-payload-secret-0001',
      XCS_HOSTED_PAYLOAD_NETWORKS: 'testnet-a,testnet-b',
    }
    expect(loadHostedPayloadConfig(hostedEnvironment)).toEqual({
      enabled: true,
      publicBaseUrl: 'https://p.xcs.test',
      ipHashSecret: 'test-only-hosted-payload-secret-0001',
      networks: ['testnet-a', 'testnet-b'],
    })
    expect(loadHostedPayloadConfig({})).toEqual({ enabled: false })
    expect(() => loadHostedPayloadConfig({ XCS_HOSTED_PAYLOAD_NETWORKS: 'testnet-a' })).toThrow(
      'XCS_PUBLIC_PAYLOAD_BASE_URL is required',
    )
    expect(
      loadApiConfig({
        ...hostedEnvironment,
        XCS_DATABASE_URL: 'postgres://xcs_api:password@localhost/xcs',
        XCS_PAYLOAD_DATABASE_URL: 'postgres://xcs_payload_writer:password@localhost/xcs',
      }).hostedPayloads,
    ).toMatchObject({ enabled: true, publicBaseUrl: 'https://p.xcs.test' })
  })

  it('uses a network-free resolver when fetching is disabled', async () => {
    await expect(
      new DisabledPayloadResolver().resolve('https://example.test'),
    ).rejects.toBeInstanceOf(PayloadUnavailableError)
  })
})
