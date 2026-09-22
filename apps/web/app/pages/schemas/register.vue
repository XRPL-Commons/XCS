<script setup lang="ts">
import { buildSchemaRegistrationPayment } from '@xcs-protocol/sdk'
import type { Payment } from 'xrpl'
import type { WalletSubmissionResult } from '~/composables/useWallet'
import {
  GUIDED_SCHEMA_FIELD_TYPES,
  createCourseCompletionDraft,
  createDiplomaDraft,
  createEmptyGuidedField,
  guidedSchemaToJson,
  schemaDefinitionToGuidedDraft,
  type GuidedSchemaDraft,
} from '~/utils/schemaAuthoring'
import { encodeUtf8, parseJson, sha256Hex } from '~/utils/serialization'

const { account, busy, prepare, signAndSubmit } = useWallet()
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
const pageBusy = computed(() => busy.value || submitting.value)
let previewRevision = 0

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
    try {
      schemaText.value = guidedSchemaToJson(draft)
      guidedError.value = ''
    } catch (error) {
      guidedError.value = error instanceof Error ? error.message : String(error)
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
    formError.value = error instanceof Error ? error.message : String(error)
  }
}

async function buildPreview() {
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
    formError.value = error instanceof Error ? error.message : String(error)
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
    const response = await signAndSubmit(
      preparedTransaction,
      {
        action: 'schema-register',
        publisher: expectedPublisher,
        schemaDigestHex: expectedDigest,
        memoByteLength: expectedMemoByteLength,
      },
      assertCurrent,
      undefined,
      (validated) => {
        result.value = { ...validated }
      },
    )
    result.value = response
    transaction.value = null
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      eyebrow="Schema publisher"
      :title="$t('register.title')"
      :lead="$t('register.description')"
    />

    <UCard class="mb-6">
      <div class="grid gap-5">
        <div class="flex flex-wrap gap-3" role="group" :aria-label="$t('register.schema')">
          <UButton
            size="sm"
            color="neutral"
            :variant="editorMode === 'guided' ? 'solid' : 'outline'"
            type="button"
            :aria-pressed="editorMode === 'guided'"
            :disabled="pageBusy"
            @click="selectEditorMode('guided')"
          >
            {{ $t('register.guidedMode') }}
          </UButton>
          <UButton
            size="sm"
            color="neutral"
            :variant="editorMode === 'json' ? 'solid' : 'outline'"
            type="button"
            :aria-pressed="editorMode === 'json'"
            :disabled="pageBusy"
            @click="selectEditorMode('json')"
          >
            {{ $t('register.jsonMode') }}
          </UButton>
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

          <UFormField :label="$t('register.schemaName')">
            <UInput id="schema-name" v-model="guidedDraft.name" :disabled="pageBusy" />
          </UFormField>
          <UFormField :label="$t('register.schemaDescription')">
            <UTextarea
              id="schema-description"
              v-model="guidedDraft.description"
              :rows="3"
              :disabled="pageBusy"
            />
          </UFormField>

          <fieldset class="grid gap-3 rounded-[0.8rem] p-4 ring-1 ring-default">
            <legend class="px-1 font-semibold">{{ $t('register.fields') }}</legend>
            <div
              v-for="(field, index) in guidedDraft.fields"
              :key="index"
              class="grid gap-3 border-b border-default pb-3 sm:grid-cols-[1fr_10rem_auto_auto] sm:items-end"
            >
              <UFormField :label="$t('register.fieldName')">
                <UInput v-model="field.name" :disabled="pageBusy" autocomplete="off" />
              </UFormField>
              <UFormField :label="$t('register.fieldType')">
                <USelect
                  v-model="field.type"
                  :items="GUIDED_SCHEMA_FIELD_TYPES.map((type) => ({ label: type, value: type }))"
                  :disabled="pageBusy"
                />
              </UFormField>
              <UCheckbox
                v-model="field.optional"
                class="sm:pb-2"
                :disabled="pageBusy"
                :label="$t('register.optional')"
              />
              <UButton
                color="neutral"
                variant="link"
                class="px-0 sm:pb-2"
                type="button"
                :disabled="pageBusy"
                @click="removeField(index)"
              >
                {{ $t('register.removeField') }}
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
                {{ $t('register.addField') }}
              </UButton>
            </div>
          </fieldset>
          <p class="text-sm text-muted">{{ $t('register.advancedHint') }}</p>
          <StatusBox v-if="guidedError" tone="error">{{ guidedError }}</StatusBox>
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

        <StatusBox tone="warning">{{ $t('register.irreversible') }}</StatusBox>
        <div>
          <UButton type="button" :disabled="pageBusy" @click="buildPreview">
            {{ $t('register.prepare') }}
          </UButton>
        </div>
      </div>
    </UCard>

    <StatusBox v-if="formError" tone="error">{{ formError }}</StatusBox>

    <UCard v-if="canonicalSchema" class="mb-6">
      <template #header>
        <h2 class="text-xl font-semibold">{{ $t('register.canonical') }}</h2>
      </template>
      <JsonBlock :code="canonicalSchema" />
      <p class="text-sm break-all text-muted">
        {{ memoByteLength }} bytes · <code>{{ schemaDigestHex }}</code>
      </p>
    </UCard>

    <TransactionPreview :transaction="transaction" :busy="pageBusy" @confirm="submit" />
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
      <NuxtLinkLocale :to="`/schemas/${result.businessEvidence.schemaUid}`">
        {{ $t('register.openSchema') }}
      </NuxtLinkLocale>
    </StatusBox>
  </UContainer>
</template>
