import type { VerificationReport } from './verification.js'
import { CREDENTIAL_DELETION_CAUSES } from './credential-generation-evidence.js'
import { MAX_SCHEMA_CATALOG_ENTRIES } from './schema-catalog.js'

export const PROFILE_PATTERN = '^[a-z0-9][a-z0-9._-]{0,127}$'
export const UID_PATTERN = '^[0-9a-f]{64}$'
export const INPUT_HASH_PATTERN = '^[0-9A-Fa-f]{64}$'
export const LOWERCASE_HASH = /^[0-9a-f]{64}$/u
export const HEX_BYTES = /^(?:[0-9A-Fa-f]{2})*$/u
export const REASON_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u
export const ADDRESS_PATTERN = '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'
export const CREDENTIAL_EVENT_HISTORY_LIMIT = 100
export const CREDENTIAL_GENERATION_TIMELINE_LIMIT = 100
export const EXACT_CREDENTIAL_EVENT_QUERY_LIMIT = 2
export const DISCOVERY_SEARCH_DEFAULT_LIMIT = 20
export const DISCOVERY_SEARCH_MAX_LIMIT = 50
export const DISCOVERY_PAGE_DEFAULT_LIMIT = 20
export const DISCOVERY_PAGE_MAX_LIMIT = 100
export const MAX_NODE_INDEX = 2_147_483_647
export const MAX_UINT32 = 4_294_967_295
export const SEARCH_QUERY_CONTENT = /[\p{L}\p{N}]/u
export const SEARCH_QUERY_CONTROL = /[\u0000-\u001f\u007f]/u
export const INTERNAL_SSR_TOKEN = /^[A-Za-z0-9_-]{32,256}$/u
export const INTERNAL_SSR_CLIENT_KEY = /^[0-9a-f]{64}$/u
export const INTERNAL_SSR_TOKEN_HEADER = 'x-xcs-internal-token'
export const INTERNAL_SSR_CLIENT_KEY_HEADER = 'x-xcs-client-key'
export const INTERNAL_METRICS_TOKEN_HEADER = 'authorization'
export const INTERNAL_METRICS_TOKEN = /^[A-Za-z0-9_-]{32,256}$/u
export const errorResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error', 'message'],
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const
export const rateLimitResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['statusCode', 'error', 'message'],
  properties: {
    statusCode: { type: 'integer', const: 429 },
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const
export const networkParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['network'],
  properties: { network: { type: 'string', pattern: PROFILE_PATTERN } },
} as const
export const publicIndexerStatusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['profileId', 'state', 'sourceTips', 'lastAgreedLedger', 'errorCode', 'updatedAt'],
  properties: {
    profileId: { type: 'string', pattern: PROFILE_PATTERN },
    state: { type: 'string', enum: ['starting', 'catching_up', 'ready', 'halted'] },
    sourceTips: {
      type: 'object',
      additionalProperties: false,
      required: ['primary', 'secondary'],
      properties: {
        primary: { type: 'integer', nullable: true, minimum: 0, maximum: 4_294_967_295 },
        secondary: { type: 'integer', nullable: true, minimum: 0, maximum: 4_294_967_295 },
      },
    },
    lastAgreedLedger: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'hash'],
          properties: {
            index: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
            hash: { type: 'string', pattern: UID_PATTERN },
          },
        },
        { type: 'null' },
      ],
    },
    errorCode: {
      type: 'string',
      nullable: true,
      pattern: '^[A-Z][A-Z0-9_]{0,63}$',
    },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const
