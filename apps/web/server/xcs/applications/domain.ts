export interface OrganizationApplication {
  id: string
  name: string
  status: 'active' | 'suspended' | 'closed'
  applicationStatus: 'pending' | 'approved' | 'rejected' | 'suspended'
  reviewReason: string | null
  revision: number
}

export interface ApplicationInput {
  name: string
  website: string
  contact: string
  jurisdiction: string
  description: string
  purpose: string
  documents: { mimeType: string; base64: string }[]
}

export class ApplicationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export function inputObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ApplicationError(400, 'APPLICATION_INPUT_INVALID')
  return value as Record<string, unknown>
}

export function inputText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(character),
    )
  )
    throw new ApplicationError(400, 'APPLICATION_INPUT_INVALID')
  return value.trim()
}

export function inputUuid(value: unknown): string {
  const id = inputText(value, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new ApplicationError(400, 'APPLICATION_INPUT_INVALID')
  return id.toLowerCase()
}

export function parseApplicationInput(value: unknown): ApplicationInput {
  const input = inputObject(value, [
    'name',
    'website',
    'contact',
    'jurisdiction',
    'description',
    'purpose',
    'documents',
  ])
  const website = inputText(input.website, 2048)
  try {
    const url = new URL(website)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
  } catch {
    throw new ApplicationError(400, 'APPLICATION_WEBSITE_INVALID')
  }
  if (!Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > 3)
    throw new ApplicationError(400, 'APPLICATION_DOCUMENT_REQUIRED')
  return {
    name: inputText(input.name, 200),
    website,
    contact: inputText(input.contact, 1000),
    jurisdiction: inputText(input.jurisdiction, 200),
    description: inputText(input.description, 5000),
    purpose: inputText(input.purpose, 5000),
    documents: input.documents.map((value) => {
      const document = inputObject(value, ['mimeType', 'base64'])
      return {
        mimeType: inputText(document.mimeType, 100),
        base64: inputText(document.base64, Math.ceil((5 * 1024 * 1024) / 3) * 4),
      }
    }),
  }
}

export interface ApplicationRepository {
  apply(
    session: import('../auth/types').Session,
    input: ApplicationInput,
    role: 'issuer' | 'verifier',
  ): Promise<{ organizationId: string; status: 'pending' }>
}
