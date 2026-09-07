<script setup lang="ts">
import {
  createHttpsPayloadUri,
  createIpfsPayloadUri,
  encodeCredentialPayload,
} from '@xcs-protocol/core'
import { buildCredentialCreate } from '@xcs-protocol/sdk'
import type { CredentialCreate } from 'xrpl'
import type { WalletSubmissionResult } from '~/composables/useWallet'
import { LocalPayloadPiiFieldError, type LocalPayloadPublication } from '~/utils/localPayloadStore'
import {
  claimsObjectToGuidedClaims,
  guidedClaimsToJson,
  guidedClaimsToPartialObject,
  resolvedSchemaToGuidedClaims,
  type GuidedClaimField,
} from '~/utils/claimAuthoring'
import { buildCredentialAcceptLink, buildCredentialPermalink } from '~/utils/operationLinks'
import {
  verifyHttpsPayloadPublication,
  type PayloadPublicationProof,
} from '~/utils/payloadPublication'
import { parseWalletCredentialTransactionError } from '~/utils/walletCompatibility'
import { parseJson } from '~/utils/serialization'

const route = useRoute()
const { t } = useI18n()
const { account, busy, prepare, signAndSubmit } = useWallet()
const { getActiveNetworkProfile, getSchema } = useXcsApi()
const localPayloadStore = useLocalPayloadStore()
const localPayloadStoreEnabled = localPayloadStore.enabled

const schemaUid = ref(typeof route.query.schema === 'string' ? route.query.schema : '')
const subject = ref('')
const claimsEditorMode = ref<'guided' | 'json'>('guided')
const guidedClaims = ref<GuidedClaimField[]>([])
const guidedClaimsError = ref('')
const loadedSchemaUid = ref('')
const loadedSchemaName = ref('')
const schemaLoadBusy = ref(false)
const claimsText = ref('{}')
const storageMode = ref<'https' | 'local-test'>('https')
const localStoreAcknowledged = ref(false)
const localStoreNotice = ref('')
const localPublication = shallowRef<LocalPayloadPublication | null>(null)
const httpsUrl = ref('')
const expiration = ref('')
const publicationProof = ref<PayloadPublicationProof | null>(null)
const publicationCheckBusy = ref(false)
const flowBusy = ref(false)
const canonicalPayload = ref('')
const credentialUri = ref('')
const transaction = shallowRef<CredentialCreate | null>(null)
const preparedProfileId = ref('')
const formError = ref('')
const rejectedPiiFieldPath = ref('')
const result = shallowRef<WalletSubmissionResult | null>(null)
const issuedLinkInputs = shallowRef<{
  profileId: string
  issuer: string
  subject: string
  schemaUid: string
} | null>(null)
const submissionBusy = computed(() => busy.value || flowBusy.value)
let previewRevision = 0

const formErrorMessage = computed(() => {
  const walletTransactionError = parseWalletCredentialTransactionError(formError.value)
  if (walletTransactionError) {
    return t('wallet.errors.credentialUnsupported', {
      wallet: walletTransactionError.walletName,
      transactionType: walletTransactionError.transactionType,
    })
  }
  if (formError.value === 'PAYLOAD_HTTPS_URL_REQUIRED') {
    return t('issue.errors.httpsUrlRequired')
  }
  if (formError.value === 'PAYLOAD_HTTPS_URL_PLACEHOLDER') {
    return t('issue.errors.httpsUrlPlaceholder')
  }
  if (formError.value === 'PAYLOAD_FETCH_FAILED') {
    return t('issue.errors.payloadFetchFailed')
  }
  if (formError.value === 'LOCAL_PAYLOAD_STORE_ACK_REQUIRED') {
    return t('issue.localStore.errors.ackRequired')
  }
  if (formError.value === 'LOCAL_PAYLOAD_PII_FIELD_REJECTED') {
    return t('issue.localStore.errors.pii', { field: rejectedPiiFieldPath.value })
  }
  if (formError.value === 'LOCAL_PAYLOAD_STORE_QUOTA_EXCEEDED') {
    return t('issue.localStore.errors.quota')
  }
  if (formError.value === 'LOCAL_PAYLOAD_SIZE_INVALID') {
    return t('issue.localStore.errors.size')
  }
  if (
    formError.value === 'LOCAL_PAYLOAD_STORE_DISABLED' ||
    formError.value === 'LOCAL_PAYLOAD_STORE_UNAVAILABLE' ||
    formError.value === 'LOCAL_PAYLOAD_STORE_WRITE_FAILED'
  ) {
    return t('issue.localStore.errors.unavailable')
  }
  if (
    formError.value === 'LOCAL_PAYLOAD_STORE_RECORD_INVALID' ||
    formError.value === 'LOCAL_PAYLOAD_DIGEST_MISMATCH' ||
    formError.value === 'LOCAL_PAYLOAD_BYTES_MISMATCH' ||
    formError.value === 'PUBLISHED_PAYLOAD_BYTES_MISMATCH'
  ) {
    return t('issue.localStore.errors.integrity')
  }
  if (
    formError.value === 'LOCAL_PAYLOAD_NOT_FOUND' ||
    formError.value === 'LOCAL_PAYLOAD_EXPIRED'
  ) {
    return t('issue.localStore.errors.missing')
  }
  return formError.value
})

