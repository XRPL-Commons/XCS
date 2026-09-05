import { describe, expect, it } from 'vitest'

import {
  assertLinkGeneration,
  assertLinkProfile,
  buildCredentialAcceptLink,
  buildCredentialPermalink,
  credentialPermalinkSubjectAction,
  singleRouteQueryValue,
} from '../app/utils/operationLinks'

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SCHEMA_UID = '12'.repeat(32)
const GENERATION_ID = '34'.repeat(32)

describe('credential operation links', () => {
  it('omits the subject from an acceptance link and binds profile plus generation', () => {
    const link = buildCredentialAcceptLink({
      profileId: 'xrpl-testnet-xcs-v0.1',
      issuer: ISSUER,
      schemaUid: SCHEMA_UID.toUpperCase(),
      generationId: GENERATION_ID.toUpperCase(),
    })

    expect(link).toContain('profile=xrpl-testnet-xcs-v0.1')
    expect(link).toContain(`issuer=${ISSUER}`)
    expect(link).toContain(`schema=${SCHEMA_UID}`)
    expect(link).toContain(`generation=${GENERATION_ID}`)
    expect(link).not.toContain('subject=')
  })

  it('binds an exact subject-removal link without trusting a subject query parameter', () => {
    const link = buildCredentialAcceptLink({
      profileId: 'xrpl-testnet-xcs-v0.1',
      issuer: ISSUER,
      schemaUid: SCHEMA_UID,
      generationId: GENERATION_ID,
      action: 'remove',
    })

    expect(link).toBe(
      `/accept?profile=xrpl-testnet-xcs-v0.1&issuer=${ISSUER}&schema=${SCHEMA_UID}&generation=${GENERATION_ID}&action=remove`,
    )
    expect(link).not.toContain('subject=')
  })

  it('binds an exact generation permalink to its network profile', () => {
    expect(
      buildCredentialPermalink({
        profileId: 'profile with spaces',
        generationId: GENERATION_ID.toUpperCase(),
      }),
    ).toBe(`/credentials/${GENERATION_ID}?profile=profile+with+spaces`)
  })

  it('derives permalink CTAs from current generation state and accepted flag', () => {
    expect(
      credentialPermalinkSubjectAction({
        currentGeneration: true,
        accepted: false,
        state: 'pending',
      }),
    ).toBe('accept')
    expect(
      credentialPermalinkSubjectAction({
        currentGeneration: true,
        accepted: false,
        state: 'expired',
      }),
    ).toBe('reject')
    expect(
      credentialPermalinkSubjectAction({
        currentGeneration: true,
        accepted: true,
        state: 'expired',
      }),
    ).toBe('remove')
    expect(
      credentialPermalinkSubjectAction({
        currentGeneration: true,
        accepted: true,
        state: 'deleted',
      }),
    ).toBeNull()
    expect(
      credentialPermalinkSubjectAction({
        currentGeneration: false,
        accepted: true,
        state: 'active',
      }),
    ).toBeNull()
  })

  it('fails closed when a linked profile or generation differs', () => {
    expect(() => assertLinkProfile('profile-a', 'profile-b')).toThrow(
      'CREDENTIAL_LINK_PROFILE_MISMATCH',
    )
    expect(() => assertLinkGeneration(GENERATION_ID, '56'.repeat(32))).toThrow(
      'CREDENTIAL_LINK_GENERATION_MISMATCH',
    )
  })

  it('does not silently drop repeated or valueless security constraints', () => {
    expect(singleRouteQueryValue(undefined)).toBe('')
    expect(singleRouteQueryValue(GENERATION_ID)).toBe(GENERATION_ID)
    expect(singleRouteQueryValue('')).not.toBe('')
    expect(singleRouteQueryValue([GENERATION_ID, '56'.repeat(32)])).not.toBe('')
    expect(singleRouteQueryValue(null)).not.toBe('')
  })
})
