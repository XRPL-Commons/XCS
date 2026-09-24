<script setup lang="ts">
import { encodeUtf8, parseJson, sha256Hex, utf8ByteLength, XcsError } from '#xcs/core/index.js'
import { buildSchemaRegistrationPayment } from '#xcs/sdk/index.js'
import type { Payment } from 'xrpl'
import type { WalletSubmissionResult } from '~/composables/useWallet'
import { walletTransactionErrorMessage } from '~/utils/walletCompatibility'
import {
  GUIDED_SCHEMA_FIELD_TYPES,
  createCourseCompletionDraft,
  createDiplomaDraft,
  createEmptyGuidedField,
  guidedSchemaToJson,
  schemaDefinitionToGuidedDraft,
  type GuidedSchemaDraft,
} from '~/utils/schemaAuthoring'

import type { IssuerSchemaEngineContext } from '~/utils/issuerEngine'

const props = defineProps<{ issuerContext?: IssuerSchemaEngineContext }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const recovery = useIssuerEngineRecovery(() => props.issuerContext)
const { account, busy, prepare, signAndSubmit } = useWallet()
const { t } = useI18n()
const route = useRoute()
const { getActiveNetworkProfile } = useXcsApi()
const editorMode = ref<'guided' | 'json'>('guided')
const guidedDraft = ref<GuidedSchemaDraft>(createCourseCompletionDraft())
const guidedError = ref('')
const schemaText = ref(guidedSchemaToJson(guidedDraft.value))
const transaction = shallowRef<Payment | null>(null)
const canonicalSchema = ref('')
const schemaDigestHex = ref('')
const memoByteLength = ref<number | null>(null)
const formError = ref('')
const result = shallowRef<WalletSubmissionResult | null>(null)
const submitting = ref(false)
const pageBusy = computed(() => busy.value || submitting.value || recovery.saving.value)
watch(pageBusy, (value) => emit('busy', value), { immediate: true })
const nameBytes = computed(() => utf8ByteLength(guidedDraft.value.name))
const descriptionBytes = computed(() => utf8ByteLength(guidedDraft.value.description))
function readableSchemaError(value: string): string {
  const walletMessage = walletTransactionErrorMessage(value, t)
  if (walletMessage) return walletMessage
  if (value.startsWith('INVALID_SCHEMA ($.description):'))
    return t('simpleIssuer.descriptionInvalid')
  if (value.startsWith('INVALID_SCHEMA ($.name):')) return t('simpleIssuer.nameInvalid')
  if (value.startsWith('INVALID_SCHEMA ($.fields') || value === 'SCHEMA_FIELD_DUPLICATE')
    return t('simpleIssuer.fieldsInvalid')
  if (value.startsWith('INVALID_SCHEMA') || value.startsWith('INVALID_JSON'))
    return t('simpleIssuer.modelInvalid')
  return t('simpleIssuer.error')
}
const formErrorMessage = computed(() => readableSchemaError(formError.value))
const modelSummary = computed(() => {
  if (!canonicalSchema.value) return null
  return parseJson(canonicalSchema.value) as {
    name: string
    description: string
    fields: Record<string, { type: string; optional?: boolean }>
  }
})
let previewRevision = 0