const formErrorIsLocalized = computed(
  () => formError.value.length > 0 && formErrorMessage.value !== formError.value,
)

function assertPayloadHttpsUrlIsConfigured(value: string): void {
  if (value.length === 0) throw new Error('PAYLOAD_HTTPS_URL_REQUIRED')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('PAYLOAD_HTTPS_URL_REQUIRED')
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (hostname === 'example' || hostname.endsWith('.example')) {
    throw new Error('PAYLOAD_HTTPS_URL_PLACEHOLDER')
  }
}

function invalidatePreview() {
  previewRevision += 1
  publicationProof.value = null
  localPublication.value = null
  localStoreNotice.value = ''
  canonicalPayload.value = ''
  credentialUri.value = ''
  transaction.value = null
  preparedProfileId.value = ''
  result.value = null
  issuedLinkInputs.value = null
}

watch([schemaUid, subject, claimsText, httpsUrl, expiration], invalidatePreview)
watch(claimsEditorMode, invalidatePreview)
watch([storageMode, localStoreAcknowledged], invalidatePreview)
watch(
  [() => account.value?.address ?? '', () => account.value?.network.id ?? ''],
  invalidatePreview,
)
watch(schemaUid, (value) => {
  if (value.toLowerCase() === loadedSchemaUid.value) return
  guidedClaims.value = []
  guidedClaimsError.value = ''
  loadedSchemaUid.value = ''
  loadedSchemaName.value = ''
})
watch(
  guidedClaims,
  (fields) => {
    if (claimsEditorMode.value !== 'guided') return
    invalidatePreview()
    try {
      claimsText.value = JSON.stringify(guidedClaimsToPartialObject(fields), null, 2)
      guidedClaimsToJson(fields)
      guidedClaimsError.value = ''
    } catch (error) {
      guidedClaimsError.value = error instanceof Error ? error.message : String(error)
    }
  },
  { deep: true },
)

async function loadGuidedClaimForm() {
  const requestedUid = schemaUid.value.toLowerCase()
  formError.value = ''
  if (!/^[0-9a-f]{64}$/.test(requestedUid)) {
    formError.value = 'SCHEMA_UID_INVALID'
    return
  }
  schemaLoadBusy.value = true
  try {
    const profile = await getActiveNetworkProfile()
    const schema = await getSchema(requestedUid, profile.profileId)
    if (schemaUid.value.toLowerCase() !== requestedUid) {
      throw new Error('SCHEMA_CHANGED_DURING_LOAD')
    }
    guidedClaims.value = claimsObjectToGuidedClaims(
      resolvedSchemaToGuidedClaims(schema.resolved),
      parseJson(claimsText.value),
    )
    loadedSchemaUid.value = requestedUid
    loadedSchemaName.value = schema.name
    invalidatePreview()
    claimsEditorMode.value = 'guided'
    guidedClaimsError.value = ''
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  } finally {
    schemaLoadBusy.value = false
  }
}

