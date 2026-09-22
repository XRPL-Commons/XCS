import type { JsonValue } from '@xcs-protocol/core'

import { assertBrowserE2eServerMode } from '../../../../app/utils/browserE2eMode'
import { canonicalJson } from '../../../../app/utils/serialization'

const PROFILE_ID = 'xrpl-testnet-xcs-browser-e2e'
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const GENERATION_ID = '34'.repeat(32)
const NO_URI_GENERATION_ID = '9a'.repeat(32)

function payloadMatches(input: unknown, expected: JsonValue): boolean {
  try {
    return canonicalJson(input) === canonicalJson(expected)
  } catch {
    return false
  }
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  assertBrowserE2eServerMode(config.browserE2eMode, config.public.browserE2eMode, import.meta.dev)
  if (config.browserE2eMode !== 'enabled') {
    throw createError({ statusCode: 404, statusMessage: 'Browser E2E API route not found' })
  }

  const body = await readBody<Record<string, unknown>>(event)
  const hasPayload = Object.hasOwn(body, 'payload')
  const metadataOnlyWithoutUri = body.subject === ISSUER && !hasPayload
  const expectedPayload = {
    xcsVersion: '0.1',
    issuer: ISSUER,
    subject: SUBJECT,
    schema: body.schemaUid,
    claims: {
      programId: 'xcs-protocol-engineering-2026',
      programName: 'Protocol Engineering',
      awardedAt: '2026-08-25T10:00:00Z',
      diplomaId: 'DIP-2026-0042',
      prenom: 'Personne Test',
      honors: 'with distinction',
    },
  }
  if (
    body.network !== PROFILE_ID ||
    body.issuer !== ISSUER ||
    (body.subject !== SUBJECT && body.subject !== ISSUER) ||
    typeof body.schemaUid !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(body.schemaUid) ||
    (hasPayload
      ? Object.hasOwn(body, 'resolvePayload') ||
        !payloadMatches(body.payload, expectedPayload as JsonValue)
      : body.resolvePayload !== false)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Browser E2E verify input invalid' })
  }

  return {
    onChain: 'active',
    schema: 'valid',
    payload: hasPayload ? 'valid' : 'not_checked',
    issuerTrust: 'unknown',
    generationId: metadataOnlyWithoutUri ? NO_URI_GENERATION_ID : GENERATION_ID,
  }
})
