<script setup lang="ts">
import { buildCredentialAccept, buildCredentialDelete } from '@xcs-protocol/sdk'
import type { CredentialAccept, CredentialDelete } from 'xrpl'
import type { ApiSchemaDetail } from '~/composables/useXcsApi'
import type { WalletSubmissionResult } from '~/composables/useWallet'
import {
  assertCredentialAcceptanceReviewCurrent,
  assertCredentialSubjectMutationReviewCurrent,
  assertPayloadFetchConsentCurrent,
  createIssuerTrustAcknowledgementToken,
  createPayloadFetchConsentToken,
  credentialActionBlockReason,
  loadCredentialMutationReview,
  loadCredentialReview,
  type CredentialMutationReview,
  type CredentialReview,
  type CredentialSubjectAction,
  type IssuerTrustAcknowledgementToken,
  type PayloadFetchConsentToken,
} from '~/utils/credentialReview'
import {
  assertLinkGeneration,
  assertLinkProfile,
  buildCredentialPermalink,
  singleRouteQueryValue,
} from '~/utils/operationLinks'
import { LOCAL_PAYLOAD_LOCATION } from '~/utils/localPayloadStore'
import { parseWalletCredentialTransactionError } from '~/utils/walletCompatibility'

const route = useRoute()
const { t } = useI18n()
const { account, busy: walletBusy, prepare, signAndSubmit } = useWallet()
const { getActiveNetworkProfile, getCredential, getCredentialGeneration, getSchema, verify } =
  useXcsApi()
const localPayloadStore = useLocalPayloadStore()
const issuer = ref(singleRouteQueryValue(route.query.issuer))
const schemaUid = ref(singleRouteQueryValue(route.query.schema))
const linkedProfileId = ref(singleRouteQueryValue(route.query.profile))
const linkedGenerationId = ref(singleRouteQueryValue(route.query.generation))
const linkedAction = ref(singleRouteQueryValue(route.query.action))

function linkedSubjectAction(value: string): CredentialSubjectAction {
  return value === 'reject' || value === 'remove' ? value : 'accept'
}

function assertLinkedActionValid(value: string): void {
  if (value !== '' && value !== 'accept' && value !== 'reject' && value !== 'remove') {
    throw new Error('CREDENTIAL_LINK_ACTION_INVALID')
  }
}

