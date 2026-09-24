<script setup lang="ts">
import {
  createHttpsPayloadUri,
  encodeCredentialPayload,
  parseJson,
  payloadDigest,
} from '#xcs/core/index.js'
import { buildCredentialCreate } from '#xcs/sdk/index.js'
import type { CredentialCreate } from 'xrpl'
import type { WalletSubmissionResult } from '~/composables/useWallet'
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
import {
  assertHostedPayloadReachable,
  assertHostedPayloadSize,
  createHostedPayloadLocation,
  type PendingHostedPayload,
} from '~/utils/hostedPayload'
import { createHostedPublicationQueue } from '~/utils/hostedPublicationQueue'
import { IndexedDbOperationJournal } from '~/utils/operationJournal'
import { walletTransactionErrorMessage } from '~/utils/walletCompatibility'

import {
  assertIssuerPayloadReceipt,
  claimPublicPointer,
  issuerVisibilityPreview,
  type IssuerIssueEngineContext,
  type IssuerPayloadReceipt,
} from '~/utils/issuerEngine'

const props = defineProps<{ issuerContext?: IssuerIssueEngineContext }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const recovery = useIssuerEngineRecovery(() => props.issuerContext)
const managedPayload = shallowRef<IssuerPayloadReceipt | null>(null)
const visibility = ref<'private' | 'public'>('private')
const publicFields = ref<string[]>([])
const visibilityReviewed = ref(false)
const claimObject = computed<Record<string, unknown>>(() => {
  try {
    const value = parseJson(claimsText.value)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
})
const visibilityPreview = computed(() =>
  issuerVisibilityPreview(claimObject.value, {
    visibility: visibility.value,
    publicFields: publicFields.value,
  }),
)
const route = useRoute()
const localePath = useLocalePath()
const { t } = useI18n()
const config = useRuntimeConfig()
const { account, busy, prepare, signAndSubmit } = useWallet()
const { getActiveNetworkProfile, getSchema, publishHostedPayload } = useXcsApi()
const hostedPayloadsEnabled = computed(
  () => !props.issuerContext && config.public.payloadBaseUrl.trim().length > 0,
)

const schemaUid = ref(
  props.issuerContext?.schemaUid ??
    (typeof route.query.schema === 'string' ? route.query.schema : ''),
)
const subject = ref(props.issuerContext?.subjectAddress ?? '')
const claimsEditorMode = ref<'guided' | 'json'>('guided')
const guidedClaims = ref<GuidedClaimField[]>([])
const guidedClaimsError = ref('')
const loadedSchemaUid = ref('')
const loadedSchemaName = ref('')
const schemaLoadBusy = ref(false)
const claimsText = ref('{}')
const httpsUrl = ref('')
const publicStoreAcknowledged = ref(false)
const expiration = ref('')
const publicationProof = ref<PayloadPublicationProof | null>(null)
const publicationCheckBusy = ref(false)
const flowBusy = ref(false)
const canonicalPayload = ref('')
const credentialUri = ref('')
const transaction = shallowRef<CredentialCreate | null>(null)
const preparedProfileId = ref('')
const formError = ref('')
const payloadLocator = ref('')
const result = shallowRef<WalletSubmissionResult | null>(null)
const pendingPublication = shallowRef<PendingHostedPayload | null>(null)
const publicationJobId = ref('')
const issuedLinkInputs = shallowRef<{
  profileId: string
  issuer: string
  subject: string
  schemaUid: string
} | null>(null)
const submissionBusy = computed(
  () => busy.value || flowBusy.value || pendingPublication.value !== null || recovery.saving.value,
)
watch(submissionBusy, (value) => emit('busy', value), { immediate: true })
let previewRevision = 0

const formErrorMessage = computed(() => {
  const walletError = walletTransactionErrorMessage(formError.value, t)
  if (walletError) return walletError
  if (formError.value === 'PAYLOAD_FETCH_FAILED') {
    return t('issue.errors.payloadFetchFailed')
  }
  if (formError.value === 'PAYLOAD_HOST_UNREACHABLE_BEFORE_SIGNING') {
    return t('issue.errors.hostedBeforeSigning')
  }
  if (formError.value === 'PAYLOAD_HTTPS_URL_REQUIRED') {
    return t('issue.errors.httpsUrlRequired')
  }
  if (formError.value === 'PAYLOAD_HTTPS_URL_PLACEHOLDER') {
    return t('issue.errors.httpsUrlPlaceholder')
  }
  if (formError.value === 'HOSTED_PAYLOAD_CONSENT_REQUIRED') {
    return t('issue.errors.hostedConsent')
  }
  if (formError.value === 'PAYLOAD_SIZE_INVALID') return t('issue.errors.hostedSize')
  if (formError.value.startsWith('PAYLOAD_RECOVERY_')) return t('issue.hosted.recoveryUnavailable')
  if (
    formError.value === 'PAYLOAD_SERVICE_NOT_CONFIGURED' ||
    formError.value === 'PAYLOAD_SERVICE_HTTPS_REQUIRED' ||
    formError.value === 'PAYLOAD_STORAGE_UNAVAILABLE'
  ) {
    return t('issue.errors.hostedUnavailable')
  }
  if (
    formError.value === 'PAYLOAD_SERVICE_URL_TOO_LONG' ||
    formError.value === 'SIGNED_TRANSACTION_PAYLOAD_MISMATCH' ||
    formError.value === 'PAYLOAD_LOCATOR_MISMATCH' ||
    formError.value === 'PUBLISHED_PAYLOAD_BYTES_MISMATCH'
  ) {
    return t('issue.errors.hostedIntegrity')
  }
  if (formError.value === 'HOSTED_PAYLOAD_PII_FIELD_FORBIDDEN') {
    return t('issue.errors.hostedPii')
  }
  if (formError.value === 'PAYLOAD_PUBLICATION_QUOTA_EXCEEDED') {
    return t('issue.errors.hostedQuota')
  }
  if (formError.value === 'SIGNED_TRANSACTION_NOT_INDEXED') {
    return t('issue.errors.hostedNotIndexed')
  }
  return props.issuerContext ? t('simpleIssuer.error') : formError.value
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

watch(recovery.pending, (current, previous) => {
  if (previous && !current && !recovery.saved.value) invalidatePreview()
})

function invalidatePreview() {
  managedPayload.value = null
  visibilityReviewed.value = false
  previewRevision += 1
  publicStoreAcknowledged.value = false
  publicationProof.value = null
  canonicalPayload.value = ''
  credentialUri.value = ''
  payloadLocator.value = ''
  transaction.value = null
  preparedProfileId.value = ''
  result.value = null
  issuedLinkInputs.value = null
}

watch([schemaUid, subject, claimsText, httpsUrl, expiration], invalidatePreview)
watch(claimsEditorMode, invalidatePreview)
watch([visibility, publicFields], invalidatePreview, { deep: true })
onMounted(() => {
  if (props.issuerContext && !props.issuerContext.existingCredential) void loadGuidedClaimForm()
})
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
    if (props.issuerContext && profile.profileId !== props.issuerContext.profileId)
      throw new Error('ISSUER_PROFILE_MISMATCH')
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

async function buildPreview() {
  if (props.issuerContext?.existingCredential) return
  if (props.issuerContext && (recovery.pending.value || recovery.saved.value)) return
  invalidatePreview()
  formError.value = ''
  result.value = null
  if (!account.value) return void (formError.value = 'WALLET_NOT_CONNECTED')
  const revision = previewRevision
  const issuerAddress = account.value.address
  const normalizedSchemaUid = schemaUid.value.toLowerCase()
  const subjectAddress = subject.value
  let claimsInput = claimsText.value
  const expirationInput = expiration.value
  try {
    if (claimsEditorMode.value === 'guided') {
      if (loadedSchemaUid.value !== normalizedSchemaUid) {
        throw new Error('GUIDED_CLAIMS_SCHEMA_REQUIRED')
      }
      claimsInput = guidedClaimsToJson(guidedClaims.value)
    }
    const profile = await getActiveNetworkProfile()
    if (props.issuerContext) {
      if (profile.profileId !== props.issuerContext.profileId)
        throw new Error('ISSUER_PROFILE_MISMATCH')
      await props.issuerContext.beforeSign(issuerAddress)
    }
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
    if (props.issuerContext) {
      const managed = await props.issuerContext.preparePayload(canonical, {
        visibility: visibility.value,
        publicFields: [...publicFields.value],
      })
      assertIssuerPayloadReceipt(managed, canonical)
      if (revision !== previewRevision) throw new Error('ISSUANCE_PREVIEW_CHANGED_DURING_BUILD')
      managedPayload.value = managed
      credentialUri.value = managed.credentialUri
      payloadLocator.value = managed.payloadId
    } else if (hostedPayloadsEnabled.value) {
      const hosted = createHostedPayloadLocation(config.public.payloadBaseUrl, canonical)
      credentialUri.value = hosted.credentialUri
      payloadLocator.value = hosted.locator
    } else {
      assertPayloadHttpsUrlIsConfigured(httpsUrl.value)
      credentialUri.value = createHttpsPayloadUri(httpsUrl.value, canonical)
      payloadLocator.value = 'issuer-hosted'
    }
    const raw = buildCredentialCreate({
      issuer: issuerAddress,
      subject: subjectAddress,
      schemaUid: normalizedSchemaUid,
      uri: credentialUri.value,
      ...(expirationInput ? { expiration: new Date(expirationInput).toISOString() } : {}),
    })
    const prepared = (await prepare(raw, profile)) as CredentialCreate
    if (revision !== previewRevision) throw new Error('ISSUANCE_PREVIEW_CHANGED_DURING_BUILD')
    transaction.value = prepared
    preparedProfileId.value = profile.profileId
  } catch (error) {
    transaction.value = null
    formError.value = error instanceof Error ? error.message : String(error)
  }
}

async function submit() {
  if (pendingPublication.value || flowBusy.value) return
  const preparedTransaction = transaction.value
  const expectedPayload = canonicalPayload.value
  const expectedUri = credentialUri.value
  const expectedIssuer = account.value?.address
  const expectedSubject = subject.value
  const expectedSchemaUid = schemaUid.value.toLowerCase()
  const expectedClaims = claimsText.value
  const expectedClaimsEditorMode = claimsEditorMode.value
  const expectedGuidedClaims = JSON.stringify(guidedClaims.value)
  const expectedLocator = payloadLocator.value
  const expectedPublicStoreAcknowledged = publicStoreAcknowledged.value
  const expectedExpiration = expiration.value
  const expectedProfileId = preparedProfileId.value
  const expectedRevision = previewRevision
  const expectedManagedPayload = managedPayload.value
  const expectedVisibility = visibility.value
  const expectedPublicFields = [...publicFields.value]
  if (props.issuerContext && (!expectedManagedPayload || !visibilityReviewed.value)) {
    formError.value = 'ISSUER_VISIBILITY_REVIEW_REQUIRED'
    return
  }
  if (hostedPayloadsEnabled.value && !expectedPublicStoreAcknowledged) {
    formError.value = 'HOSTED_PAYLOAD_CONSENT_REQUIRED'
    return
  }
  if (
    !preparedTransaction ||
    !expectedPayload ||
    !expectedUri ||
    !expectedIssuer ||
    !expectedLocator ||
    !expectedProfileId
  ) {
    formError.value = 'TRANSACTION_PREVIEW_REQUIRED'
    return
  }
  if (hostedPayloadsEnabled.value) {
    const exactPublicationConfirmed = window.confirm(
      t('issue.hosted.confirmExactPublication', {
        url: expectedUri.split('#')[0],
        payload: expectedPayload,
      }),
    )
    if (!exactPublicationConfirmed) return
  }

  flowBusy.value = true
  publicationCheckBusy.value = !hostedPayloadsEnabled.value
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
        payloadLocator.value !== expectedLocator ||
        publicStoreAcknowledged.value !== expectedPublicStoreAcknowledged ||
        expiration.value !== expectedExpiration ||
        preparedProfileId.value !== expectedProfileId ||
        managedPayload.value !== expectedManagedPayload ||
        visibility.value !== expectedVisibility ||
        JSON.stringify(publicFields.value) !== JSON.stringify(expectedPublicFields)
      ) {
        throw new Error('ISSUANCE_PREVIEW_CHANGED_DURING_PUBLICATION_CHECK')
      }
    }
    if (props.issuerContext) {
      await props.issuerContext.beforeSign(expectedIssuer)
    } else if (hostedPayloadsEnabled.value) {
      assertHostedPayloadSize(expectedPayload)
      await assertHostedPayloadReachable(expectedUri)
    } else {
      publicationProof.value = await verifyHttpsPayloadPublication({
        canonicalPayload: expectedPayload,
        credentialUri: expectedUri,
      })
    }
    assertCurrent()
    publicationCheckBusy.value = false
    if (hostedPayloadsEnabled.value) {
      publicationJobId.value = createHostedPublicationQueue(localStorage).begin({
        network: expectedProfileId,
        locator: expectedLocator,
        canonicalPayload: expectedPayload,
        credentialUri: expectedUri,
      }).id
    }
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
        payloadDigestHex: payloadDigest(expectedPayload),
        ...(props.issuerContext ? { issuerInviteId: props.issuerContext.inviteId } : {}),
        ...(publicationJobId.value ? { publicationJobId: publicationJobId.value } : {}),
        ...(normalizedExpiration ? { expiration: normalizedExpiration } : {}),
      },
      assertCurrent,
      async (signature) => {
        if (props.issuerContext && expectedManagedPayload) {
          await props.issuerContext.beforeSign(expectedIssuer)
          assertCurrent()
          recovery.stash({
            transactionHash: signature.txHash,
            payloadId: expectedManagedPayload.payloadId,
            visibility: expectedVisibility,
            publicFields: expectedPublicFields,
          })
        }
        if (publicationJobId.value) {
          pendingPublication.value = createHostedPublicationQueue(localStorage).signed(
            publicationJobId.value,
            signature,
          ).payload
        }
      },
      (validated) => {
        issuedLinkInputs.value = {
          profileId: expectedProfileId,
          issuer: expectedIssuer,
          subject: expectedSubject,
          schemaUid: expectedSchemaUid,
        }
        result.value = { ...validated }
        // Ledger success is irreversible. Keep publication retryable even if
        // waiting for the indexer fails, and never offer to issue it again.
        transaction.value = null
      },
    )
    result.value = response
    transaction.value = null
    await publishPendingPayload()
    await recovery.finish(response)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  } finally {
    // An interrupted/failed signing attempt without a returned signature stays
    // recoverable after reload. Never silently delete the only saved payload.
    if (!pendingPublication.value) publicationJobId.value = ''
    publicationCheckBusy.value = false
    flowBusy.value = false
    await recovery.checkFailure()
  }
}

