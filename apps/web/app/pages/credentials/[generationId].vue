<script setup lang="ts">
import type { ApiCredentialGenerationDetail, ApiSchemaDetail } from '~/composables/useXcsApi'
import {
  assertExactCredentialConsentCurrent,
  bindCurrentReportToExactCredential,
  credentialClaimsToRows,
} from '~/utils/credentialEvidence'
import {
  createPayloadFetchConsentToken,
  loadCredentialMutationReview,
  loadCredentialReview,
  loadCredentialReviewWithConsent,
  type CredentialReview,
  type PayloadFetchConsentToken,
} from '~/utils/credentialReview'
import { decodeUtf8HexForDisplay, displayXrplTime } from '~/utils/explorer'
import {
  assertLinkProfile,
  buildCredentialAcceptLink,
  credentialPermalinkSubjectAction,
  singleRouteQueryValue,
} from '~/utils/operationLinks'
import { LOCAL_PAYLOAD_LOCATION } from '~/utils/localPayloadStore'

interface ExactCredentialEvidence {
  readonly profileId: string
  readonly detail: ApiCredentialGenerationDetail
  readonly schema: ApiSchemaDetail
  readonly payloadUri: string | null
  readonly currentGeneration: boolean
  readonly review: CredentialReview | null
  readonly verificationError: string | null
}

const route = useRoute()
const localePath = useLocalePath()
const generationId = computed(() => String(route.params.generationId).toLowerCase())
const linkedProfileId = computed(() => singleRouteQueryValue(route.query.profile))
const { locale, t } = useI18n()
const { getActiveNetworkProfile, getCredential, getCredentialGeneration, getSchema, verify } =
  useXcsApi()
const localPayloadStore = useLocalPayloadStore()
const payloadConsentToken = shallowRef<PayloadFetchConsentToken | null>(null)
const verifiedReview = shallowRef<CredentialReview | null>(null)
const verificationBusy = ref(false)
const verificationError = ref('')
const copyState = ref<'idle' | 'copied' | 'error'>('idle')
let verificationRevision = 0

function credentialReviewInput(detail: ApiCredentialGenerationDetail) {
  return { ...detail.generation, state: detail.state }
}

async function loadExactCredentialEvidence(
  expectedGenerationId: string,
  expectedProfileId = linkedProfileId.value,
): Promise<ExactCredentialEvidence> {
  const profile = await getActiveNetworkProfile()
  assertLinkProfile(expectedProfileId || undefined, profile.profileId)
  const detail = await getCredentialGeneration(expectedGenerationId, profile.profileId)
  const generation = detail.generation
  if (generation.generationId.toLowerCase() !== expectedGenerationId) {
    throw new Error('CREDENTIAL_GENERATION_ID_MISMATCH')
  }

  const payloadUri =
    generation.uriHex === null ? null : (decodeUtf8HexForDisplay(generation.uriHex) ?? null)
  const [schema, reportResult, currentResult] = await Promise.all([
    getSchema(generation.schemaUid, profile.profileId),
    verify(
      {
        issuer: generation.issuer,
        subject: generation.subject,
        schemaUid: generation.schemaUid,
        resolvePayload: false,
      },
      profile.profileId,
    ).then(
      (report) => ({ report }),
      () => ({ error: 'CREDENTIAL_CURRENT_VERIFICATION_UNAVAILABLE' as const }),
    ),
    getCredential(
      generation.issuer,
      generation.subject,
      generation.schemaUid,
      profile.profileId,
    ).then(
      (credential) => ({ credential }),
      () => ({ error: 'CREDENTIAL_CURRENT_LOOKUP_UNAVAILABLE' as const }),
    ),
  ])
  const currentGeneration =
    'credential' in currentResult &&
    loadCredentialMutationReview(currentResult.credential, {
      issuer: generation.issuer,
      subject: generation.subject,
      schemaUid: generation.schemaUid,
    }).generationId === expectedGenerationId
  if ('error' in reportResult) {
    return {
      profileId: profile.profileId,
      detail,
      schema,
      payloadUri,
      currentGeneration,
      review: null,
      verificationError: reportResult.error,
    }
  }

  const review = await bindCurrentReportToExactCredential({
    credential: credentialReviewInput(detail),
    report: reportResult.report,
    issuer: generation.issuer,
    subject: generation.subject,
    schemaUid: generation.schemaUid,
    schema: schema.resolved,
  })
  if (review) {
    return {
      profileId: profile.profileId,
      detail,
      schema,
      payloadUri,
      currentGeneration,
      review,
      verificationError: null,
    }
  }

  // Verification resolves the latest generation for the tuple. Keep historical
  // exact evidence readable without borrowing a replacement generation's report.
  return {
    profileId: profile.profileId,
    detail,
    schema,
    payloadUri,
    currentGeneration,
    review: null,
    verificationError: 'CREDENTIAL_GENERATION_NOT_CURRENT',
  }
}