export const publicCredentialEventSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'transactionHash',
    'nodeIndex',
    'generationId',
    'ledgerIndex',
    'ledgerHash',
    'transactionIndex',
    'eventType',
    'issuer',
    'subject',
    'schemaUid',
    'accepted',
    'deletionCause',
  ],
  properties: {
    transactionHash: { type: 'string', pattern: UID_PATTERN },
    nodeIndex: { type: 'integer', minimum: 0 },
    generationId: { type: 'string', pattern: UID_PATTERN },
    ledgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    ledgerHash: { type: 'string', pattern: UID_PATTERN },
    transactionIndex: { type: 'integer', minimum: 0 },
    eventType: { type: 'string', enum: ['created', 'accepted', 'deleted'] },
    issuer: { type: 'string', pattern: ADDRESS_PATTERN },
    subject: { type: 'string', pattern: ADDRESS_PATTERN },
    schemaUid: { type: 'string', pattern: UID_PATTERN },
    accepted: { type: 'boolean' },
    deletionCause: {
      anyOf: [
        {
          type: 'string',
          enum: [
            'issuer_revoked',
            'subject_rejected',
            'subject_removed',
            'expired_cleanup',
            'account_deleted',
            'self_deleted',
          ],
        },
        { type: 'null' },
      ],
    },
  },
} as const
export const credentialEventHistoryResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: { ...publicCredentialEventSchema, additionalProperties: true },
    },
  },
} as const
export const exactCredentialEventResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionHash', 'event'],
  properties: {
    transactionHash: { type: 'string', pattern: UID_PATTERN },
    event: { anyOf: [publicCredentialEventSchema, { type: 'null' }] },
  },
} as const
export const publicSchemaRegistrationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'publisher',
    'ledgerIndex',
    'ledgerHash',
    'transactionIndex',
    'schemaUid',
    'schemaDigestHex',
    'reasonCode',
  ],
  properties: {
    status: { type: 'string', enum: ['accepted', 'rejected'] },
    publisher: { type: 'string', pattern: ADDRESS_PATTERN },
    ledgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    ledgerHash: { type: 'string', pattern: UID_PATTERN },
    transactionIndex: { type: 'integer', minimum: 0 },
    schemaUid: { anyOf: [{ type: 'string', pattern: UID_PATTERN }, { type: 'null' }] },
    schemaDigestHex: { anyOf: [{ type: 'string', pattern: UID_PATTERN }, { type: 'null' }] },
    reasonCode: { anyOf: [{ type: 'string', minLength: 1, maxLength: 128 }, { type: 'null' }] },
  },
} as const
export const exactSchemaRegistrationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionHash', 'registration'],
  properties: {
    transactionHash: { type: 'string', pattern: UID_PATTERN },
    registration: { anyOf: [publicSchemaRegistrationSchema, { type: 'null' }] },
  },
} as const

export const publicCheckpointSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ledgerIndex', 'ledgerHash', 'closeTime', 'transactionRoot'],
  properties: {
    ledgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    ledgerHash: { type: 'string', pattern: UID_PATTERN },
    closeTime: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    transactionRoot: { type: 'string', pattern: UID_PATTERN },
  },
} as const

export const networkReadinessResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['profileId', 'status', 'checkpoint'],
  properties: {
    profileId: { type: 'string', pattern: PROFILE_PATTERN },
    status: { type: 'string', enum: ['ready'] },
    checkpoint: publicCheckpointSchema,
  },
} as const

export const publicSchemaSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaUid',
    'publisher',
    'name',
    'description',
    'parentUid',
    'supersedesUid',
    'registrationTransactionHash',
    'ledgerIndex',
    'transactionIndex',
  ],
  properties: {
    schemaUid: { type: 'string', pattern: UID_PATTERN },
    publisher: { type: 'string', pattern: ADDRESS_PATTERN },
    name: { type: 'string' },
    description: { type: 'string' },
    parentUid: { anyOf: [{ type: 'string', pattern: UID_PATTERN }, { type: 'null' }] },
    supersedesUid: { anyOf: [{ type: 'string', pattern: UID_PATTERN }, { type: 'null' }] },
    registrationTransactionHash: { type: 'string', pattern: UID_PATTERN },
    ledgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    transactionIndex: { type: 'integer', minimum: 0 },
  },
} as const

export const xcsFieldDescriptorSchema = {
  $id: 'XcsFieldDescriptor',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['string', 'bool', 'uint', 'int', 'bytes', 'address'] },
        optional: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'items'],
      properties: {
        type: { type: 'string', const: 'array' },
        optional: { type: 'boolean' },
        items: { $ref: 'XcsFieldDescriptor#' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'fields'],
      properties: {
        type: { type: 'string', const: 'object' },
        optional: { type: 'boolean' },
        fields: {
          type: 'object',
          minProperties: 1,
          additionalProperties: { $ref: 'XcsFieldDescriptor#' },
        },
      },
    },
  ],
} as const

export const xcsFieldsSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: { $ref: 'XcsFieldDescriptor#' },
} as const

export const xcsSchemaDefinitionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['xcsVersion', 'name', 'description', 'fields'],
  properties: {
    xcsVersion: { type: 'string', const: '0.1' },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    extends: { type: 'string', pattern: UID_PATTERN },
    supersedes: { type: 'string', pattern: UID_PATTERN },
    fields: xcsFieldsSchema,
  },
} as const