async function publishPendingPayload() {
  const pending = pendingPublication.value
  if (!pending) return
  publicationCheckBusy.value = true
  try {
    const completedJobId = publicationJobId.value
    publicationProof.value = await createHostedPublicationQueue(localStorage).publish(
      completedJobId,
      publishHostedPayload,
    )
    pendingPublication.value = null
    publicationJobId.value = ''
    transaction.value = null
    try {
      await new IndexedDbOperationJournal().completePublication(completedJobId)
    } catch {
      // Publication is already verified. A cleanup failure must not offer an
      // impossible publication retry or imply that the credential was not issued.
      formError.value = t('issue.hosted.journalCleanupFailed')
    }
  } finally {
    publicationCheckBusy.value = false
  }
}

async function retryPublication() {
  if (flowBusy.value || busy.value) return
  flowBusy.value = true
  formError.value = ''
  try {
    await publishPendingPayload()
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  } finally {
    flowBusy.value = false
  }
}

const acceptLink = computed(() => {
  const generationId = result.value?.businessEvidence?.generationId
  if (
    result.value?.businessConfirmation !== 'confirmed' ||
    !publicationProof.value ||
    pendingPublication.value !== null ||
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
  <UContainer class="py-10 sm:py-14">
    <PageHeader :title="$t('simpleIssuer.issueTitle')" :lead="$t('simpleIssuer.issueLead')" />
    <StatusBox v-if="!issuerContext" tone="warning">{{ $t('issue.noPii') }}</StatusBox>
    <HostedPublicationRecovery v-if="!issuerContext" :exclude-id="publicationJobId" />
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

    <UCard
      v-if="
        !issuerContext ||
        (!issuerContext.existingCredential && !recovery.pending.value && !recovery.saved.value)
      "
      class="mb-6"
    >
      <div class="grid gap-5">
        <template v-if="issuerContext">
          <p>
            <strong>{{ $t('simpleIssuer.model') }}:</strong> {{ issuerContext.schemaName }}
          </p>
          <p>
            <strong>{{ $t('simpleIssuer.recipient') }}:</strong> {{ issuerContext.recipientLabel }}
          </p>
          <details>
            <summary class="cursor-pointer text-sm text-muted">
              {{ $t('simpleIssuer.accountDetails') }}
            </summary>
            <p class="mt-2 break-all">
              <code>{{ issuerContext.subjectAddress }}</code>
            </p>
          </details>
        </template>
        <UFormField v-if="!issuerContext" label="Schema UID">
          <UInput
            id="schema-uid"
            v-model.trim="schemaUid"
            required
            pattern="[0-9a-fA-F]{64}"
            :disabled="submissionBusy"
          />
        </UFormField>
        <UFormField v-if="!issuerContext" label="Subject">
          <UInput
            id="subject"
            v-model.trim="subject"
            required
            placeholder="r…"
            :disabled="submissionBusy"
          />
        </UFormField>

        <div class="flex flex-wrap gap-3">
          <UButton
            v-if="claimsEditorMode === 'json'"
            color="neutral"
            variant="outline"
            :disabled="submissionBusy"
            @click="selectClaimsEditorMode('guided')"
            >{{ $t('simpleIssuer.guided') }}</UButton
          >
          <UButton
            v-if="!issuerContext || (guidedClaims.length === 0 && !schemaLoadBusy)"
            color="neutral"
            variant="outline"
            :disabled="submissionBusy || schemaLoadBusy"
            @click="loadGuidedClaimForm"
            >{{ $t('issue.loadSchema') }}</UButton
          >
          <details>
            <summary class="cursor-pointer text-sm text-muted">
              {{ $t('simpleIssuer.advanced') }}
            </summary>
            <UButton
              class="mt-2"
              color="neutral"
              variant="outline"
              :disabled="submissionBusy"
              @click="selectClaimsEditorMode('json')"
              >{{ $t('simpleIssuer.editJson') }}</UButton
            >
          </details>
        </div>

        <template v-if="claimsEditorMode === 'guided'">
          <p v-if="loadedSchemaName" class="text-sm text-muted">
            {{ $t('simpleIssuer.model') }} : {{ loadedSchemaName }}
          </p>
          <div v-if="guidedClaims.length" class="grid gap-4">
            <UFormField
              v-for="field in guidedClaims"
              :key="field.name"
              :label="field.name"
              :hint="`${$t(`simpleIssuer.fieldTypes.${field.type}`)} · ${$t(field.optional ? 'issue.optionalField' : 'issue.requiredField')}`"
            >
              <USelect
                v-if="field.type === 'bool'"
                :id="`claim-${field.name}`"
                v-model="field.value"
                :items="[
                  { label: '—', value: undefined },
                  { label: $t('simpleIssuer.yes'), value: 'true' },
                  { label: $t('simpleIssuer.no'), value: 'false' },
                ]"
                :required="!field.optional"
                :disabled="submissionBusy"
              />
              <UInput
                v-else
                :id="`claim-${field.name}`"
                v-model="field.value"
                :required="!field.optional"
                :inputmode="field.type === 'uint' || field.type === 'int' ? 'numeric' : 'text'"
                :disabled="submissionBusy"
                autocomplete="off"
              />
            </UFormField>
          </div>
          <p v-else class="text-sm text-muted">{{ $t('issue.advancedClaimsHint') }}</p>
          <StatusBox v-if="guidedClaimsError && guidedClaims.length" tone="error">
            <p>{{ $t('simpleIssuer.fieldError') }}</p>
            <details>
              <summary class="cursor-pointer">{{ $t('simpleIssuer.technical') }}</summary>
              <code>{{ guidedClaimsError }}</code>
            </details>
          </StatusBox>
        </template>
        <template v-else>
          <UFormField label="Claims JSON">
            <UTextarea
              id="claims"
              v-model="claimsText"
              :rows="12"
              spellcheck="false"
              :disabled="submissionBusy"
            />
          </UFormField>
        </template>

        <div v-if="issuerContext" class="grid gap-4">
          <UFormField :label="$t('simpleIssuer.visibility')">
            <USelect
              v-model="visibility"
              :disabled="submissionBusy"
              :items="[
                { label: $t('simpleIssuer.private'), value: 'private' },
                { label: $t('simpleIssuer.public'), value: 'public' },
              ]"
            />
          </UFormField>
          <StatusBox v-if="visibility === 'public'" tone="warning">{{
            $t('simpleIssuer.publicWarning')
          }}</StatusBox>
          <fieldset v-else class="grid gap-2">
            <legend>{{ $t('simpleIssuer.publicFields') }}</legend>
            <UCheckbox
              v-for="name in Object.keys(claimObject)"
              :key="name"
              :label="name"
              :model-value="publicFields.includes(claimPublicPointer(name))"
              :disabled="submissionBusy"
              @update:model-value="
                (checked) => {
                  publicFields = checked
                    ? [...publicFields, claimPublicPointer(name)]
                    : publicFields.filter((field) => field !== claimPublicPointer(name))
                }
              "
            />
          </fieldset>
          <p class="text-sm text-muted">{{ $t('simpleIssuer.publicMetadata') }}</p>
        </div>
        <StatusBox
          v-else-if="hostedPayloadsEnabled"
          tone="notice"
          :title="$t('issue.hosted.title')"
        >
          {{ $t('issue.hosted.description', { origin: config.public.payloadBaseUrl }) }}
        </StatusBox>
        <UFormField v-else :label="$t('issue.httpsUrlLabel')" :help="$t('issue.httpsProof')">
          <UInput
            id="https-url"
            v-model.trim="httpsUrl"
            type="url"
            required
            autocomplete="off"
            :placeholder="$t('issue.httpsUrlPlaceholder')"
            :disabled="submissionBusy"
          />
        </UFormField>

        <UFormField :label="$t('simpleIssuer.expiration')">
          <UInput
            id="expiration"
            v-model="expiration"
            type="datetime-local"
            :disabled="submissionBusy"
          />
        </UFormField>
        <div>
          <UButton type="button" :disabled="submissionBusy" @click="buildPreview">
            {{ $t('simpleIssuer.reviewIssue') }}
          </UButton>
        </div>
      </div>
    </UCard>

    <StatusBox
      v-if="formError"
      tone="error"
      data-testid="issue-error"
      :title="formErrorMessage"
      role="alert"
    >
      <details v-if="formErrorIsLocalized">
        <summary class="cursor-pointer">{{ $t('simpleIssuer.technical') }}</summary>
        <code>{{ formError }}</code>
      </details>
    </StatusBox>

    <UCard v-if="canonicalPayload" class="mb-6">
      <template #header>
        <h2 class="text-xl font-semibold">{{ $t('simpleIssuer.reviewTitle') }}</h2>
      </template>
      <div v-if="issuerContext" class="grid gap-4 sm:grid-cols-2">
        <section>
          <h3 class="font-semibold">{{ $t('simpleIssuer.publicPreview') }}</h3>
          <AttestationFields :claims="visibilityPreview.public" />
        </section>
        <section>
          <h3 class="font-semibold">{{ $t('simpleIssuer.privatePreview') }}</h3>
          <AttestationFields :claims="visibilityPreview.private" />
        </section>
      </div>
      <JsonBlock v-else :code="canonicalPayload" />
      <UCheckbox
        v-if="issuerContext"
        v-model="visibilityReviewed"
        :disabled="submissionBusy"
        :label="$t('simpleIssuer.visibilityReviewed')"
      />
      <details v-if="issuerContext" class="mt-4">
        <summary class="cursor-pointer text-sm text-muted">
          {{ $t('simpleIssuer.technical') }}
        </summary>
        <p class="mt-2 text-sm break-all">
          <code>{{ credentialUri }}</code>
        </p>
        <JsonBlock class="mt-3" :code="canonicalPayload" />
        <UButton class="mt-3" color="neutral" variant="outline" @click="downloadPayload">{{
          $t('simpleIssuer.download')
        }}</UButton>
      </details>
      <p v-else class="text-sm break-all">
        <code>{{ credentialUri }}</code>
      </p>
      <UCheckbox
        v-if="hostedPayloadsEnabled"
        v-model="publicStoreAcknowledged"
        :disabled="submissionBusy"
        :label="$t('issue.hosted.consent', { url: credentialUri.split('#')[0] })"
      />
      <div v-if="!issuerContext" class="my-4">
        <UButton color="neutral" variant="outline" type="button" @click="downloadPayload">
          {{ $t('issue.download') }}
        </UButton>
      </div>
      <p v-if="hostedPayloadsEnabled" class="text-sm text-muted">
        {{ $t('issue.hosted.publishAfterSignature') }}
      </p>
      <p v-else-if="!issuerContext" class="text-sm break-words text-muted">
        {{ $t('issue.publishBeforeSigning', { url: httpsUrl }) }}
      </p>
      <StatusBox v-if="publicationCheckBusy" tone="notice">{{ $t('issue.checking') }}</StatusBox>
      <StatusBox v-else-if="publicationProof" tone="success">
        <p class="break-all">
          {{ $t('issue.checked', { bytes: publicationProof.byteLength }) }}
          <code>{{ publicationProof.digestHex }}</code>
        </p>
      </StatusBox>
    </UCard>

    <TransactionPreview
      :transaction="transaction"
      :busy="submissionBusy"
      :compact="!!issuerContext"
      :confirm-label="$t('simpleIssuer.sendIssue')"
      @confirm="submit"
    />
    <StatusBox v-if="pendingPublication" tone="notice" role="status">
      <p>{{ $t('issue.hosted.publicationPending') }}</p>
      <UButton
        type="button"
        :disabled="flowBusy || busy"
        data-testid="retry-hosted-publication"
        @click="retryPublication"
      >
        {{ $t('issue.hosted.retryPublication') }}
      </UButton>
    </StatusBox>
    <BusinessFinality
      v-if="result"
      :tx-hash="result.txHash"
      :engine-result="result.transactionResult"
      :ledger-index="result.ledgerIndex"
      :business-confirmation="result.businessConfirmation"
      :business-evidence="result.businessEvidence"
    />
    <UCard v-if="acceptLink && credentialLink" class="mb-6">
      <template #header>
        <h2 class="text-xl font-semibold">{{ $t('issue.links') }}</h2>
      </template>
      <div class="flex flex-wrap gap-3">
        <UButton
          color="neutral"
          variant="outline"
          data-testid="issue-credential-link"
          :to="localePath(credentialLink)"
        >
          {{ $t('issue.credentialLink') }}
        </UButton>
        <UButton color="neutral" variant="outline" :to="localePath(acceptLink)">
          {{ $t('issue.acceptLink') }}
        </UButton>
      </div>
    </UCard>
  </UContainer>
</template>