const action = ref<CredentialSubjectAction>(linkedSubjectAction(linkedAction.value))
const transaction = shallowRef<CredentialAccept | CredentialDelete | null>(null)
const review = shallowRef<CredentialReview | CredentialMutationReview | null>(null)
const acceptanceReview = computed<CredentialReview | null>(() => {
  const current = review.value
  return current && 'report' in current ? current : null
})
const reviewProfileId = ref<string | null>(null)
const schemaDetail = shallowRef<ApiSchemaDetail | null>(null)
const payloadConsent = ref(false)
const payloadConsentToken = shallowRef<PayloadFetchConsentToken | null>(null)
const issuerTrustAcknowledgementToken = shallowRef<IssuerTrustAcknowledgementToken | null>(null)
const reviewBusy = ref(false)
const message = ref('')
const result = shallowRef<WalletSubmissionResult | null>(null)
const busy = computed(() => walletBusy.value || reviewBusy.value)
const messageDisplay = computed(() => {
  if (message.value === 'CREDENTIAL_LINK_SUBJECT_WALLET_MISMATCH') {
    return t('accept.subjectWalletMismatch')
  }
  const walletTransactionError = parseWalletCredentialTransactionError(message.value)
  return walletTransactionError
    ? t('wallet.errors.credentialUnsupported', {
        wallet: walletTransactionError.walletName,
        transactionType: walletTransactionError.transactionType,
      })
    : message.value
})
const messageIsLocalized = computed(
  () => message.value.length > 0 && messageDisplay.value !== message.value,
)
const resultCredentialLink = computed(() => {
  const generationId = result.value?.businessEvidence?.generationId
  if (
    result.value?.businessConfirmation !== 'confirmed' ||
    !generationId ||
    !reviewProfileId.value
  ) {
    return null
  }
  return buildCredentialPermalink({
    profileId: reviewProfileId.value,
    generationId,
  })
})
const blockReason = computed(() => {
  if (!review.value) return undefined
  if (action.value === 'accept' && acceptanceReview.value?.claims === undefined) {
    return acceptanceReview.value?.report.issuerTrust === 'untrusted'
      ? 'CREDENTIAL_ISSUER_NOT_TRUSTED'
      : undefined
  }
  return credentialActionBlockReason(
    review.value,
    action.value,
    issuerTrustAcknowledgementToken.value ?? undefined,
    reviewProfileId.value ?? undefined,
  )
})
const blockReasonMessage = computed(() => {
  if (blockReason.value === 'CREDENTIAL_ISSUER_NOT_TRUSTED') return t('accept.issuerUntrusted')
  if (blockReason.value === 'CREDENTIAL_ISSUER_TRUST_ACK_REQUIRED') {
    return t('accept.issuerAcknowledgementRequired')
  }
  if (blockReason.value === 'CREDENTIAL_ISSUER_TRUST_ACK_STALE') {
    return t('accept.issuerAcknowledgementStale')
  }
  return blockReason.value
})
const payloadHost = computed(() => {
  if (!review.value?.uri) return null
  try {
    return localPayloadStore.inspectPayloadLocation(review.value.uri)
  } catch {
    return null
  }
})
const payloadUsesLocalStore = computed(() => payloadHost.value === LOCAL_PAYLOAD_LOCATION)
const payloadHostBlockReason = computed(() => {
  if (!review.value?.uri) return 'CREDENTIAL_URI_REQUIRED'
  try {
    localPayloadStore.inspectPayloadLocation(review.value.uri)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
})
const payloadHostBlockMessage = computed(() =>
  payloadHostBlockReason.value === 'LOCAL_PAYLOAD_NOT_AVAILABLE_IN_BROWSER'
    ? t('accept.localPayloadUnavailable')
    : payloadHostBlockReason.value,
)
let previewRevision = 0

function invalidatePreview() {
  previewRevision += 1
  transaction.value = null
  review.value = null
  reviewProfileId.value = null
  schemaDetail.value = null
  payloadConsent.value = false
  payloadConsentToken.value = null
  issuerTrustAcknowledgementToken.value = null
  result.value = null
}

watch(
  [issuer, schemaUid, action, linkedProfileId, linkedGenerationId, linkedAction],
  invalidatePreview,
)
watch(
  [() => account.value?.address ?? '', () => account.value?.network.id ?? ''],
  invalidatePreview,
)
watch(
  () => [
    route.query.issuer,
    route.query.schema,
    route.query.profile,
    route.query.generation,
    route.query.action,
  ],
  ([nextIssuer, nextSchema, nextProfile, nextGeneration, nextAction]) => {
    issuer.value = singleRouteQueryValue(nextIssuer)
    schemaUid.value = singleRouteQueryValue(nextSchema)
    linkedProfileId.value = singleRouteQueryValue(nextProfile)
    linkedGenerationId.value = singleRouteQueryValue(nextGeneration)
    linkedAction.value = singleRouteQueryValue(nextAction)
    action.value = linkedSubjectAction(linkedAction.value)
  },
)

function setPayloadConsent(granted: boolean) {
  if (!granted) {
    payloadConsent.value = false
    payloadConsentToken.value = null
    if (transaction.value === null) return
    previewRevision += 1
    transaction.value = null
    return
  }

  try {
    if (!acceptanceReview.value) throw new Error('CREDENTIAL_PAYLOAD_CONSENT_REQUIRED')
    payloadConsentToken.value = createPayloadFetchConsentToken(acceptanceReview.value)
    payloadConsent.value = true
    message.value = ''
  } catch (error) {
    payloadConsent.value = false
    payloadConsentToken.value = null
    message.value = error instanceof Error ? error.message : String(error)
  }
}

function setIssuerTrustAcknowledgement(granted: boolean) {
  if (!granted) {
    issuerTrustAcknowledgementToken.value = null
    if (transaction.value === null) return
    previewRevision += 1
    transaction.value = null
    result.value = null
    return
  }

  try {
    if (!acceptanceReview.value) throw new Error('CREDENTIAL_ISSUER_TRUST_ACK_REQUIRED')
    if (!reviewProfileId.value) throw new Error('CREDENTIAL_ISSUER_TRUST_ACK_PROFILE_REQUIRED')
    issuerTrustAcknowledgementToken.value = createIssuerTrustAcknowledgementToken(
      acceptanceReview.value,
      reviewProfileId.value,
    )
    message.value = ''
  } catch (error) {
    issuerTrustAcknowledgementToken.value = null
    message.value = error instanceof Error ? error.message : String(error)
  }
}

function clearStalePayloadConsent(error: unknown): void {
  if (!(error instanceof Error) || error.message !== 'CREDENTIAL_PAYLOAD_CONSENT_STALE') return
  payloadConsent.value = false
  payloadConsentToken.value = null
  issuerTrustAcknowledgementToken.value = null
  review.value = null
  reviewProfileId.value = null
  schemaDetail.value = null
  previewRevision += 1
  transaction.value = null
  result.value = null
}

function clearInvalidIssuerTrustAcknowledgement(error: unknown): void {
  if (
    !(error instanceof Error) ||
    ![
      'CREDENTIAL_ISSUER_NOT_TRUSTED',
      'CREDENTIAL_ISSUER_TRUST_ACK_REQUIRED',
      'CREDENTIAL_ISSUER_TRUST_ACK_STALE',
      'CREDENTIAL_ISSUER_TRUST_CHANGED_AFTER_SIGNATURE',
      'CREDENTIAL_GENERATION_CHANGED_BEFORE_SIGNATURE',
      'CREDENTIAL_GENERATION_CHANGED_AFTER_SIGNATURE',
      'CREDENTIAL_REVIEW_CHANGED_AFTER_SIGNATURE',
      'CREDENTIAL_STATE_CHANGED_AFTER_SIGNATURE',
      'CREDENTIAL_LINK_GENERATION_MISMATCH',
      'NETWORK_PROFILE_CHANGED_AFTER_SIGNATURE',
    ].includes(error.message)
  ) {
    return
  }
  issuerTrustAcknowledgementToken.value = null
  previewRevision += 1
  transaction.value = null
  result.value = null
}

async function fetchExactReview(input: {
  issuer: string
  subject: string
  schemaUid: string
  profileId: string
  payloadConsent?: PayloadFetchConsentToken | undefined
  expectedGenerationId?: string | undefined
}): Promise<{ credentialReview: CredentialReview; schema: ApiSchemaDetail | null }> {
  await assertLinkedGenerationCoordinates(input)
  const [credential, metadataReport, schemaResult] = await Promise.all([
    getCredential(input.issuer, input.subject, input.schemaUid, input.profileId),
    verify(
      {
        issuer: input.issuer,
        subject: input.subject,
        schemaUid: input.schemaUid,
        resolvePayload: false,
      },
      input.profileId,
    ),
    getSchema(input.schemaUid, input.profileId).then(
      (schema) => ({ schema }),
      (error: unknown) => ({ error }),
    ),
  ])
  if ('error' in schemaResult && input.payloadConsent) throw schemaResult.error
  const schema = 'schema' in schemaResult ? schemaResult.schema : null
  const reviewOptions = {
    credential,
    report: metadataReport,
    issuer: input.issuer,
    subject: input.subject,
    schemaUid: input.schemaUid,
    ...(schema ? { schema: schema.resolved } : {}),
    payloadReader: localPayloadStore.readPayload,
  }
  const metadataReview = await loadCredentialReview(reviewOptions)
  assertLinkGeneration(input.expectedGenerationId, metadataReview.generationId)
  if (!input.payloadConsent) return { credentialReview: metadataReview, schema }
  assertPayloadFetchConsentCurrent(metadataReview, input.payloadConsent)
  const localReview = await loadCredentialReview({ ...reviewOptions, fetchPayload: true })
  if (localReview.payload === undefined) throw new Error('CREDENTIAL_PAYLOAD_REVIEW_FAILED')

  // The API validates the already-consented, locally parsed object. It never
  // resolves the issuer URI, so the server-side URL resolver may stay disabled.
  const verifiedReport = await verify(
    {
      issuer: input.issuer,
      subject: input.subject,
      schemaUid: input.schemaUid,
      payload: localReview.payload,
    },
    input.profileId,
  )
  const verifiedMetadata = await loadCredentialReview({
    credential,
    report: verifiedReport,
    issuer: input.issuer,
    subject: input.subject,
    schemaUid: input.schemaUid,
  })
  return {
    schema,
    credentialReview: {
      ...verifiedMetadata,
      payload: localReview.payload,
      claims: localReview.claims,
      payloadDigestHex: localReview.payloadDigestHex,
      payloadByteLength: localReview.payloadByteLength,
      payloadCheckedAt: localReview.payloadCheckedAt,
    },
  }
}

async function fetchExactMutationReview(input: {
  issuer: string
  subject: string
  schemaUid: string
  profileId: string
  expectedGenerationId?: string | undefined
}): Promise<CredentialMutationReview> {
  await assertLinkedGenerationCoordinates(input)
  const credentialReview = loadCredentialMutationReview(
    await getCredential(input.issuer, input.subject, input.schemaUid, input.profileId),
    {
      issuer: input.issuer,
      subject: input.subject,
      schemaUid: input.schemaUid,
    },
  )
  assertLinkGeneration(input.expectedGenerationId, credentialReview.generationId)
  return credentialReview
}

async function assertLinkedGenerationCoordinates(input: {
  issuer: string
  subject: string
  schemaUid: string
  profileId: string
  expectedGenerationId?: string | undefined
}): Promise<void> {
  if (!input.expectedGenerationId) return
  const detail = await getCredentialGeneration(input.expectedGenerationId, input.profileId)
  const generation = detail.generation
  assertLinkGeneration(input.expectedGenerationId, generation.generationId)
  if (generation.issuer !== input.issuer) throw new Error('CREDENTIAL_LINK_ISSUER_MISMATCH')
  if (generation.schemaUid.toLowerCase() !== input.schemaUid.toLowerCase()) {
    throw new Error('CREDENTIAL_LINK_SCHEMA_MISMATCH')
  }
  if (generation.subject !== input.subject) {
    throw new Error('CREDENTIAL_LINK_SUBJECT_WALLET_MISMATCH')
  }
}

async function buildPreview() {
  previewRevision += 1
  transaction.value = null
  message.value = ''
  result.value = null
  if (!account.value) return void (message.value = 'WALLET_NOT_CONNECTED')

  reviewBusy.value = true
  const revision = previewRevision
  const subjectAddress = account.value.address
  const issuerAddress = issuer.value
  const normalizedSchemaUid = schemaUid.value.toLowerCase()
  const selectedAction = action.value
  const consent = selectedAction === 'accept' ? payloadConsentToken.value : null
  const trustAcknowledgement =
    selectedAction === 'accept' ? issuerTrustAcknowledgementToken.value : null
  try {
    assertLinkedActionValid(linkedAction.value)
    const profile = await getActiveNetworkProfile()
    assertLinkProfile(linkedProfileId.value || undefined, profile.profileId)
    const linkedGeneration = linkedGenerationId.value
      ? { expectedGenerationId: linkedGenerationId.value }
      : {}
    const loaded =
      selectedAction === 'accept'
        ? await fetchExactReview({
            issuer: issuerAddress,
            subject: subjectAddress,
            schemaUid: normalizedSchemaUid,
            profileId: profile.profileId,
            ...linkedGeneration,
            ...(consent ? { payloadConsent: consent } : {}),
          })
        : {
            credentialReview: await fetchExactMutationReview({
              issuer: issuerAddress,
              subject: subjectAddress,
              schemaUid: normalizedSchemaUid,
              profileId: profile.profileId,
              ...linkedGeneration,
            }),
            schema: null,
          }
    if (revision !== previewRevision) throw new Error('CREDENTIAL_REVIEW_CHANGED_DURING_LOAD')

    review.value = loaded.credentialReview
    reviewProfileId.value = profile.profileId
    schemaDetail.value = loaded.schema
    if (selectedAction === 'accept' && !consent) {
      message.value = payloadHostBlockReason.value ?? 'CREDENTIAL_PAYLOAD_CONSENT_REQUIRED'
      return
    }
    const reason = credentialActionBlockReason(
      loaded.credentialReview,
      selectedAction,
      trustAcknowledgement ?? undefined,
      profile.profileId,
    )
    if (reason) throw new Error(reason)

    const raw =
      selectedAction === 'accept'
        ? buildCredentialAccept({
            subject: subjectAddress,
            issuer: issuerAddress,
            schemaUid: normalizedSchemaUid,
          })
        : buildCredentialDelete({
            account: subjectAddress,
            issuer: issuerAddress,
            subject: subjectAddress,
            schemaUid: normalizedSchemaUid,
          })
    const prepared = (await prepare(raw, profile)) as CredentialAccept | CredentialDelete
    if (revision !== previewRevision) throw new Error('CREDENTIAL_REVIEW_CHANGED_DURING_BUILD')
    transaction.value = prepared
  } catch (error) {
    clearStalePayloadConsent(error)
    clearInvalidIssuerTrustAcknowledgement(error)
    transaction.value = null
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    reviewBusy.value = false
  }
}

async function submit() {
  const preparedTransaction = transaction.value
  const expectedReview = review.value
  const expectedSubject = account.value?.address
  const expectedIssuer = issuer.value
  const expectedSchemaUid = schemaUid.value.toLowerCase()
  const expectedAction = action.value
  const expectedPayloadConsent = payloadConsentToken.value
  const expectedIssuerTrustAcknowledgement = issuerTrustAcknowledgementToken.value
  const expectedLinkedProfileId = linkedProfileId.value
  const expectedLinkedGenerationId = linkedGenerationId.value
  const expectedLinkedAction = linkedAction.value
  const expectedRevision = previewRevision
  if (!preparedTransaction || !expectedReview || !expectedSubject) {
    message.value = 'TRANSACTION_PREVIEW_REQUIRED'
    return
  }

  reviewBusy.value = true
  message.value = ''
  try {
    const assertCurrent = () => {
      if (
        previewRevision !== expectedRevision ||
        transaction.value !== preparedTransaction ||
        account.value?.address !== expectedSubject ||
        issuer.value !== expectedIssuer ||
        schemaUid.value.toLowerCase() !== expectedSchemaUid ||
        action.value !== expectedAction ||
        payloadConsentToken.value !== expectedPayloadConsent ||
        issuerTrustAcknowledgementToken.value !== expectedIssuerTrustAcknowledgement ||
        linkedProfileId.value !== expectedLinkedProfileId ||
        linkedGenerationId.value !== expectedLinkedGenerationId ||
        linkedAction.value !== expectedLinkedAction
      ) {
        throw new Error('CREDENTIAL_REVIEW_CHANGED_BEFORE_SIGNATURE')
      }
    }
    assertCurrent()
    assertLinkedActionValid(expectedLinkedAction)
    const profile = await getActiveNetworkProfile()
    assertLinkProfile(expectedLinkedProfileId || undefined, profile.profileId)
    const linkedGeneration = expectedLinkedGenerationId
      ? { expectedGenerationId: expectedLinkedGenerationId }
      : {}
    const loaded =
      expectedAction === 'accept'
        ? await (async () => {
            if (!expectedPayloadConsent) throw new Error('CREDENTIAL_PAYLOAD_CONSENT_REQUIRED')
            return fetchExactReview({
              issuer: expectedIssuer,
              subject: expectedSubject,
              schemaUid: expectedSchemaUid,
              profileId: profile.profileId,
              ...linkedGeneration,
              payloadConsent: expectedPayloadConsent,
            })
          })()
        : {
            credentialReview: await fetchExactMutationReview({
              issuer: expectedIssuer,
              subject: expectedSubject,
              schemaUid: expectedSchemaUid,
              profileId: profile.profileId,
              ...linkedGeneration,
            }),
            schema: null,
          }
    assertCurrent()
    if (loaded.credentialReview.generationId !== expectedReview.generationId) {
      throw new Error('CREDENTIAL_GENERATION_CHANGED_BEFORE_SIGNATURE')
    }
    if (expectedAction === 'accept') {
      if (!('report' in expectedReview) || !('report' in loaded.credentialReview)) {
        throw new Error('CREDENTIAL_ACCEPTANCE_REVIEW_REQUIRED')
      }
      assertCredentialAcceptanceReviewCurrent(
        expectedReview,
        loaded.credentialReview,
        profile.profileId,
        profile.profileId,
        expectedIssuerTrustAcknowledgement ?? undefined,
      )
    } else {
      if ('report' in expectedReview || 'report' in loaded.credentialReview) {
        throw new Error('CREDENTIAL_MUTATION_REVIEW_REQUIRED')
      }
      assertCredentialSubjectMutationReviewCurrent(
        expectedReview,
        loaded.credentialReview,
        profile.profileId,
        profile.profileId,
        expectedAction,
      )
    }
    review.value = loaded.credentialReview
    reviewProfileId.value = profile.profileId
    schemaDetail.value = loaded.schema
    const reason = credentialActionBlockReason(
      loaded.credentialReview,
      expectedAction,
      expectedIssuerTrustAcknowledgement ?? undefined,
      profile.profileId,
    )
    if (reason) throw new Error(reason)

    const revalidateSubjectActionAfterSignature = async () => {
      assertCurrent()
      const latestProfile = await getActiveNetworkProfile()
      assertLinkProfile(expectedLinkedProfileId || undefined, latestProfile.profileId)
      if (expectedAction === 'accept') {
        if (!('report' in loaded.credentialReview)) {
          throw new Error('CREDENTIAL_ACCEPTANCE_REVIEW_REQUIRED')
        }
        const latest = await fetchExactReview({
          issuer: expectedIssuer,
          subject: expectedSubject,
          schemaUid: expectedSchemaUid,
          profileId: latestProfile.profileId,
          ...linkedGeneration,
        })
        assertCurrent()
        assertCredentialAcceptanceReviewCurrent(
          loaded.credentialReview,
          latest.credentialReview,
          profile.profileId,
          latestProfile.profileId,
          expectedIssuerTrustAcknowledgement ?? undefined,
        )
      } else {
        if ('report' in loaded.credentialReview) {
          throw new Error('CREDENTIAL_MUTATION_REVIEW_REQUIRED')
        }
        const latest = await fetchExactMutationReview({
          issuer: expectedIssuer,
          subject: expectedSubject,
          schemaUid: expectedSchemaUid,
          profileId: latestProfile.profileId,
          ...linkedGeneration,
        })
        assertCurrent()
        assertCredentialSubjectMutationReviewCurrent(
          loaded.credentialReview,
          latest,
          profile.profileId,
          latestProfile.profileId,
          expectedAction,
        )
      }
    }

    const response = await signAndSubmit(
      preparedTransaction,
      {
        action:
          expectedAction === 'accept'
            ? 'credential-accept'
            : expectedAction === 'reject'
              ? 'credential-reject'
              : 'credential-remove',
        issuer: expectedIssuer,
        subject: expectedSubject,
        schemaUid: expectedSchemaUid,
        generationId: loaded.credentialReview.generationId,
        ...('payloadDigestHex' in loaded.credentialReview &&
        loaded.credentialReview.payloadDigestHex
          ? { payloadDigestHex: loaded.credentialReview.payloadDigestHex }
          : {}),
      },
      assertCurrent,
      revalidateSubjectActionAfterSignature,
      (validated) => {
        result.value = { ...validated }
      },
    )
    result.value = response
    transaction.value = null
  } catch (error) {
    clearStalePayloadConsent(error)
    clearInvalidIssuerTrustAcknowledgement(error)
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    reviewBusy.value = false
  }
}
</script>

<template>
  <section class="section-wrap form-page">
    <p class="eyebrow">Credential subject</p>
    <h1>{{ $t('accept.title') }}</h1>
    <p class="lead">{{ $t('accept.description') }}</p>
    <div class="warning-box">{{ $t('accept.notTruth') }}</div>

    <div class="form-card form-grid">
      <label for="subject-action">{{ $t('accept.action') }}</label>
      <select id="subject-action" v-model="action" :disabled="busy">
        <option value="accept">{{ $t('accept.acceptAction') }}</option>
        <option value="reject">{{ $t('accept.rejectAction') }}</option>
        <option value="remove">{{ $t('accept.removeAction') }}</option>
      </select>
      <label for="issuer">Issuer</label>
      <input id="issuer" v-model.trim="issuer" placeholder="r…" :disabled="busy" />
      <label for="accept-schema">Schema UID</label>
      <input
        id="accept-schema"
        v-model.trim="schemaUid"
        pattern="[0-9a-fA-F]{64}"
        :disabled="busy"
      />
      <button class="button" type="button" :disabled="busy" @click="buildPreview">
        {{
          busy
            ? $t('common.working')
            : action === 'accept' && review && payloadConsent
              ? $t('accept.fetchAndPrepare')
              : $t('accept.review')
        }}
      </button>
    </div>

    <div v-if="message" class="error-box" role="alert" data-testid="accept-error">
      <strong>{{ messageDisplay }}</strong>
      <p v-if="messageIsLocalized">
        <code>{{ message }}</code>
      </p>
    </div>
    <article v-if="review" class="form-card">
      <h2>{{ $t('accept.exactCredential') }}</h2>
      <dl class="metadata-list">
        <dt>Issuer</dt>
        <dd>
          <code>{{ review.issuer }}</code>
        </dd>
        <dt>Subject</dt>
        <dd>
          <code>{{ review.subject }}</code>
        </dd>
        <dt>Schema</dt>
        <dd>
          <strong v-if="schemaDetail">{{ schemaDetail.name }}</strong>
          <code>{{ review.schemaUid }}</code>
        </dd>
        <dt>{{ $t('accept.expiration') }}</dt>
        <dd>{{ review.expiration ?? $t('accept.noExpiration') }}</dd>
        <dt>URI</dt>
        <dd>
          <code>{{ review.uri ?? '—' }}</code>
        </dd>
        <dt>{{ $t('accept.generation') }}</dt>
        <dd>
          <code>{{ review.generationId }}</code>
        </dd>
        <dt>{{ $t('accept.state') }}</dt>
        <dd><StatusPill :value="review.state" /></dd>
        <dt>{{ $t('accept.acceptedFlag') }}</dt>
        <dd>
          <code>{{ review.accepted }}</code>
        </dd>
      </dl>

      <div v-if="acceptanceReview" class="verification-grid">
        <article>
          <span>{{ $t('verify.onChain') }}</span
          ><StatusPill :value="acceptanceReview.report.onChain" />
        </article>
        <article>
          <span>{{ $t('verify.schema') }}</span
          ><StatusPill :value="acceptanceReview.report.schema" />
        </article>
        <article>
          <span>{{ $t('verify.payload') }}</span
          ><StatusPill :value="acceptanceReview.report.payload" />
        </article>
        <article>
          <span>{{ $t('verify.trust') }}</span
          ><StatusPill :value="acceptanceReview.report.issuerTrust" />
        </article>
      </div>

      <div v-if="action === 'accept' && !acceptanceReview?.claims" class="warning-box">
        <p>
          {{
            $t(
              payloadUsesLocalStore
                ? 'accept.localPayloadConsentIntro'
                : 'accept.payloadConsentIntro',
              { host: payloadHost ?? '—' },
            )
          }}
        </p>
        <div v-if="payloadHostBlockReason" class="error-box">{{ payloadHostBlockMessage }}</div>
        <label v-else>
          <input
            data-testid="payload-consent"
            type="checkbox"
            :checked="payloadConsent"
            :disabled="busy"
            @change="setPayloadConsent(($event.target as HTMLInputElement).checked)"
          />
          {{ $t(payloadUsesLocalStore ? 'accept.localPayloadConsent' : 'accept.payloadConsent') }}
        </label>
      </div>
      <div
        v-if="action === 'accept' && acceptanceReview?.report.issuerTrust === 'unknown'"
        class="warning-box"
        data-testid="issuer-trust-acknowledgement"
      >
        <p>{{ $t('accept.issuerUnknown') }}</p>
        <label>
          <input
            type="checkbox"
            :checked="issuerTrustAcknowledgementToken !== null"
            :disabled="busy"
            @change="setIssuerTrustAcknowledgement(($event.target as HTMLInputElement).checked)"
          />
          {{ $t('accept.issuerAcknowledgement') }}
        </label>
      </div>
      <template v-if="action === 'accept'">
        <h2>{{ $t('accept.publicClaims') }}</h2>
        <pre v-if="acceptanceReview?.claims">{{
          JSON.stringify(acceptanceReview.claims, null, 2)
        }}</pre>
        <div v-else-if="acceptanceReview?.payloadReviewError" class="error-box">
          {{ $t('accept.payloadUnavailable') }}
          <code>{{ acceptanceReview.payloadReviewError }}</code>
        </div>
        <p v-if="acceptanceReview?.payloadDigestHex" class="muted">
          {{ acceptanceReview.payloadByteLength }} bytes ·
          <code>{{ acceptanceReview.payloadDigestHex }}</code>
        </p>
      </template>
      <div v-if="blockReasonMessage" class="error-box">{{ blockReasonMessage }}</div>
      <div v-else-if="action === 'reject'" class="warning-box">
        {{ $t('accept.rejectSafety') }}
      </div>
      <div v-else-if="action === 'remove'" class="warning-box">
        {{ $t('accept.removeSafety') }}
      </div>
    </article>

    <TransactionPreview :transaction="transaction" :busy="busy" @confirm="submit" />
    <BusinessFinality
      v-if="result"
      :tx-hash="result.txHash"
      :engine-result="result.transactionResult"
      :ledger-index="result.ledgerIndex"
      :business-confirmation="result.businessConfirmation"
      :business-evidence="result.businessEvidence"
    />
    <NuxtLinkLocale
      v-if="resultCredentialLink"
      class="button secondary"
      data-testid="subject-result-permalink"
      :to="resultCredentialLink"
    >
      {{ $t('accept.openPermalink') }}
    </NuxtLinkLocale>
  </section>
</template>
