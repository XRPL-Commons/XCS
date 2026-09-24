import { afterEach, describe, expect, it, vi } from 'vitest'

import { useXcsApi } from '../app/composables/useXcsApi'

const PROFILE = {
  profileId: 'xrpl-testnet-xcs-v0.1',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: 'Credentials',
  registryAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  registrationAmountDrops: '1',
  activationLedgerIndex: 100,
  activationLedgerHash: 'ab'.repeat(32),
} as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useXcsApi discovery contract', () => {
  it('selects the configured Testnet profile and sends bounded search query parameters', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/v1/networks') return { items: [PROFILE] }
      return { items: [], hasMore: false }
    })
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: { profileId: PROFILE.profileId },
    }))
    vi.stubGlobal('$fetch', fetchMock)

    const api = useXcsApi()
    await expect(api.getActiveNetworkProfile()).resolves.toEqual(PROFILE)
    await expect(api.search('course completion', 17)).resolves.toEqual({
      items: [],
      hasMore: false,
    })

    expect(fetchMock).toHaveBeenLastCalledWith(
      `/v1/networks/${PROFILE.profileId}/search`,
      expect.objectContaining({ query: { q: 'course completion', limit: 17 } }),
    )
  })

  it('normalizes exact hashes and forwards only explicit opaque cursors', async () => {
    const fetchMock = vi.fn(async () => ({
      generation: {},
      state: 'pending',
      timeline: [],
    }))
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: { profileId: PROFILE.profileId },
    }))
    vi.stubGlobal('$fetch', fetchMock)
    const api = useXcsApi()
    const hash = 'CD'.repeat(32)

    await api.getCredentialGeneration(hash, PROFILE.profileId)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/v1/networks/${PROFILE.profileId}/credential-generations/${hash.toLowerCase()}`,
      { baseURL: '' },
    )

    await api.getTransaction(hash, {
      network: PROFILE.profileId,
      cursor: '25',
      limit: 25,
    })
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/v1/networks/${PROFILE.profileId}/transactions/${hash.toLowerCase()}`,
      {
        baseURL: '',
        query: { cursor: '25', limit: 25 },
      },
    )

    await api.getStats(PROFILE.profileId)
    expect(fetchMock).toHaveBeenLastCalledWith(`/v1/networks/${PROFILE.profileId}/stats`, {
      baseURL: '',
    })
  })

  it('loads bounded profile readiness and normalizes transport failures', async () => {
    const readiness = {
      profileId: PROFILE.profileId,
      status: 'ready',
      checkpoint: {
        ledgerIndex: 123,
        ledgerHash: 'ab'.repeat(32),
        closeTime: 838_857_600,
        transactionRoot: 'cd'.repeat(32),
      },
    } as const
    const fetchMock = vi.fn(async () => readiness)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: { profileId: PROFILE.profileId },
    }))
    vi.stubGlobal('$fetch', fetchMock)

    const api = useXcsApi()
    await expect(api.getNetworkReadiness(PROFILE.profileId)).resolves.toEqual(readiness)
    expect(fetchMock).toHaveBeenLastCalledWith(`/v1/networks/${PROFILE.profileId}/readiness`, {
      baseURL: '',
      cache: 'no-store',
      retry: 0,
      timeout: 5_000,
    })

    fetchMock.mockRejectedValueOnce(new Error('503'))
    await expect(api.getNetworkReadiness(PROFILE.profileId)).rejects.toThrowError(
      'INDEXER_SIGNING_READINESS_UNAVAILABLE',
    )
  })
})