const { data, pending, error, refresh } = await useAsyncData(
  () => `credential-generation:${generationId.value}:${linkedProfileId.value}`,
  () => loadExactCredentialEvidence(generationId.value, linkedProfileId.value),
)

const activeReview = computed(() => verifiedReview.value ?? data.value?.review ?? null)
const expiration = computed(() =>
  displayXrplTime(data.value?.detail.generation.expiration, locale.value),
)
const payloadHost = computed(() => {
  const uri = data.value?.payloadUri
  if (!uri) return null
  try {
    return localPayloadStore.inspectPayloadLocation(uri)
  } catch {
    return null
  }
})
const payloadUsesLocalStore = computed(() => payloadHost.value === LOCAL_PAYLOAD_LOCATION)
const payloadHostError = computed(() => {
  const uri = data.value?.payloadUri
  if (!uri) return 'CREDENTIAL_URI_REQUIRED'
  try {
    localPayloadStore.inspectPayloadLocation(uri)
    return ''
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught)
  }
})
const payloadHostErrorMessage = computed(() =>
  payloadHostError.value === 'LOCAL_PAYLOAD_NOT_AVAILABLE_IN_BROWSER'
    ? t('credential.localPayloadUnavailable')
    : payloadHostError.value,
)
const claimRows = computed(() => {
  const claims = verifiedReview.value?.claims
  const schema = data.value?.schema.resolved
  return claims && schema ? credentialClaimsToRows(schema, claims) : []
})
const subjectActionLink = computed(() => {
  const evidence = data.value
  if (!evidence?.currentGeneration) return null
  const state = evidence.detail.state
  const generation = evidence.detail.generation
  const action = credentialPermalinkSubjectAction({
    currentGeneration: evidence.currentGeneration,
    accepted: generation.accepted,
    state,
  })
  if (action === null) return null
  return buildCredentialAcceptLink({
    profileId: evidence.profileId,
    issuer: generation.issuer,
    schemaUid: generation.schemaUid,
    generationId: generation.generationId,
    action,
  })
})

function clearPayloadReview(): void {
  verificationRevision += 1
  payloadConsentToken.value = null
  verifiedReview.value = null
  verificationError.value = ''
  copyState.value = 'idle'
}

watch([generationId, linkedProfileId], clearPayloadReview)
watch(
  () => data.value,
  (next, previous) => {
    if (previous !== undefined && next !== previous) clearPayloadReview()
  },
)