export const schemaCatalogResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['format', 'profile', 'targetUid', 'checkpoint', 'schemas'],
  properties: {
    format: { type: 'string', const: 'xcs-schema-catalog/1' },
    profile: {
      type: 'object',
      additionalProperties: false,
      required: [
        'profileId',
        'xcsVersion',
        'networkId',
        'requiredAmendment',
        'registryAddress',
        'registrationAmountDrops',
        'activationLedgerIndex',
        'activationLedgerHash',
      ],
      properties: {
        profileId: { type: 'string', pattern: PROFILE_PATTERN },
        xcsVersion: { type: 'string', const: '0.1' },
        networkId: { type: 'integer', minimum: 0, maximum: MAX_UINT32 },
        requiredAmendment: { type: 'string', pattern: '^[0-9A-F]{64}$' },
        registryAddress: { type: 'string', pattern: ADDRESS_PATTERN },
        registrationAmountDrops: { type: 'string', const: '1' },
        activationLedgerIndex: { type: 'integer', minimum: 1, maximum: MAX_UINT32 },
        activationLedgerHash: { type: 'string', pattern: UID_PATTERN },
      },
    },
    targetUid: { type: 'string', pattern: UID_PATTERN },
    checkpoint: {
      type: 'object',
      additionalProperties: false,
      required: ['ledgerIndex', 'ledgerHash'],
      properties: {
        ledgerIndex: { type: 'integer', minimum: 1, maximum: MAX_UINT32 },
        ledgerHash: { type: 'string', pattern: UID_PATTERN },
      },
    },
    schemas: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SCHEMA_CATALOG_ENTRIES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'uid',
          'definition',
          'publisher',
          'ledgerIndex',
          'ledgerHash',
          'transactionIndex',
          'transactionHash',
        ],
        properties: {
          uid: { type: 'string', pattern: UID_PATTERN },
          definition: xcsSchemaDefinitionSchema,
          publisher: { type: 'string', pattern: ADDRESS_PATTERN },
          ledgerIndex: { type: 'integer', minimum: 1, maximum: MAX_UINT32 },
          ledgerHash: { type: 'string', pattern: UID_PATTERN },
          transactionIndex: { type: 'integer', minimum: 0, maximum: MAX_UINT32 },
          transactionHash: { type: 'string', pattern: UID_PATTERN },
        },
      },
    },
  },
} as const

export const publicSchemaRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'profileId',
    ...publicSchemaSummarySchema.required,
    'definition',
    'resolvedDefinition',
    'registeredAt',
  ],
  properties: {
    profileId: { type: 'string', pattern: PROFILE_PATTERN },
    ...publicSchemaSummarySchema.properties,
    definition: xcsSchemaDefinitionSchema,
    resolvedDefinition: {
      type: 'object',
      additionalProperties: false,
      required: ['definition', 'fields', 'lineage'],
      properties: {
        definition: xcsSchemaDefinitionSchema,
        fields: xcsFieldsSchema,
        lineage: { type: 'array', items: { type: 'string', pattern: UID_PATTERN } },
      },
    },
    registeredAt: { type: 'string', format: 'date-time' },
  },
} as const

export const schemaListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', items: publicSchemaRowSchema },
    nextCursor: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const

export const credentialStateSchema = {
  type: 'string',
  enum: ['pending', 'active', 'expired', 'deleted'],
} as const

export const publicCredentialGenerationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'generationId',
    'ledgerObjectId',
    'issuer',
    'subject',
    'schemaUid',
    'uriHex',
    'expiration',
    'accepted',
    'createdLedgerIndex',
    'createdTransactionIndex',
    'lastLedgerIndex',
    'deletedLedgerIndex',
    'deletionCause',
  ],
  properties: {
    generationId: { type: 'string', pattern: UID_PATTERN },
    ledgerObjectId: { type: 'string', pattern: UID_PATTERN },
    issuer: { type: 'string', pattern: ADDRESS_PATTERN },
    subject: { type: 'string', pattern: ADDRESS_PATTERN },
    schemaUid: { type: 'string', pattern: UID_PATTERN },
    uriHex: { anyOf: [{ type: 'string', pattern: '^(?:[0-9A-Fa-f]{2})*$' }, { type: 'null' }] },
    expiration: {
      anyOf: [{ type: 'integer', minimum: 0, maximum: 4_294_967_295 }, { type: 'null' }],
    },
    accepted: { type: 'boolean' },
    createdLedgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    createdTransactionIndex: { type: 'integer', minimum: 0 },
    lastLedgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    deletedLedgerIndex: {
      anyOf: [{ type: 'integer', minimum: 0, maximum: 4_294_967_295 }, { type: 'null' }],
    },
    deletionCause: {
      anyOf: [
        {
          type: 'string',
          enum: [
            'issuer_revoked',
            'subject_rejected',
            'subject_removed',
            'expired_cleanup',
            'account_deleted',
            'self_deleted',
          ],
        },
        { type: 'null' },
      ],
    },
  },
} as const

export const exactCredentialResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'profileId',
    ...publicCredentialGenerationSchema.required,
    'createdAt',
    'updatedAt',
    'state',
  ],
  properties: {
    profileId: { type: 'string', pattern: PROFILE_PATTERN },
    ...publicCredentialGenerationSchema.properties,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    state: credentialStateSchema,
  },
} as const