function selectClaimsEditorMode(mode: 'guided' | 'json') {
  if (mode === claimsEditorMode.value) return
  formError.value = ''
  if (mode === 'json') {
    claimsText.value = JSON.stringify(guidedClaimsToPartialObject(guidedClaims.value), null, 2)
    claimsEditorMode.value = mode
    return
  }
  if (loadedSchemaUid.value !== schemaUid.value.toLowerCase() || guidedClaims.value.length === 0) {
    formError.value = 'GUIDED_CLAIMS_SCHEMA_REQUIRED'
    return
  }
  let convertedClaims: GuidedClaimField[]
  try {
    convertedClaims = claimsObjectToGuidedClaims(guidedClaims.value, parseJson(claimsText.value))
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
    return
  }
  invalidatePreview()
  guidedClaims.value = convertedClaims
  claimsEditorMode.value = mode
}

function downloadPayload() {
  const blob = new Blob([canonicalPayload.value], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'xcs-credential.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function clearLocalPayloadStore() {
  formError.value = ''
  try {
    const removed = localPayloadStore.clear()
    invalidatePreview()
    localStoreNotice.value = t('issue.localStore.cleared', { count: removed })
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  }
}

async function buildPreview() {
  invalidatePreview()
  formError.value = ''
  rejectedPiiFieldPath.value = ''
  result.value = null
  if (!account.value) return void (formError.value = 'WALLET_NOT_CONNECTED')
  const revision = previewRevision
  const issuerAddress = account.value.address
  const normalizedSchemaUid = schemaUid.value.toLowerCase()
  const subjectAddress = subject.value
  let claimsInput = claimsText.value
  const payloadUrl = httpsUrl.value
  const expirationInput = expiration.value
  const selectedStorageMode = storageMode.value
  const localStoreConsent = localStoreAcknowledged.value
  try {
    if (claimsEditorMode.value === 'guided') {
      if (loadedSchemaUid.value !== normalizedSchemaUid) {
        throw new Error('GUIDED_CLAIMS_SCHEMA_REQUIRED')
      }
      claimsInput = guidedClaimsToJson(guidedClaims.value)
      claimsText.value = claimsInput
    }
    if (selectedStorageMode === 'https') {
      assertPayloadHttpsUrlIsConfigured(payloadUrl)
    } else {
      if (!localPayloadStore.enabled.value) throw new Error('LOCAL_PAYLOAD_STORE_DISABLED')
      if (!localStoreConsent) throw new Error('LOCAL_PAYLOAD_STORE_ACK_REQUIRED')
    }
    const profile = await getActiveNetworkProfile()
    const schema = await getSchema(normalizedSchemaUid, profile.profileId)
    if (revision !== previewRevision) throw new Error('ISSUANCE_PREVIEW_CHANGED_DURING_BUILD')
    const claims = parseJson(claimsInput)
    const canonical = encodeCredentialPayload(claims, {
      issuer: issuerAddress,
      subject: subjectAddress,
      schemaUid: normalizedSchemaUid,
      fields: schema.resolved.fields,
    }).json
    canonicalPayload.value = canonical
    credentialUri.value =
      selectedStorageMode === 'local-test'
        ? createIpfsPayloadUri(canonical)
        : createHttpsPayloadUri(payloadUrl, canonical)
    const raw = buildCredentialCreate({
      issuer: issuerAddress,
      subject: subjectAddress,
      schemaUid: normalizedSchemaUid,
      uri: credentialUri.value,
      ...(expirationInput ? { expiration: new Date(expirationInput).toISOString() } : {}),
    })
    const prepared = (await prepare(raw, profile)) as CredentialCreate
    if (revision !== previewRevision) throw new Error('ISSUANCE_PREVIEW_CHANGED_DURING_BUILD')
    if (selectedStorageMode === 'local-test') {
      const stored = localPayloadStore.publish(canonical, {
        nonPersonalTestDataAcknowledged: localStoreConsent,
      })
      if (stored.credentialUri !== credentialUri.value) {
        throw new Error('LOCAL_PAYLOAD_DIGEST_MISMATCH')
      }
      localPublication.value = stored
    }
    transaction.value = prepared
    preparedProfileId.value = profile.profileId
  } catch (error) {
    transaction.value = null
    if (error instanceof LocalPayloadPiiFieldError) {
      rejectedPiiFieldPath.value = error.fieldPath
    }
    formError.value = error instanceof Error ? error.message : String(error)
  }
}

async function submit() {
  const preparedTransaction = transaction.value
  const expectedPayload = canonicalPayload.value
  const expectedUri = credentialUri.value
  const expectedIssuer = account.value?.address
  const expectedSubject = subject.value
  const expectedSchemaUid = schemaUid.value.toLowerCase()
  const expectedClaims = claimsText.value
  const expectedClaimsEditorMode = claimsEditorMode.value
  const expectedGuidedClaims = JSON.stringify(guidedClaims.value)
  const expectedHttpsUrl = httpsUrl.value
  const expectedStorageMode = storageMode.value
  const expectedLocalStoreAcknowledged = localStoreAcknowledged.value
  const expectedLocalPublication = localPublication.value
  const expectedExpiration = expiration.value
  const expectedProfileId = preparedProfileId.value
  const expectedRevision = previewRevision
  if (
    !preparedTransaction ||
    !expectedPayload ||
    !expectedUri ||
    !expectedIssuer ||
    !expectedProfileId
  ) {
    formError.value = 'TRANSACTION_PREVIEW_REQUIRED'
    return
  }

  flowBusy.value = true
  publicationCheckBusy.value = true
  publicationProof.value = null
  formError.value = ''
  try {
    const assertCurrent = () => {
      if (
        previewRevision !== expectedRevision ||
        transaction.value !== preparedTransaction ||
        canonicalPayload.value !== expectedPayload ||
        credentialUri.value !== expectedUri ||
        account.value?.address !== expectedIssuer ||
        subject.value !== expectedSubject ||
        schemaUid.value.toLowerCase() !== expectedSchemaUid ||
        claimsText.value !== expectedClaims ||
        claimsEditorMode.value !== expectedClaimsEditorMode ||
        JSON.stringify(guidedClaims.value) !== expectedGuidedClaims ||
        httpsUrl.value !== expectedHttpsUrl ||
        storageMode.value !== expectedStorageMode ||
        localStoreAcknowledged.value !== expectedLocalStoreAcknowledged ||
        localPublication.value !== expectedLocalPublication ||
        expiration.value !== expectedExpiration ||
        preparedProfileId.value !== expectedProfileId
      ) {
        throw new Error('ISSUANCE_PREVIEW_CHANGED_DURING_PUBLICATION_CHECK')
      }
    }
    const proof =
      expectedStorageMode === 'local-test'
        ? await localPayloadStore.verifyPublication({
            canonicalPayload: expectedPayload,
            credentialUri: expectedUri,
          })
        : await verifyHttpsPayloadPublication({
            canonicalPayload: expectedPayload,
            credentialUri: expectedUri,
          })
    assertCurrent()
    publicationProof.value = proof
    publicationCheckBusy.value = false
    const normalizedExpiration = expectedExpiration
      ? new Date(expectedExpiration).toISOString()
      : undefined
    const response = await signAndSubmit(
      preparedTransaction,
      {
        action: 'credential-issue',
        issuer: expectedIssuer,
        subject: expectedSubject,
        schemaUid: expectedSchemaUid,
        credentialUri: expectedUri,
        payloadDigestHex: proof.digestHex,
        ...(normalizedExpiration ? { expiration: normalizedExpiration } : {}),
      },
      assertCurrent,
      undefined,
      (validated) => {
        issuedLinkInputs.value = {
          profileId: expectedProfileId,
          issuer: expectedIssuer,
          subject: expectedSubject,
          schemaUid: expectedSchemaUid,
        }
        result.value = { ...validated }
      },
    )
    result.value = response
    transaction.value = null
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  } finally {
    publicationCheckBusy.value = false
    flowBusy.value = false
  }
}

const acceptLink = computed(() => {
  const generationId = result.value?.businessEvidence?.generationId
  if (
    result.value?.businessConfirmation !== 'confirmed' ||
    !generationId ||
    !issuedLinkInputs.value
  ) {
    return null
  }
  return buildCredentialAcceptLink({ ...issuedLinkInputs.value, generationId })
})

const credentialLink = computed(() => {
  const generationId = result.value?.businessEvidence?.generationId
  if (
    result.value?.businessConfirmation !== 'confirmed' ||
    !generationId ||
    !issuedLinkInputs.value
  ) {
    return null
  }
  return buildCredentialPermalink({
    profileId: issuedLinkInputs.value.profileId,
    generationId,
  })
})
</script>

<template>
  <section class="section-wrap form-page">
    <p class="eyebrow">Credential issuer</p>
    <h1>{{ $t('issue.title') }}</h1>
    <p class="lead">{{ $t('issue.description') }}</p>
    <div class="warning-box">{{ $t('issue.noPii') }}</div>

    <div class="form-card form-grid">
      <label for="schema-uid">Schema UID</label>
      <input
        id="schema-uid"
        v-model.trim="schemaUid"
        required
        pattern="[0-9a-fA-F]{64}"
        :disabled="submissionBusy"
      />
      <label for="subject">Subject</label>
      <input
        id="subject"
        v-model.trim="subject"
        required
        placeholder="r…"
        :disabled="submissionBusy"
      />
      <div class="claims-toolbar">
        <button
          class="button compact"
          :class="{ secondary: claimsEditorMode !== 'guided' }"
          type="button"
          :aria-pressed="claimsEditorMode === 'guided'"
          :disabled="submissionBusy"
          @click="selectClaimsEditorMode('guided')"
        >
          {{ $t('issue.guidedClaims') }}
        </button>
        <button
          class="button compact"
          :class="{ secondary: claimsEditorMode !== 'json' }"
          type="button"
          :aria-pressed="claimsEditorMode === 'json'"
          :disabled="submissionBusy"
          @click="selectClaimsEditorMode('json')"
        >
          {{ $t('issue.jsonClaims') }}
        </button>
        <button
          class="button secondary compact"
          type="button"
          :disabled="submissionBusy || schemaLoadBusy"
          @click="loadGuidedClaimForm"
        >
          {{ $t('issue.loadSchema') }}
        </button>
      </div>

      <template v-if="claimsEditorMode === 'guided'">
        <p v-if="loadedSchemaName" class="form-hint">
          {{ $t('issue.loadedSchema', { name: loadedSchemaName }) }}
        </p>
        <div v-if="guidedClaims.length" class="guided-claims">
          <label v-for="field in guidedClaims" :key="field.name" :for="`claim-${field.name}`">
            <span>
              {{ field.name }}
              <small>
                · {{ field.type }} ·
                {{ $t(field.optional ? 'issue.optionalField' : 'issue.requiredField') }}
              </small>
            </span>
            <select
              v-if="field.type === 'bool'"
              :id="`claim-${field.name}`"
              v-model="field.value"
              :required="!field.optional"
              :disabled="submissionBusy"
            >
              <option :value="undefined">—</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
            <input
              v-else
              :id="`claim-${field.name}`"
              v-model="field.value"
              :required="!field.optional"
              :inputmode="field.type === 'uint' || field.type === 'int' ? 'numeric' : 'text'"
              :disabled="submissionBusy"
              autocomplete="off"
            />
          </label>
        </div>
        <p v-else class="form-hint">{{ $t('issue.advancedClaimsHint') }}</p>
        <div v-if="guidedClaimsError && guidedClaims.length" class="error-box">
          {{ guidedClaimsError }}
        </div>
      </template>
      <template v-else>
        <label for="claims">Claims JSON</label>
        <textarea
          id="claims"
          v-model="claimsText"
          rows="12"
          spellcheck="false"
          :disabled="submissionBusy"
        />
      </template>
      <template v-if="localPayloadStoreEnabled">
        <label for="payload-storage-mode">{{ $t('issue.storage') }}</label>
        <select id="payload-storage-mode" v-model="storageMode" :disabled="submissionBusy">
          <option value="https">{{ $t('issue.localStore.httpsMode') }}</option>
          <option value="local-test">{{ $t('issue.localStore.mode') }}</option>
        </select>
        <div
          v-if="storageMode === 'local-test'"
          class="warning-box local-store-controls"
          data-testid="local-payload-store-controls"
        >
          <strong>{{ $t('issue.localStore.title') }}</strong>
          <p>{{ $t('issue.localStore.warning') }}</p>
          <label>
            <input v-model="localStoreAcknowledged" type="checkbox" :disabled="submissionBusy" />
            {{ $t('issue.localStore.acknowledgement') }}
          </label>
          <button
            class="button secondary compact"
            type="button"
            :disabled="submissionBusy"
            @click="clearLocalPayloadStore"
          >
            {{ $t('issue.localStore.clear') }}
          </button>
          <p v-if="localStoreNotice" class="form-hint" data-testid="local-store-notice">
            {{ localStoreNotice }}
          </p>
        </div>
      </template>
      <template v-if="storageMode === 'https'">
        <label for="https-url">{{ $t('issue.httpsUrlLabel') }}</label>
        <input
          id="https-url"
          v-model.trim="httpsUrl"
          type="url"
          required
          autocomplete="off"
          :placeholder="$t('issue.httpsUrlPlaceholder')"
          :disabled="submissionBusy"
        />
        <p class="form-hint">{{ $t('issue.httpsProof') }}</p>
      </template>
      <p v-else class="form-hint">{{ $t('issue.localStore.flow') }}</p>
      <label for="expiration">{{ $t('issue.expiration') }}</label>
      <input
        id="expiration"
        v-model="expiration"
        type="datetime-local"
        :disabled="submissionBusy"
      />
      <button class="button" type="button" :disabled="submissionBusy" @click="buildPreview">
        {{ $t('issue.prepare') }}
      </button>
    </div>

    <div v-if="formError" class="error-box" role="alert" data-testid="issue-error">
      <strong>{{ formErrorMessage }}</strong>
      <p v-if="formErrorIsLocalized">
        <code>{{ formError }}</code>
      </p>
    </div>
    <div v-if="canonicalPayload" class="form-card">
      <h2>{{ $t('issue.payload') }}</h2>
      <pre>{{ canonicalPayload }}</pre>
      <p>
        <code>{{ credentialUri }}</code>
      </p>
      <button class="button secondary" type="button" @click="downloadPayload">
        {{ $t('issue.download') }}
      </button>
      <p v-if="storageMode === 'https'" class="form-hint">
        {{ $t('issue.publishBeforeSigning', { url: httpsUrl }) }}
      </p>
      <div v-else-if="localPublication" class="success-box" data-testid="local-payload-stored">
        {{ $t('issue.localStore.stored', { expiresAt: localPublication.expiresAt }) }}
      </div>
      <div v-if="publicationCheckBusy" class="notice-box">{{ $t('issue.checking') }}</div>
      <div v-else-if="publicationProof" class="success-box">
        {{
          $t(storageMode === 'local-test' ? 'issue.localStore.checked' : 'issue.checked', {
            bytes: publicationProof.byteLength,
          })
        }}
        <code>{{ publicationProof.digestHex }}</code>
      </div>
    </div>
    <TransactionPreview :transaction="transaction" :busy="submissionBusy" @confirm="submit" />
    <BusinessFinality
      v-if="result"
      :tx-hash="result.txHash"
      :engine-result="result.transactionResult"
      :ledger-index="result.ledgerIndex"
      :business-confirmation="result.businessConfirmation"
      :business-evidence="result.businessEvidence"
    />
    <div v-if="acceptLink && credentialLink" class="form-card">
      <h2>{{ $t('issue.links') }}</h2>
      <p>
        <NuxtLinkLocale data-testid="issue-credential-link" :to="credentialLink">
          {{ $t('issue.credentialLink') }}
        </NuxtLinkLocale>
      </p>
      <p>
        <NuxtLinkLocale :to="acceptLink">{{ $t('issue.acceptLink') }}</NuxtLinkLocale>
      </p>
    </div>
  </section>
</template>

<style scoped>
.claims-toolbar {
  display: flex;
  gap: 0.65rem;
  flex-wrap: wrap;
}

.guided-claims {
  display: grid;
  gap: 0.85rem;
}

.guided-claims label {
  display: grid;
  gap: 0.35rem;
}

.guided-claims small {
  color: var(--muted);
  font-weight: 500;
}

.local-store-controls {
  display: grid;
  gap: 0.75rem;
}

.local-store-controls label {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
}
</style>
