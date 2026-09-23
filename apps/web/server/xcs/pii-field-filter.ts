// Generic domain labels such as `name`/`nom` are intentionally absent: they can identify a course,
// diploma or event. This public-pinning guardrail only blocks names with a strong personal-data
// meaning and must not be treated as value classification.
const PII_FIELD_NAMES = new Set([
  'address',
  'adresse',
  'birthdate',
  'dateofbirth',
  'dob',
  'email',
  'familyname',
  'firstname',
  'fullname',
  'givenname',
  'lastname',
  'middlename',
  'mobile',
  'mobilenumber',
  'nationalid',
  'passport',
  'passportnumber',
  'phone',
  'phonenumber',
  'postaladdress',
  'prenom',
  'socialsecuritynumber',
  'ssn',
  'streetaddress',
  'telephone',
  'telephonenumber',
])

function normalizeFieldName(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
}

export function hasPiiShapedFieldName(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPiiShapedFieldName)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(
    ([key, child]) => PII_FIELD_NAMES.has(normalizeFieldName(key)) || hasPiiShapedFieldName(child),
  )
}