export const verificationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['onChain', 'schema', 'payload', 'issuerTrust'],
  properties: {
    onChain: {
      type: 'string',
      enum: ['pending', 'active', 'expired', 'deleted', 'not_found'],
    },
    schema: { type: 'string', enum: ['valid', 'invalid', 'unknown'] },
    payload: {
      type: 'string',
      enum: ['valid', 'unavailable', 'tampered', 'invalid', 'not_checked'],
    },
    issuerTrust: { type: 'string', enum: ['trusted', 'untrusted', 'unknown'] },
    generationId: { type: 'string', pattern: UID_PATTERN },
  },
} as const

export const publicCredentialGenerationSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'generationId',
    'issuer',
    'subject',
    'schemaUid',
    'state',
    'createdLedgerIndex',
    'lastLedgerIndex',
  ],
  properties: {
    generationId: { type: 'string', pattern: UID_PATTERN },
    issuer: { type: 'string', pattern: ADDRESS_PATTERN },
    subject: { type: 'string', pattern: ADDRESS_PATTERN },
    schemaUid: { type: 'string', pattern: UID_PATTERN },
    state: credentialStateSchema,
    createdLedgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    lastLedgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
  },
} as const

export const publicTransactionSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'transactionHash',
    'ledgerIndex',
    'ledgerHash',
    'transactionIndex',
    'registrationStatus',
    'credentialEventCount',
  ],
  properties: {
    transactionHash: { type: 'string', pattern: UID_PATTERN },
    ledgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    ledgerHash: { type: 'string', pattern: UID_PATTERN },
    transactionIndex: { type: 'integer', minimum: 0 },
    registrationStatus: {
      anyOf: [{ type: 'string', enum: ['accepted', 'rejected'] }, { type: 'null' }],
    },
    credentialEventCount: { type: 'integer', minimum: 0 },
  },
} as const

export const discoveryStatsResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['network', 'schemas', 'credentialGenerations', 'checkpoint'],
  properties: {
    network: { type: 'string', pattern: PROFILE_PATTERN },
    schemas: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'publishers'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        publishers: { type: 'integer', minimum: 0 },
      },
    },
    credentialGenerations: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'pending', 'active', 'expired', 'deleted'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        pending: { type: 'integer', minimum: 0 },
        active: { type: 'integer', minimum: 0 },
        expired: { type: 'integer', minimum: 0 },
        deleted: { type: 'integer', minimum: 0 },
      },
    },
    checkpoint: publicCheckpointSchema,
  },
} as const

export const discoverySearchResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'hasMore'],
  properties: {
    items: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', ...publicSchemaSummarySchema.required],
            properties: {
              type: { type: 'string', const: 'schema' },
              ...publicSchemaSummarySchema.properties,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', ...publicCredentialGenerationSummarySchema.required],
            properties: {
              type: { type: 'string', const: 'credential_generation' },
              ...publicCredentialGenerationSummarySchema.properties,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', ...publicTransactionSummarySchema.required],
            properties: {
              type: { type: 'string', const: 'transaction' },
              ...publicTransactionSummarySchema.properties,
            },
          },
        ],
      },
    },
    hasMore: { type: 'boolean' },
  },
} as const

export const publicSchemaActivityItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionHash', ...publicSchemaRegistrationSchema.required],
  properties: {
    transactionHash: { type: 'string', pattern: UID_PATTERN },
    ...publicSchemaRegistrationSchema.properties,
  },
} as const

export const discoveryActivityResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', items: publicSchemaActivityItemSchema },
    nextCursor: { type: 'string' },
  },
} as const

export const credentialGenerationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['generation', 'state', 'timeline'],
  properties: {
    generation: publicCredentialGenerationSchema,
    state: credentialStateSchema,
    timeline: { type: 'array', items: publicCredentialEventSchema },
  },
} as const

export const transactionResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'transactionHash',
    'ledgerIndex',
    'ledgerHash',
    'transactionIndex',
    'registration',
    'credentialEvents',
  ],
  properties: {
    transactionHash: { type: 'string', pattern: UID_PATTERN },
    ledgerIndex: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    ledgerHash: { type: 'string', pattern: UID_PATTERN },
    transactionIndex: { type: 'integer', minimum: 0 },
    registration: { anyOf: [publicSchemaRegistrationSchema, { type: 'null' }] },
    credentialEvents: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: { type: 'array', items: publicCredentialEventSchema },
        nextCursor: { type: 'string', pattern: '^[0-9]+$' },
      },
    },
  },
} as const