function schemaErrorMessage(error: unknown): string {
  if (error instanceof XcsError)
    return `${error.code}${error.path ? ` (${error.path})` : ''}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

watch(recovery.pending, (current, previous) => {
  if (previous && !current && !recovery.saved.value) invalidatePreview()
})

function invalidatePreview() {
  previewRevision += 1
  transaction.value = null
  canonicalSchema.value = ''
  schemaDigestHex.value = ''
  memoByteLength.value = null
  result.value = null
}

watch(schemaText, invalidatePreview)
watch(
  [() => account.value?.address ?? '', () => account.value?.network.id ?? ''],
  invalidatePreview,
)
watch(
  guidedDraft,
  (draft) => {
    if (editorMode.value !== 'guided') return
    invalidatePreview()
    formError.value = ''
    try {
      schemaText.value = guidedSchemaToJson(draft)
      guidedError.value = ''
    } catch (error) {
      guidedError.value = schemaErrorMessage(error)
    }
  },
  { deep: true },
)

function applyTemplate(factory: () => GuidedSchemaDraft) {
  editorMode.value = 'guided'
  guidedDraft.value = factory()
  formError.value = ''
}

function addField() {
  guidedDraft.value.fields.push(createEmptyGuidedField())
}

function removeField(index: number) {
  if (guidedDraft.value.fields.length === 1) {
    guidedDraft.value.fields[0] = createEmptyGuidedField()
    return
  }
  guidedDraft.value.fields.splice(index, 1)
}

function selectEditorMode(mode: 'guided' | 'json') {
  if (mode === editorMode.value) return
  formError.value = ''
  if (mode === 'json') {
    if (guidedError.value) {
      formError.value = guidedError.value
      return
    }
    editorMode.value = mode
    return
  }

  try {
    guidedDraft.value = schemaDefinitionToGuidedDraft(parseJson(schemaText.value))
    editorMode.value = mode
    guidedError.value = ''
  } catch (error) {
    formError.value = schemaErrorMessage(error)
  }
}

async function buildPreview() {
  if (props.issuerContext && (recovery.pending.value || recovery.saved.value)) return
  invalidatePreview()
  formError.value = ''
  result.value = null
  if (editorMode.value === 'guided' && guidedError.value) {
    formError.value = guidedError.value
    return
  }
  if (!account.value) {
    formError.value = 'WALLET_NOT_CONNECTED'
    return
  }
  const revision = previewRevision
  const publisher = account.value.address
  const schemaInput = schemaText.value
  try {
    const profile = await getActiveNetworkProfile()
    if (props.issuerContext) {
      if (profile.profileId !== props.issuerContext.profileId)
        throw new Error('ISSUER_PROFILE_MISMATCH')
      await props.issuerContext.beforeSign(publisher)
    }
    const built = buildSchemaRegistrationPayment({
      publisher,
      profile,
      schema: parseJson(schemaInput),
    })
    const prepared = (await prepare(built.transaction, profile)) as Payment
    if (revision !== previewRevision) throw new Error('SCHEMA_PREVIEW_CHANGED_DURING_BUILD')
    canonicalSchema.value = built.canonicalSchema
    schemaDigestHex.value = sha256Hex(encodeUtf8(built.canonicalSchema))
    memoByteLength.value = built.memoByteLength
    transaction.value = prepared
  } catch (error) {
    formError.value = schemaErrorMessage(error)
    transaction.value = null
  }
}

async function submit() {
  const preparedTransaction = transaction.value
  const expectedPublisher = account.value?.address
  const expectedSchema = schemaText.value
  const expectedCanonical = canonicalSchema.value
  const expectedDigest = schemaDigestHex.value
  const expectedMemoByteLength = memoByteLength.value
  const expectedRevision = previewRevision
  if (
    !preparedTransaction ||
    !expectedPublisher ||
    !expectedCanonical ||
    !expectedDigest ||
    expectedMemoByteLength === null
  ) {
    formError.value = 'TRANSACTION_PREVIEW_REQUIRED'
    return
  }
  submitting.value = true
  try {
    const assertCurrent = () => {
      if (
        previewRevision !== expectedRevision ||
        transaction.value !== preparedTransaction ||
        account.value?.address !== expectedPublisher ||
        schemaText.value !== expectedSchema ||
        canonicalSchema.value !== expectedCanonical ||
        schemaDigestHex.value !== expectedDigest ||
        memoByteLength.value !== expectedMemoByteLength
      ) {
        throw new Error('SCHEMA_PREVIEW_CHANGED_BEFORE_SIGNATURE')
      }
    }
    await props.issuerContext?.beforeSign(expectedPublisher)
    assertCurrent()
    const response = await signAndSubmit(
      preparedTransaction,
      {
        action: 'schema-register',
        publisher: expectedPublisher,
        schemaDigestHex: expectedDigest,
        memoByteLength: expectedMemoByteLength,
      },
      assertCurrent,
      async (signature) => {
        if (!props.issuerContext) return
        await props.issuerContext.beforeSign(expectedPublisher)
        assertCurrent()
        recovery.stash({ transactionHash: signature.txHash })
      },
      (validated) => {
        result.value = { ...validated }
        transaction.value = null
      },
    )
    result.value = response
    transaction.value = null
    await recovery.finish(response)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  } finally {
    submitting.value = false
    await recovery.checkFailure()
  }
}
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader :title="$t('simpleIssuer.modelTitle')" :lead="$t('simpleIssuer.modelLead')" />

    <IssuerEngineRecovery
      v-if="issuerContext"
      :pending="recovery.pending.value"
      :saved="recovery.saved.value"
      :busy="recovery.saving.value"
      :error="recovery.error.value"
      :can-restart="recovery.canRestart.value"
      @restart="recovery.restart"
      @retry="recovery.retry"
    />
    <UCard v-if="!issuerContext || (!recovery.pending.value && !recovery.saved.value)" class="mb-6">
      <div class="grid gap-5">
        <div class="flex flex-wrap gap-3">
          <UButton
            v-if="editorMode === 'json'"
            color="neutral"
            variant="outline"
            :disabled="pageBusy"
            @click="selectEditorMode('guided')"
            >{{ $t('simpleIssuer.guided') }}</UButton
          >
          <details>
            <summary class="cursor-pointer text-sm text-muted">
              {{ $t('simpleIssuer.advanced') }}
            </summary>
            <UButton
              class="mt-2"
              color="neutral"
              variant="outline"
              :disabled="pageBusy"
              @click="selectEditorMode('json')"
              >{{ $t('simpleIssuer.editJson') }}</UButton
            >
            <p class="mt-2 text-sm text-muted">{{ $t('register.advancedHint') }}</p>
          </details>
        </div>

        <template v-if="editorMode === 'guided'">
          <div class="flex flex-wrap gap-3">
            <UButton
              color="neutral"
              variant="link"
              class="px-0"
              type="button"
              :disabled="pageBusy"
              @click="applyTemplate(createCourseCompletionDraft)"
            >
              {{ $t('register.courseTemplate') }}
            </UButton>
            <UButton
              color="neutral"
              variant="link"
              class="px-0"
              type="button"
              :disabled="pageBusy"
              @click="applyTemplate(createDiplomaDraft)"
            >
              {{ $t('register.diplomaTemplate') }}
            </UButton>
          </div>

          <UFormField
            :label="$t('simpleIssuer.modelName')"
            :error="nameBytes === 0 || nameBytes > 64"
          >
            <UInput
              id="schema-name"
              v-model="guidedDraft.name"
              :disabled="pageBusy"
              required
              aria-describedby="schema-name-hint"
            />
            <p id="schema-name-hint" class="text-sm text-muted">
              {{ $t('simpleIssuer.shortName') }}
            </p>
          </UFormField>
          <UFormField
            :label="$t('simpleIssuer.modelDescription')"
            :error="descriptionBytes === 0 || descriptionBytes > 256"
          >
            <UTextarea
              id="schema-description"
              v-model="guidedDraft.description"
              required
              aria-describedby="schema-description-hint"
              :rows="3"
              :disabled="pageBusy"
            />
            <p id="schema-description-hint" class="text-sm text-muted">
              {{ $t('simpleIssuer.shortDescription') }}
            </p>
          </UFormField>

          <fieldset class="grid gap-3 rounded-[0.8rem] p-4 ring-1 ring-default">
            <legend class="px-1 font-semibold">{{ $t('simpleIssuer.fields') }}</legend>
            <div
              v-for="(field, index) in guidedDraft.fields"
              :key="index"
              class="grid gap-3 border-b border-default pb-3 sm:grid-cols-[1fr_10rem_auto_auto] sm:items-end"
            >
              <UFormField
                :label="$t('simpleIssuer.fieldName')"
                :help="$t('simpleIssuer.fieldNameHint')"
              >
                <UInput v-model="field.name" :disabled="pageBusy" autocomplete="off" />
              </UFormField>
              <UFormField :label="$t('simpleIssuer.fieldType')">
                <USelect
                  v-model="field.type"
                  :items="
                    GUIDED_SCHEMA_FIELD_TYPES.map((type) => ({
                      label: $t(`simpleIssuer.fieldTypes.${type}`),
                      value: type,
                    }))
                  "
                  :disabled="pageBusy"
                />
              </UFormField>
              <UCheckbox
                v-model="field.optional"
                class="sm:pb-2"
                :disabled="pageBusy"
                :label="$t('simpleIssuer.optional')"
              />
              <UButton
                color="neutral"
                variant="link"
                class="px-0 sm:pb-2"
                type="button"
                :disabled="pageBusy"
                @click="removeField(index)"
              >
                {{ $t('simpleIssuer.removeField') }}
              </UButton>
            </div>
            <div>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                type="button"
                :disabled="pageBusy"
                @click="addField"
              >
                {{ $t('simpleIssuer.addField') }}
              </UButton>
            </div>
          </fieldset>
          <StatusBox v-if="guidedError" tone="error" role="alert"
            ><p>{{ readableSchemaError(guidedError) }}</p>
            <details>
              <summary>{{ $t('simpleIssuer.technical') }}</summary>
              {{ guidedError }}
            </details></StatusBox
          >
        </template>

        <template v-else>
          <UFormField :label="$t('register.schema')">
            <UTextarea
              id="schema-json"
              v-model="schemaText"
              :rows="18"
              spellcheck="false"
              :disabled="pageBusy"
            />
          </UFormField>
        </template>

        <StatusBox tone="warning">{{ $t('simpleIssuer.publicModel') }}</StatusBox>
        <div>
          <UButton type="button" :disabled="pageBusy" @click="buildPreview">
            {{ $t('simpleIssuer.reviewModel') }}
          </UButton>
        </div>
      </div>
    </UCard>

    <StatusBox v-if="formError" tone="error" role="alert" :title="formErrorMessage">
      <details v-if="formErrorMessage !== formError">
        <summary class="cursor-pointer">{{ $t('simpleIssuer.technical') }}</summary>
        <code>{{ formError }}</code>
      </details>
    </StatusBox>

    <UCard v-if="modelSummary" class="mb-6" data-testid="schema-review">
      <template #header
        ><h2 class="text-xl font-semibold">{{ $t('simpleIssuer.modelReview') }}</h2></template
      >
      <h3 class="font-semibold">{{ modelSummary.name }}</h3>
      <p class="mt-2 text-muted">{{ modelSummary.description }}</p>
      <dl class="mt-4 grid gap-3">
        <div
          v-for="(field, name) in modelSummary.fields"
          :key="name"
          class="flex flex-wrap justify-between gap-2"
        >
          <dt class="font-medium">{{ name }}</dt>
          <dd>
            {{ $t(`simpleIssuer.fieldTypes.${field.type}`)
            }}<span v-if="field.optional"> · {{ $t('simpleIssuer.optional') }}</span>
          </dd>
        </div>
      </dl>
      <details class="mt-5">
        <summary class="cursor-pointer text-sm text-muted">
          {{ $t('simpleIssuer.technical') }}
        </summary>
        <JsonBlock class="mt-3" :code="canonicalSchema" />
        <p class="text-sm break-all text-muted">
          {{ memoByteLength }} bytes · <code>{{ schemaDigestHex }}</code>
        </p>
      </details>
    </UCard>

    <TransactionPreview
      :transaction="transaction"
      :busy="pageBusy"
      compact
      :confirm-label="$t('simpleIssuer.publishModel')"
      @confirm="submit"
    />
    <BusinessFinality
      v-if="result"
      :tx-hash="result.txHash"
      :engine-result="result.transactionResult"
      :ledger-index="result.ledgerIndex"
      :business-confirmation="result.businessConfirmation"
      :business-evidence="result.businessEvidence"
    />
    <StatusBox
      v-if="result?.businessConfirmation === 'confirmed' && result.businessEvidence?.schemaUid"
      tone="success"
    >
      <NuxtLinkLocale
        :to="
          issuerContext
            ? {
                path: '/issuer/schemas',
                query: route.query.organizationId
                  ? { organizationId: route.query.organizationId }
                  : {},
              }
            : `/schemas/${result.businessEvidence.schemaUid}`
        "
      >
        {{ $t(issuerContext ? 'simpleIssuer.openModels' : 'register.openSchema') }}
      </NuxtLinkLocale>
    </StatusBox>
  </UContainer>
</template>
