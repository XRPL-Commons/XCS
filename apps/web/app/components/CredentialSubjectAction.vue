<script setup lang="ts">
import { buildCredentialAccept, buildCredentialDelete } from '#xcs/sdk/index.js'
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
import { readRecipientPayload } from '~/utils/recipientPayload'
import type { RecipientPayload } from '../../server/xcs/recipient/types'
import { walletTransactionErrorMessage } from '~/utils/walletCompatibility'

const props = defineProps<{
  fixedCredential?: {
    profileId: string
    generationId: string
    issuerAddress: string
    subjectAddress: string
    schemaUid: string
    visibility: 'public' | 'private'
    organizationName?: string
  }
  initialAction?: 'accept' | 'reject' | 'remove'
}>()
const emit = defineEmits<{ reconciled: [] }>()
const primaryAction = computed(() => props.initialAction ?? 'accept')
const auth = useAuth()
const request = useRequestFetch()
const privateReview = computed(() => props.fixedCredential?.visibility === 'private')
const route = useRoute()
const localePath = useLocalePath()
const { t } = useI18n()
const { account, busy: walletBusy, prepare, signAndSubmit } = useWallet()
const { getActiveNetworkProfile, getCredential, getCredentialGeneration, getSchema, verify } =
  useXcsApi()
const localPayloadStore = useLocalPayloadStore()
const issuer = ref(
  props.fixedCredential?.issuerAddress ?? singleRouteQueryValue(route.query.issuer),
)
const schemaUid = ref(props.fixedCredential?.schemaUid ?? singleRouteQueryValue(route.query.schema))
const linkedProfileId = ref(
  props.fixedCredential?.profileId ?? singleRouteQueryValue(route.query.profile),
)
const linkedGenerationId = ref(
  props.fixedCredential?.generationId ?? singleRouteQueryValue(route.query.generation),
)
const linkedAction = ref(
  props.initialAction ?? (props.fixedCredential ? '' : singleRouteQueryValue(route.query.action)),
)

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
  if (message.value === 'PAYLOAD_DIGEST_MISMATCH') return t('accept.payloadMismatch')
  if (
    message.value.startsWith('PAYLOAD_') ||
    message.value === 'CREDENTIAL_PAYLOAD_REVIEW_FAILED'
  ) {
    return t('accept.payloadUnavailable')
  }
  if (message.value === 'CREDENTIAL_LINK_SUBJECT_WALLET_MISMATCH') {
    return t('accept.subjectWalletMismatch')
  }
  return (
    walletTransactionErrorMessage(message.value, t) ??
    (props.fixedCredential && message.value
      ? t('simpleRecipient.actionUnavailable')
      : message.value)
  )
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
  return props.fixedCredential && blockReason.value
    ? t('simpleRecipient.actionUnavailable')
    : blockReason.value
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
const privatePreviewHidden = ref(false)

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

function hidePrivatePreview() {
  privatePreviewHidden.value = document.visibilityState === 'hidden'
  // An external wallet can hide this page while signing. Keep the reviewed
  // transaction intact; identity and generation guards still run after signing.
  if (privateReview.value && privatePreviewHidden.value && !walletBusy.value) invalidatePreview()
}
onMounted(() => document.addEventListener('visibilitychange', hidePrivatePreview))
onBeforeUnmount(() => {
  invalidatePreview()
  document.removeEventListener('visibilitychange', hidePrivatePreview)
})

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
    if (props.fixedCredential) return
    issuer.value = singleRouteQueryValue(nextIssuer)
    schemaUid.value = singleRouteQueryValue(nextSchema)
    linkedProfileId.value = singleRouteQueryValue(nextProfile)
    linkedGenerationId.value = singleRouteQueryValue(nextGeneration)
    linkedAction.value = singleRouteQueryValue(nextAction)
    action.value = linkedSubjectAction(linkedAction.value)
  },
)

async function setPayloadConsent(granted: boolean) {
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
    await buildPreview()
  } catch (error) {
    payloadConsent.value = false
    payloadConsentToken.value = null
    message.value = error instanceof Error ? error.message : String(error)
  }
}

