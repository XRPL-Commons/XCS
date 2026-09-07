import { parseSchema, type ScalarFieldType, type SchemaDefinition } from '@xcs-protocol/core'

export const GUIDED_SCHEMA_FIELD_TYPES = [
  'string',
  'bool',
  'uint',
  'int',
  'bytes',
  'address',
] as const satisfies readonly ScalarFieldType[]

export interface GuidedSchemaField {
  name: string
  type: ScalarFieldType
  optional: boolean
}

export interface GuidedSchemaDraft {
  name: string
  description: string
  fields: GuidedSchemaField[]
}

const COURSE_COMPLETION_TEMPLATE: GuidedSchemaDraft = {
  name: 'Course Completion',
  description: 'Attests that the subject successfully completed a course.',
  fields: [
    { name: 'courseId', type: 'string', optional: false },
    { name: 'courseName', type: 'string', optional: false },
    { name: 'completedAt', type: 'string', optional: false },
    { name: 'certificateId', type: 'string', optional: false },
    { name: 'achievement', type: 'string', optional: true },
  ],
}

const DIPLOMA_TEMPLATE: GuidedSchemaDraft = {
  name: 'Diploma Award',
  description: 'Attests that the subject was awarded a diploma by the issuer.',
  fields: [
    { name: 'programId', type: 'string', optional: false },
    { name: 'programName', type: 'string', optional: false },
    { name: 'awardedAt', type: 'string', optional: false },
    { name: 'diplomaId', type: 'string', optional: false },
    { name: 'honors', type: 'string', optional: true },
  ],
}

function cloneDraft(draft: GuidedSchemaDraft): GuidedSchemaDraft {
  return {
    name: draft.name,
    description: draft.description,
    fields: draft.fields.map((field) => ({ ...field })),
  }
}

export function createCourseCompletionDraft(): GuidedSchemaDraft {
  return cloneDraft(COURSE_COMPLETION_TEMPLATE)
}

export function createDiplomaDraft(): GuidedSchemaDraft {
  return cloneDraft(DIPLOMA_TEMPLATE)
}

export function createEmptyGuidedField(): GuidedSchemaField {
  return { name: '', type: 'string', optional: false }
}

export function guidedSchemaToDefinition(draft: GuidedSchemaDraft): SchemaDefinition {
  const fields = Object.create(null) as Record<string, { type: ScalarFieldType; optional?: true }>

  for (const field of draft.fields) {
    if (Object.hasOwn(fields, field.name)) throw new Error('SCHEMA_FIELD_DUPLICATE')
    fields[field.name] = {
      type: field.type,
      ...(field.optional ? { optional: true as const } : {}),
    }
  }

  return parseSchema({
    xcsVersion: '0.1',
    name: draft.name,
    description: draft.description,
    fields,
  })
}

export function guidedSchemaToJson(draft: GuidedSchemaDraft): string {
  return JSON.stringify(guidedSchemaToDefinition(draft), null, 2)
}

export function schemaDefinitionToGuidedDraft(input: unknown): GuidedSchemaDraft {
  const schema = parseSchema(input)
  if (schema.extends !== undefined || schema.supersedes !== undefined) {
    throw new Error('GUIDED_EDITOR_ADVANCED_SCHEMA')
  }

  const fields: GuidedSchemaField[] = []
  for (const [name, descriptor] of Object.entries(schema.fields)) {
    if (descriptor.type === 'array' || descriptor.type === 'object') {
      throw new Error('GUIDED_EDITOR_ADVANCED_SCHEMA')
    }
    fields.push({ name, type: descriptor.type, optional: descriptor.optional === true })
  }

  return { name: schema.name, description: schema.description, fields }
}
