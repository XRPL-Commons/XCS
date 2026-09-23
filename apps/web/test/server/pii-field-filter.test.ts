import { describe, expect, it } from 'vitest'

import { hasPiiShapedFieldName } from '../../server/xcs/pii-field-filter.js'

describe('public demo pinning PII field-name guardrail', () => {
  it.each(['prenom', 'prénom', 'full name', 'phone-number', 'national_id', 'street.address'])(
    'rejects the normalized person-specific field %s',
    (fieldName) => {
      expect(hasPiiShapedFieldName({ claims: [{ [fieldName]: 'Fictitious value' }] })).toBe(true)
    },
  )

  it.each(['name', 'nom', 'courseName', 'eventName', 'walletAddress'])(
    'keeps the context-neutral field %s valid',
    (fieldName) => {
      expect(hasPiiShapedFieldName({ [fieldName]: 'Test course' })).toBe(false)
    },
  )

  it('does not pretend to classify values stored under arbitrary fields', () => {
    expect(hasPiiShapedFieldName({ note: 'test@example.test' })).toBe(false)
  })
})
