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
  <section class="section-wrap form-page">
    <p class="eyebrow">Schema publisher</p>
    <h1>{{ $t('register.title') }}</h1>
    <p class="lead">{{ $t('register.description') }}</p>

    <div class="form-card">
      <div class="editor-tabs" role="group" :aria-label="$t('register.schema')">
        <button
          class="button compact"
          :class="{ secondary: editorMode !== 'guided' }"
          type="button"
          :aria-pressed="editorMode === 'guided'"
          :disabled="pageBusy"
          @click="selectEditorMode('guided')"
        >
          {{ $t('register.guidedMode') }}
        </button>
        <button
          class="button compact"
          :class="{ secondary: editorMode !== 'json' }"
          type="button"
          :aria-pressed="editorMode === 'json'"
          :disabled="pageBusy"
          @click="selectEditorMode('json')"
        >
          {{ $t('register.jsonMode') }}
        </button>
      </div>

      <template v-if="editorMode === 'guided'">
        <div class="template-row">
          <button
            class="text-button"
            type="button"
            :disabled="pageBusy"
            @click="applyTemplate(createCourseCompletionDraft)"
          >
            {{ $t('register.courseTemplate') }}
          </button>
          <button
            class="text-button"
            type="button"
            :disabled="pageBusy"
            @click="applyTemplate(createDiplomaDraft)"
          >
            {{ $t('register.diplomaTemplate') }}
          </button>
        </div>

        <label for="schema-name">{{ $t('register.schemaName') }}</label>
        <input id="schema-name" v-model="guidedDraft.name" :disabled="pageBusy" />
        <label for="schema-description">{{ $t('register.schemaDescription') }}</label>
        <textarea
          id="schema-description"
          v-model="guidedDraft.description"
          rows="3"
          :disabled="pageBusy"
        />

        <fieldset class="guided-fields">
          <legend>{{ $t('register.fields') }}</legend>
          <div v-for="(field, index) in guidedDraft.fields" :key="index" class="guided-field-row">
            <label>
              <span>{{ $t('register.fieldName') }}</span>
              <input v-model="field.name" :disabled="pageBusy" autocomplete="off" />
            </label>
            <label>
              <span>{{ $t('register.fieldType') }}</span>
              <select v-model="field.type" :disabled="pageBusy">
                <option v-for="type in GUIDED_SCHEMA_FIELD_TYPES" :key="type" :value="type">
                  {{ type }}
                </option>
              </select>
            </label>
            <label class="optional-field">
              <input v-model="field.optional" type="checkbox" :disabled="pageBusy" />
              {{ $t('register.optional') }}
            </label>
            <button
              class="text-button"
              type="button"
              :disabled="pageBusy"
              @click="removeField(index)"
            >
              {{ $t('register.removeField') }}
            </button>
          </div>
          <button
            class="button secondary compact"
            type="button"
            :disabled="pageBusy"
            @click="addField"
          >
            {{ $t('register.addField') }}
          </button>
        </fieldset>
        <p class="muted">{{ $t('register.advancedHint') }}</p>
        <div v-if="guidedError" class="error-box">{{ guidedError }}</div>
      </template>

      <template v-else>
        <label for="schema-json">{{ $t('register.schema') }}</label>
        <textarea
          id="schema-json"
          v-model="schemaText"
          rows="18"
          spellcheck="false"
          :disabled="pageBusy"
        />
      </template>
      <div class="warning-box">{{ $t('register.irreversible') }}</div>
      <button class="button" type="button" :disabled="pageBusy" @click="buildPreview">
        {{ $t('register.prepare') }}
      </button>
    </div>

    <div v-if="formError" class="error-box">{{ formError }}</div>
    <div v-if="canonicalSchema" class="form-card">
      <h2>{{ $t('register.canonical') }}</h2>
      <pre>{{ canonicalSchema }}</pre>
      <p class="muted">
        {{ memoByteLength }} bytes · <code>{{ schemaDigestHex }}</code>
      </p>
    </div>
    <TransactionPreview :transaction="transaction" :busy="pageBusy" @confirm="submit" />
    <BusinessFinality
      v-if="result"
      :tx-hash="result.txHash"
      :engine-result="result.transactionResult"
      :ledger-index="result.ledgerIndex"
      :business-confirmation="result.businessConfirmation"
      :business-evidence="result.businessEvidence"
    />
    <div
      v-if="result?.businessConfirmation === 'confirmed' && result.businessEvidence?.schemaUid"
      class="success-box"
    >
      <NuxtLinkLocale :to="`/schemas/${result.businessEvidence.schemaUid}`">
        {{ $t('register.openSchema') }}
      </NuxtLinkLocale>
    </div>
  </section>
</template>

<style scoped>
.editor-tabs,
.template-row {
  display: flex;
  gap: 0.65rem;
  flex-wrap: wrap;
}

.template-row {
  margin: 1.25rem 0;
}

.guided-fields {
  margin: 1.25rem 0;
  border: 1px solid var(--line);
  border-radius: 0.8rem;
  padding: 1rem;
}

.guided-field-row {
  display: grid;
  grid-template-columns: minmax(12rem, 1.5fr) minmax(8rem, 1fr) auto auto;
  align-items: end;
  gap: 0.75rem;
  padding: 0.8rem 0;
  border-bottom: 1px solid var(--line);
}

.guided-field-row:last-of-type {
  margin-bottom: 1rem;
}

.guided-field-row label:not(.optional-field) {
  display: grid;
  gap: 0.35rem;
}

.optional-field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding-bottom: 0.65rem;
}

@media (max-width: 760px) {
  .guided-field-row {
    grid-template-columns: 1fr;
    align-items: start;
  }

  .optional-field {
    padding-bottom: 0;
  }
}
</style>