async function setIssuerTrustAcknowledgement(granted: boolean) {
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
    if (payloadConsent.value) await buildPreview()
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

watch(
  () => props.fixedCredential,
  (fixed) => {
    invalidatePreview()
    if (!fixed) return
    issuer.value = fixed.issuerAddress
    schemaUid.value = fixed.schemaUid
    linkedProfileId.value = fixed.profileId
    linkedGenerationId.value = fixed.generationId
  },
  { deep: true },
)
// A reconciled credential can stay on the same page while its available action changes.
watch(
  () => props.initialAction,
  (next) => {
    if (!props.fixedCredential) return
    linkedAction.value = next ?? ''
    action.value = linkedSubjectAction(linkedAction.value)
    invalidatePreview()
  },
)
async function reviewAction(next: CredentialSubjectAction) {
  if (busy.value) return
  action.value = next
  await nextTick()
  await buildPreview()
}

watch(
  () => auth.user.value?.id,
  () => {
    if (props.fixedCredential) invalidatePreview()
  },
)

async function assertRecipientContext(subject: string) {
  const fixed = props.fixedCredential
  if (!fixed) return
  if (subject !== fixed.subjectAddress) throw new Error('CREDENTIAL_LINK_SUBJECT_WALLET_MISMATCH')
  await auth.load(true)
  if (
    !auth.user.value?.wallets.some((wallet) => wallet.address === subject && wallet.networkId === 1)
  )
    throw new Error('CREDENTIAL_LINK_SUBJECT_WALLET_MISMATCH')
  // Session, recipient ownership and indexed generation are checked server-side on every review.
  await request(
    `/api/recipient/credentials/${encodeURIComponent(fixed.profileId)}/${fixed.generationId}`,
  )
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
    payloadReader: privateReview.value
      ? (options: Parameters<typeof readRecipientPayload>[0]) =>
          readRecipientPayload(options, window.location.origin)
      : localPayloadStore.readPayload,
  }
  const metadataReview = await loadCredentialReview(reviewOptions)
  assertLinkGeneration(input.expectedGenerationId, metadataReview.generationId)
  if (!input.payloadConsent) return { credentialReview: metadataReview, schema }
  assertPayloadFetchConsentCurrent(metadataReview, input.payloadConsent)
  const localReview = await loadCredentialReview({ ...reviewOptions, fetchPayload: true })
  if (localReview.payload === undefined) throw new Error('CREDENTIAL_PAYLOAD_REVIEW_FAILED')

  // The API validates the already-consented, locally parsed object. It never
  // resolves the issuer URI, so the server-side URL resolver may stay disabled.
  // Private claims stay on the authenticated surface; the browser independently
  // checks the canonical bytes, schema and on-chain digest before wallet consent.
  const fixed = props.fixedCredential
  const verifiedReport =
    privateReview.value && fixed
      ? (
          await request<RecipientPayload>(
            `/api/recipient/credentials/${encodeURIComponent(fixed.profileId)}/${fixed.generationId}/payload`,
          )
        ).verification
      : await verify(
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
  await assertRecipientContext(input.subject)
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
  if (busy.value) return
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
      message.value = payloadHostBlockReason.value ?? ''
      return
    }
    const reason = credentialActionBlockReason(
      loaded.credentialReview,
      selectedAction,
      trustAcknowledgement ?? undefined,
      profile.profileId,
    )
    // The next visible step asks for this acknowledgement. It is not an error.
    if (reason === 'CREDENTIAL_ISSUER_TRUST_ACK_REQUIRED') return
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
    const fixed = props.fixedCredential
    if (fixed && response.businessConfirmation === 'confirmed') {
      await auth.mutateApplication(
        `/api/recipient/credentials/${encodeURIComponent(fixed.profileId)}/${fixed.generationId}/reconcile`,
        {
          transactionHash: response.txHash,
          action: expectedAction,
        },
      )
      emit('reconciled')
    }
  } catch (error) {
    clearStalePayloadConsent(error)
    clearInvalidIssuerTrustAcknowledgement(error)
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    reviewBusy.value = false
    if (privateReview.value && document.visibilityState === 'hidden') invalidatePreview()
  }
}
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      v-if="!fixedCredential"
      eyebrow="Credential subject"
      :title="$t('accept.title')"
      :lead="$t('accept.description')"
    />
    <UCard class="mb-6">
      <div class="grid gap-5">
        <template v-if="fixedCredential">
          <template v-if="primaryAction === 'accept'">
            <h2 class="text-xl font-semibold">{{ $t('simpleRecipient.reviewStep') }}</h2>
            <p class="text-muted">{{ $t('simpleRecipient.reviewIntro') }}</p>
            <UButton :disabled="busy" @click="reviewAction('accept')">{{
              busy ? $t('common.working') : $t('accept.review')
            }}</UButton>
          </template>
          <p v-else-if="primaryAction === 'remove'" class="text-muted">
            {{ $t('simpleRecipient.acceptedActions') }}
          </p>
          <details id="subject-action" class="rounded border border-default p-4">
            <summary class="cursor-pointer font-semibold">
              {{ $t('simpleRecipient.otherActions') }}
            </summary>
            <p v-if="primaryAction === 'remove'" class="mt-3 text-sm text-muted">
              {{ $t('simpleRecipient.removeIntro') }}
            </p>
            <UButton
              class="mt-3"
              color="neutral"
              variant="outline"
              :disabled="busy"
              @click="reviewAction(primaryAction === 'remove' ? 'remove' : 'reject')"
              >{{
                $t(primaryAction === 'remove' ? 'accept.removeAction' : 'accept.rejectAction')
              }}</UButton
            >
          </details>
        </template>
        <UFormField v-else :label="$t('accept.action')">
          <USelect
            id="subject-action"
            v-model="action"
            :items="[
              { label: $t('accept.acceptAction'), value: 'accept' },
              { label: $t('accept.rejectAction'), value: 'reject' },
              { label: $t('accept.removeAction'), value: 'remove' },
            ]"
            :disabled="busy"
          />
        </UFormField>
        <UFormField v-if="!fixedCredential" label="Issuer">
          <UInput id="issuer" v-model.trim="issuer" placeholder="r…" :disabled="busy" />
        </UFormField>
        <UFormField v-if="!fixedCredential" label="Schema UID">
          <UInput
            id="accept-schema"
            v-model.trim="schemaUid"
            pattern="[0-9a-fA-F]{64}"
            :disabled="busy"
          />
        </UFormField>
        <div v-if="!fixedCredential">
          <UButton type="button" :disabled="busy" @click="buildPreview">
            {{ busy ? $t('common.working') : $t('accept.review') }}
          </UButton>
        </div>
      </div>
    </UCard>

    <StatusBox
      v-if="message && (!review || result)"
      tone="error"
      role="alert"
      data-testid="accept-error"
      :title="messageDisplay"
    >
      <details v-if="messageIsLocalized">
        <summary class="cursor-pointer">{{ $t('accept.technicalDetails') }}</summary>
        <code>{{ message }}</code>
      </details>
    </StatusBox>
    <!-- The review is a pre-signing snapshot, not the state after ledger validation. -->
    <UCard v-if="review && !result" class="mb-6" data-testid="credential-subject-review">
      <template #header>
        <h2 class="text-xl font-semibold">{{ $t('accept.exactCredential') }}</h2>
      </template>
      <MetadataList>
        <dt>{{ $t('simpleRecipient.reviewIssuer') }}</dt>
        <dd v-if="fixedCredential">
          {{ fixedCredential.organizationName ?? $t('recipient.credential') }}
        </dd>
        <dd v-else>
          <code>{{ review.issuer }}</code>
        </dd>
        <dt>{{ $t('simpleRecipient.reviewSubject') }}</dt>
        <dd v-if="fixedCredential">
          {{ $t('simpleRecipient.yourWallet') }}
          <details class="mt-1 text-sm">
            <summary class="cursor-pointer">{{ $t('simpleRecipient.walletIdentity') }}</summary>
            <code class="break-all">{{ review.subject }}</code>
          </details>
        </dd>
        <dd v-else>
          <code>{{ review.subject }}</code>
        </dd>
        <dt>{{ $t(fixedCredential ? 'simpleUi.attestationType' : 'verify.schema') }}</dt>
        <dd>
          <strong>{{
            schemaDetail?.name ?? (fixedCredential ? $t('recipient.credential') : review.schemaUid)
          }}</strong>
        </dd>
        <dt>{{ $t('accept.expiration') }}</dt>
        <dd>{{ review.expiration ?? $t('accept.noExpiration') }}</dd>
        <dt>{{ $t('accept.state') }}</dt>
        <dd>
          <AttestationStatus v-if="fixedCredential" :value="review.state" /><StatusPill
            v-else
            :value="review.state"
          />
        </dd>
      </MetadataList>

      <StatusBox v-if="action === 'accept' && !acceptanceReview?.claims" tone="notice">
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
        <StatusBox v-if="payloadHostBlockReason" tone="error">{{
          payloadHostBlockMessage
        }}</StatusBox>
        <UCheckbox
          v-else
          data-testid="payload-consent"
          :model-value="payloadConsent"
          :disabled="busy"
          :label="
            $t(payloadUsesLocalStore ? 'accept.localPayloadConsent' : 'accept.payloadConsent')
          "
          @update:model-value="setPayloadConsent(Boolean($event))"
        />
      </StatusBox>
      <p v-if="reviewBusy" role="status" aria-live="polite">{{ $t('accept.checking') }}</p>
      <template
        v-if="
          action === 'accept' &&
          acceptanceReview?.claims &&
          !(privateReview && privatePreviewHidden)
        "
      >
        <h2 class="mt-6 mb-2 text-xl font-semibold">
          {{ $t(privateReview ? 'recipient.readContent' : 'accept.publicClaims') }}
        </h2>
        <div data-testid="credential-claims">
          <AttestationFields :claims="acceptanceReview.claims" />
        </div>
      </template>
      <StatusBox
        v-if="action === 'accept' && acceptanceReview?.report.issuerTrust === 'unknown'"
        tone="notice"
        data-testid="issuer-trust-acknowledgement"
      >
        <p>{{ $t('accept.issuerUnknown') }}</p>
        <UCheckbox
          :model-value="issuerTrustAcknowledgementToken !== null"
          :disabled="busy || !acceptanceReview?.claims"
          :label="$t('accept.issuerAcknowledgement')"
          @update:model-value="setIssuerTrustAcknowledgement(Boolean($event))"
        />
      </StatusBox>
      <p v-if="action === 'accept'" class="text-sm text-muted">{{ $t('accept.notTruth') }}</p>
      <p v-if="blockReason === 'CREDENTIAL_ISSUER_TRUST_ACK_REQUIRED'" class="text-sm text-muted">
        {{ blockReasonMessage }}
      </p>
      <StatusBox v-else-if="blockReasonMessage" tone="error">{{ blockReasonMessage }}</StatusBox>
      <StatusBox v-else-if="action === 'reject'" tone="warning">{{
        $t('accept.rejectSafety')
      }}</StatusBox>
      <StatusBox v-else-if="action === 'remove'" tone="warning">{{
        $t('accept.removeSafety')
      }}</StatusBox>
      <StatusBox
        v-if="message"
        tone="error"
        role="alert"
        data-testid="accept-error"
        :title="messageDisplay"
      >
        <details v-if="messageIsLocalized">
          <summary>{{ $t('accept.technicalDetails') }}</summary>
          <code>{{ message }}</code>
        </details>
      </StatusBox>
      <TransactionPreview
        v-if="action === 'accept'"
        :transaction="transaction"
        :busy="busy"
        compact
        :confirm-label="$t('accept.acceptInWallet')"
        @confirm="submit"
      />
      <p v-if="action === 'accept' && transaction" class="text-sm text-muted">
        {{ $t('accept.walletNext') }}
      </p>
      <UButton
        v-if="
          action === 'accept' && payloadConsent && !transaction && !busy && message && !blockReason
        "
        color="neutral"
        variant="outline"
        type="button"
        @click="buildPreview"
        >{{ $t('accept.retry') }}</UButton
      >
      <details class="mt-5 rounded-lg p-4 ring-1 ring-default">
        <summary class="cursor-pointer font-semibold">{{ $t('accept.technicalDetails') }}</summary>
        <MetadataList class="mt-4">
          <template v-if="fixedCredential">
            <dt>{{ $t('recipient.issuerWallet') }}</dt>
            <dd>
              <code class="break-all">{{ review.issuer }}</code>
            </dd>
          </template>
          <dt>Schema UID</dt>
          <dd>
            <code>{{ review.schemaUid }}</code>
          </dd>
          <dt>URI</dt>
          <dd>
            <code>{{ review.uri ?? '—' }}</code>
          </dd>
          <dt>{{ $t('accept.generation') }}</dt>
          <dd>
            <code>{{ review.generationId }}</code>
          </dd>
          <dt>{{ $t('accept.acceptedFlag') }}</dt>
          <dd>
            <code>{{ review.accepted }}</code>
          </dd>
          <template v-if="acceptanceReview?.payloadDigestHex">
            <dt>SHA-256</dt>
            <dd>
              <code>{{ acceptanceReview.payloadDigestHex }}</code>
            </dd>
          </template>
        </MetadataList>
        <VerificationGrid v-if="acceptanceReview" :report="acceptanceReview.report" :note="false" />
      </details>
    </UCard>

    <TransactionPreview
      v-if="action !== 'accept'"
      :transaction="transaction"
      :busy="busy"
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
    <UButton
      v-if="resultCredentialLink"
      color="neutral"
      variant="outline"
      data-testid="subject-result-permalink"
      :to="localePath(resultCredentialLink)"
    >
      {{ $t('accept.openPermalink') }}
    </UButton>
  </UContainer>
</template>