function setPayloadConsent(granted: boolean): void {
  if (!granted) {
    clearPayloadReview()
    return
  }

  try {
    if (!data.value?.review) throw new Error('CREDENTIAL_PAYLOAD_CONSENT_REQUIRED')
    payloadConsentToken.value = createPayloadFetchConsentToken(data.value.review)
    verifiedReview.value = null
    verificationError.value = ''
  } catch (caught) {
    payloadConsentToken.value = null
    verificationError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

function assertVerificationFlowCurrent(input: {
  readonly revision: number
  readonly generationId: string
  readonly profileId: string
  readonly displayed: ExactCredentialEvidence
  readonly consent: PayloadFetchConsentToken
}): void {
  if (
    verificationRevision !== input.revision ||
    generationId.value !== input.generationId ||
    linkedProfileId.value !== input.profileId ||
    data.value !== input.displayed ||
    payloadConsentToken.value !== input.consent
  ) {
    throw new Error('CREDENTIAL_REVIEW_CHANGED_DURING_VERIFICATION')
  }
}

async function verifyPayload(): Promise<void> {
  const displayed = data.value
  const consent = payloadConsentToken.value
  if (!displayed?.review || !consent) {
    verificationError.value = 'CREDENTIAL_PAYLOAD_CONSENT_REQUIRED'
    return
  }

  verificationRevision += 1
  const revision = verificationRevision
  const expectedGenerationId = generationId.value
  const expectedProfileId = linkedProfileId.value
  verificationBusy.value = true
  verificationError.value = ''
  verifiedReview.value = null
  try {
    // Re-read the active profile, exact generation, tuple, URI, schema and metadata report.
    // None of these requests contact the issuer payload host.
    const latest = await loadExactCredentialEvidence(expectedGenerationId, expectedProfileId)
    assertVerificationFlowCurrent({
      revision,
      generationId: expectedGenerationId,
      profileId: expectedProfileId,
      displayed,
      consent,
    })
    if (!latest.review) throw new Error('CREDENTIAL_PAYLOAD_CONSENT_STALE')
    assertExactCredentialConsentCurrent({
      displayed: displayed.review,
      displayedProfileId: displayed.profileId,
      latest: latest.review,
      latestProfileId: latest.profileId,
      consent,
    })

    // This is the first and only issuer-host request in the flow.
    const localReview = await loadCredentialReviewWithConsent({
      credential: credentialReviewInput(latest.detail),
      report: latest.review.report,
      issuer: latest.review.issuer,
      subject: latest.review.subject,
      schemaUid: latest.review.schemaUid,
      schema: latest.schema.resolved,
      consent,
      payloadReader: localPayloadStore.readPayload,
    })
    assertVerificationFlowCurrent({
      revision,
      generationId: expectedGenerationId,
      profileId: expectedProfileId,
      displayed,
      consent,
    })
    if (!localReview.payload || !localReview.claims) {
      throw new Error('CREDENTIAL_PAYLOAD_REVIEW_FAILED')
    }

    // The API receives the locally parsed object and never resolves the issuer URI.
    const verifiedReport = await verify(
      {
        issuer: latest.review.issuer,
        subject: latest.review.subject,
        schemaUid: latest.review.schemaUid,
        payload: localReview.payload,
      },
      latest.profileId,
    )
    const verifiedMetadata = await loadCredentialReview({
      credential: credentialReviewInput(latest.detail),
      report: verifiedReport,
      issuer: latest.review.issuer,
      subject: latest.review.subject,
      schemaUid: latest.review.schemaUid,
      schema: latest.schema.resolved,
    })
    assertVerificationFlowCurrent({
      revision,
      generationId: expectedGenerationId,
      profileId: expectedProfileId,
      displayed,
      consent,
    })
    assertExactCredentialConsentCurrent({
      displayed: displayed.review,
      displayedProfileId: displayed.profileId,
      latest: verifiedMetadata,
      latestProfileId: latest.profileId,
      consent,
    })
    if (verifiedMetadata.report.payload !== 'valid') {
      throw new Error('CREDENTIAL_PAYLOAD_NOT_VALID')
    }

    verifiedReview.value = {
      ...verifiedMetadata,
      payload: localReview.payload,
      claims: localReview.claims,
      payloadDigestHex: localReview.payloadDigestHex,
      payloadByteLength: localReview.payloadByteLength,
      payloadCheckedAt: localReview.payloadCheckedAt,
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)
    verificationError.value = message
    if (message === 'CREDENTIAL_PAYLOAD_CONSENT_STALE') payloadConsentToken.value = null
  } finally {
    verificationBusy.value = false
  }
}

async function copyPermalink(): Promise<void> {
  copyState.value = 'idle'
  try {
    if (!import.meta.client || !navigator.clipboard) throw new Error('CLIPBOARD_UNAVAILABLE')
    await navigator.clipboard.writeText(window.location.href)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'error'
  }
}

const timelineItems = computed(() =>
  (data.value?.detail.timeline ?? []).map((event) => ({
    value: `${event.transactionHash}:${event.nodeIndex}`,
    title: t(`credential.events.${event.eventType}`),
    description: `${t('explorer.ledger', { ledger: event.ledgerIndex })} · tx ${event.transactionIndex}`,
    event,
  })),
)

useSeoMeta({
  title: () => (data.value ? `${data.value.schema.name} — XCS` : `${t('credential.title')} — XCS`),
  description: () => data.value?.schema.description ?? t('credential.description'),
  robots: 'noindex,nofollow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      eyebrow="Explorer · Credential"
      :title="data?.schema.name ?? $t('credential.title')"
      :lead="data?.schema.description ?? $t('credential.description')"
    />

    <EmptyState v-if="pending" loading />
    <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
    <template v-else-if="data">
      <div class="mb-6 flex flex-wrap items-center gap-3">
        <StatusPill :value="data.detail.state" />
        <UButton color="neutral" variant="outline" size="sm" @click="copyPermalink">
          {{ $t('credential.copyLink') }}
        </UButton>
        <span v-if="copyState === 'copied'" class="text-sm text-muted" role="status">
          {{ $t('credential.linkCopied') }}
        </span>
        <span v-else-if="copyState === 'error'" class="text-sm text-error" role="status">
          {{ $t('credential.copyFailed') }}
        </span>
        <UButton
          v-if="subjectActionLink"
          color="neutral"
          variant="outline"
          size="sm"
          data-testid="credential-subject-action"
          :to="localePath(subjectActionLink)"
        >
          {{
            $t(
              data.detail.generation.accepted
                ? 'credential.removeCredential'
                : data.detail.state === 'expired'
                  ? 'credential.rejectExpired'
                  : 'credential.managePending',
            )
          }}
        </UButton>
      </div>

      <MetadataList data-testid="explorer-metadata">
        <dt>{{ $t('credential.generation') }}</dt>
        <dd>
          <code>{{ data.detail.generation.generationId }}</code>
        </dd>
        <dt>{{ $t('credential.issuer') }}</dt>
        <dd>
          <code>{{ data.detail.generation.issuer }}</code>
        </dd>
        <dt>{{ $t('credential.subject') }}</dt>
        <dd>
          <code>{{ data.detail.generation.subject }}</code>
        </dd>
        <dt>{{ $t('credential.schema') }}</dt>
        <dd>
          <NuxtLink
            class="grid gap-1"
            :to="localePath(`/schemas/${data.detail.generation.schemaUid}`)"
          >
            <strong>{{ data.schema.name }}</strong>
            <code>{{ data.detail.generation.schemaUid }}</code>
          </NuxtLink>
        </dd>
        <dt>{{ $t('credential.createdLedger') }}</dt>
        <dd>
          {{ data.detail.generation.createdLedgerIndex }} · tx
          {{ data.detail.generation.createdTransactionIndex }}
        </dd>
        <dt>{{ $t('credential.lastLedger') }}</dt>
        <dd>{{ data.detail.generation.lastLedgerIndex }}</dd>
        <dt>{{ $t('credential.expiration') }}</dt>
        <dd>{{ expiration ?? $t('credential.noExpiration') }}</dd>
        <dt>{{ $t('credential.ledgerObject') }}</dt>
        <dd>
          <code>{{ data.detail.generation.ledgerObjectId }}</code>
        </dd>
      </MetadataList>

      <section aria-labelledby="credential-verification-title" class="mt-8">
        <h2 id="credential-verification-title" class="text-xl font-semibold">
          {{ $t('credential.verificationTitle') }}
        </h2>
        <VerificationGrid
          v-if="activeReview"
          :report="activeReview.report"
          test-id-prefix="credential-dimension"
          data-testid="credential-dimensions"
        />
        <StatusBox v-else tone="warning" data-testid="credential-verification-unavailable">
          {{
            $t(
              data.verificationError === 'CREDENTIAL_GENERATION_NOT_CURRENT'
                ? 'credential.generationNotCurrent'
                : 'credential.verificationUnavailable',
            )
          }}
        </StatusBox>
      </section>

      <UCard class="mb-6" aria-labelledby="credential-payload-title">
        <template #header>
          <h2 id="credential-payload-title" class="text-xl font-semibold">
            {{ $t('credential.payloadMetadata') }}
          </h2>
        </template>
        <p class="mb-4 text-toned">{{ $t('credential.payloadPrivacy') }}</p>
        <MetadataList>
          <dt>{{ $t('credential.payloadHost') }}</dt>
          <dd>
            <code>{{ payloadHost ?? '—' }}</code>
          </dd>
          <dt>{{ $t('credential.uri') }}</dt>
          <dd>
            <code>{{ data.payloadUri ?? $t('credential.noUri') }}</code>
          </dd>
        </MetadataList>

        <div
          v-if="data.review && !verifiedReview"
          class="mt-4 grid justify-items-start gap-3"
          data-testid="credential-consent"
        >
          <StatusBox v-if="payloadHostError" tone="error">{{ payloadHostErrorMessage }}</StatusBox>
          <template v-else>
            <p class="text-sm text-toned">
              {{
                $t(
                  payloadUsesLocalStore
                    ? 'credential.localPayloadConsentIntro'
                    : 'credential.payloadConsentIntro',
                  { host: payloadHost },
                )
              }}
            </p>
            <UCheckbox
              data-testid="payload-consent"
              :model-value="payloadConsentToken !== null"
              :disabled="verificationBusy"
              :label="
                $t(
                  payloadUsesLocalStore
                    ? 'credential.localPayloadConsent'
                    : 'credential.payloadConsent',
                )
              "
              @update:model-value="setPayloadConsent(Boolean($event))"
            />
            <UButton
              data-testid="payload-fetch"
              color="neutral"
              variant="outline"
              :disabled="verificationBusy || payloadConsentToken === null"
              @click="verifyPayload"
            >
              {{
                verificationBusy
                  ? $t('common.working')
                  : $t(
                      payloadUsesLocalStore
                        ? 'credential.localFetchAndVerifyPayload'
                        : 'credential.fetchAndVerifyPayload',
                    )
              }}
            </UButton>
          </template>
        </div>
        <StatusBox v-else-if="!data.review" tone="warning" class="mt-4">
          {{ $t('credential.payloadVerificationUnavailable') }}
        </StatusBox>
        <StatusBox
          v-if="verifiedReview"
          tone="success"
          data-testid="credential-payload-checked"
          class="mt-4"
        >
          {{ $t('credential.payloadChecked', { bytes: verifiedReview.payloadByteLength ?? 0 }) }}
          <code class="break-all">{{ verifiedReview.payloadDigestHex }}</code>
        </StatusBox>
        <StatusBox v-if="verificationError" tone="error" class="mt-4">
          {{ verificationError }}
        </StatusBox>
      </UCard>

      <section v-if="verifiedReview?.claims" aria-labelledby="credential-claims-title">
        <h2 id="credential-claims-title" class="text-xl font-semibold">
          {{ $t('credential.publicClaims') }}
        </h2>
        <p class="my-3 border-l-2 border-accented pl-3 text-sm text-toned">
          {{ $t('credential.claimsNote') }}
        </p>
        <div class="grid gap-3" data-testid="credential-claims">
          <article
            v-for="row in claimRows"
            :key="row.name"
            class="grid min-w-0 gap-3 rounded-[0.6rem] bg-elevated p-4 ring-1 ring-default sm:grid-cols-[minmax(0,0.65fr)_minmax(0,1.35fr)]"
            :class="{ 'opacity-60': !row.present }"
            :data-testid="`credential-claim-${row.name}`"
          >
            <div class="grid min-w-0 gap-1">
              <code class="font-mono break-words">{{ row.name }}</code>
              <small class="text-muted">{{ row.type }}</small>
            </div>
            <JsonBlock v-if="row.structured" :code="row.displayValue" class="my-0" />
            <span v-else class="min-w-0 break-words">{{ row.displayValue }}</span>
          </article>
        </div>
      </section>

      <UCard class="my-6">
        <template #header>
          <h2 class="text-xl font-semibold">{{ $t('credential.trustTitle') }}</h2>
        </template>
        <p class="text-toned">{{ $t('credential.trustNote') }}</p>
      </UCard>

      <h2 class="text-xl font-semibold">{{ $t('credential.timeline') }}</h2>
      <UTimeline v-if="timelineItems.length" :items="timelineItems" class="mt-4">
        <template #title="{ item }">
          <span class="flex flex-wrap items-center gap-2">
            <StatusPill :value="item.event.eventType" />
            <strong>{{ item.title }}</strong>
          </span>
        </template>
        <template #description="{ item }">
          <p>{{ item.description }}</p>
          <p v-if="item.event.deletionCause">
            <code class="break-all">{{ item.event.deletionCause }}</code>
          </p>
          <NuxtLink :to="localePath(`/transactions/${item.event.transactionHash}`)"
            ><code class="break-all">{{ item.event.transactionHash }}</code></NuxtLink
          >
        </template>
      </UTimeline>
      <EmptyState v-else>{{ $t('credential.timelineEmpty') }}</EmptyState>
    </template>
  </UContainer>
</template>
