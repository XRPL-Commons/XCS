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

useSeoMeta({
  title: () => (data.value ? `${data.value.schema.name} — XCS` : `${t('credential.title')} — XCS`),
  description: () => data.value?.schema.description ?? t('credential.description'),
  robots: 'noindex,nofollow',
})
</script>

<template>
  <section class="section-wrap prose-page">
    <p class="eyebrow">Explorer · Credential</p>
    <h1>{{ data?.schema.name ?? $t('credential.title') }}</h1>
    <p class="lead">{{ data?.schema.description ?? $t('credential.description') }}</p>

    <p v-if="pending" class="loading-state" role="status">{{ $t('common.loading') }}</p>
    <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
    <template v-else-if="data">
      <div class="credential-heading-actions">
        <StatusPill :value="data.detail.state" />
        <button class="button secondary compact" type="button" @click="copyPermalink">
          {{ $t('credential.copyLink') }}
        </button>
        <span v-if="copyState === 'copied'" class="muted" role="status">
          {{ $t('credential.linkCopied') }}
        </span>
        <span v-else-if="copyState === 'error'" class="error-text" role="status">
          {{ $t('credential.copyFailed') }}
        </span>
        <NuxtLinkLocale
          v-if="subjectActionLink"
          class="button secondary compact"
          data-testid="credential-subject-action"
          :to="subjectActionLink"
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
        </NuxtLinkLocale>
      </div>

      <dl class="metadata-list explorer-metadata">
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
          <NuxtLinkLocale
            class="credential-schema-reference"
            :to="`/schemas/${data.detail.generation.schemaUid}`"
          >
            <strong>{{ data.schema.name }}</strong>
            <code>{{ data.detail.generation.schemaUid }}</code>
          </NuxtLinkLocale>
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
      </dl>

      <section aria-labelledby="credential-verification-title">
        <h2 id="credential-verification-title">{{ $t('credential.verificationTitle') }}</h2>
        <div v-if="activeReview" class="verification-grid" data-testid="credential-dimensions">
          <article data-testid="credential-dimension-on-chain">
            <span>{{ $t('verify.onChain') }}</span>
            <StatusPill :value="activeReview.report.onChain" />
          </article>
          <article data-testid="credential-dimension-schema">
            <span>{{ $t('verify.schema') }}</span>
            <StatusPill :value="activeReview.report.schema" />
          </article>
          <article data-testid="credential-dimension-payload">
            <span>{{ $t('verify.payload') }}</span>
            <StatusPill :value="activeReview.report.payload" />
          </article>
          <article data-testid="credential-dimension-trust">
            <span>{{ $t('verify.trust') }}</span>
            <StatusPill :value="activeReview.report.issuerTrust" />
          </article>
          <p class="verification-note">{{ $t('verify.trustNote') }}</p>
        </div>
        <div v-else class="warning-box" data-testid="credential-verification-unavailable">
          {{
            $t(
              data.verificationError === 'CREDENTIAL_GENERATION_NOT_CURRENT'
                ? 'credential.generationNotCurrent'
                : 'credential.verificationUnavailable',
            )
          }}
        </div>
      </section>

      <section class="privacy-panel" aria-labelledby="credential-payload-title">
        <h2 id="credential-payload-title">{{ $t('credential.payloadMetadata') }}</h2>
        <p>{{ $t('credential.payloadPrivacy') }}</p>
        <dl class="metadata-list">
          <dt>{{ $t('credential.payloadHost') }}</dt>
          <dd>
            <code>{{ payloadHost ?? '—' }}</code>
          </dd>
          <dt>{{ $t('credential.uri') }}</dt>
          <dd>
            <code>{{ data.payloadUri ?? $t('credential.noUri') }}</code>
          </dd>
        </dl>

        <div
          v-if="data.review && !verifiedReview"
          class="credential-consent"
          data-testid="credential-consent"
        >
          <div v-if="payloadHostError" class="error-box">{{ payloadHostErrorMessage }}</div>
          <template v-else>
            <p>
              {{
                $t(
                  payloadUsesLocalStore
                    ? 'credential.localPayloadConsentIntro'
                    : 'credential.payloadConsentIntro',
                  { host: payloadHost },
                )
              }}
            </p>
            <label>
              <input
                data-testid="payload-consent"
                type="checkbox"
                :checked="payloadConsentToken !== null"
                :disabled="verificationBusy"
                @change="setPayloadConsent(($event.target as HTMLInputElement).checked)"
              />
              {{
                $t(
                  payloadUsesLocalStore
                    ? 'credential.localPayloadConsent'
                    : 'credential.payloadConsent',
                )
              }}
            </label>
            <button
              data-testid="payload-fetch"
              class="button secondary"
              type="button"
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
            </button>
          </template>
        </div>
        <div v-else-if="!data.review" class="warning-box">
          {{ $t('credential.payloadVerificationUnavailable') }}
        </div>
        <div v-if="verifiedReview" class="success-box" data-testid="credential-payload-checked">
          {{ $t('credential.payloadChecked', { bytes: verifiedReview.payloadByteLength ?? 0 }) }}
          <code>{{ verifiedReview.payloadDigestHex }}</code>
        </div>
        <div v-if="verificationError" class="error-box" role="alert">
          {{ verificationError }}
        </div>
      </section>

      <section v-if="verifiedReview?.claims" aria-labelledby="credential-claims-title">
        <h2 id="credential-claims-title">{{ $t('credential.publicClaims') }}</h2>
        <p class="neutrality-note">{{ $t('credential.claimsNote') }}</p>
        <div class="credential-claim-list" data-testid="credential-claims">
          <article
            v-for="row in claimRows"
            :key="row.name"
            class="credential-claim-row"
            :class="{ 'credential-claim-absent': !row.present }"
            :data-testid="`credential-claim-${row.name}`"
          >
            <div>
              <code>{{ row.name }}</code>
              <small>{{ row.type }}</small>
            </div>
            <pre v-if="row.structured">{{ row.displayValue }}</pre>
            <span v-else>{{ row.displayValue }}</span>
          </article>
        </div>
      </section>

      <section class="neutrality-panel">
        <h2>{{ $t('credential.trustTitle') }}</h2>
        <p>{{ $t('credential.trustNote') }}</p>
      </section>

      <h2>{{ $t('credential.timeline') }}</h2>
      <ol v-if="data.detail.timeline.length" class="timeline-list">
        <li
          v-for="event in data.detail.timeline"
          :key="`${event.transactionHash}:${event.nodeIndex}`"
        >
          <span class="timeline-marker" aria-hidden="true"></span>
          <div>
            <StatusPill :value="event.eventType" />
            <strong>{{ $t(`credential.events.${event.eventType}`) }}</strong>
            <p>
              {{ $t('explorer.ledger', { ledger: event.ledgerIndex }) }} · tx
              {{ event.transactionIndex }}
            </p>
            <p v-if="event.deletionCause">
              <code>{{ event.deletionCause }}</code>
            </p>
            <NuxtLinkLocale :to="`/transactions/${event.transactionHash}`">
              <code>{{ event.transactionHash }}</code>
            </NuxtLinkLocale>
          </div>
        </li>
      </ol>
      <div v-else class="empty-state">{{ $t('credential.timelineEmpty') }}</div>
    </template>
  </section>
</template>

<style scoped>
.credential-heading-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.credential-schema-reference {
  display: grid;
  gap: 0.25rem;
}

.credential-consent {
  display: grid;
  gap: 0.85rem;
  margin-top: 1rem;
}

.credential-consent .button {
  justify-self: start;
}

.credential-claim-list {
  display: grid;
  gap: 0.7rem;
  margin: 1rem 0 1.5rem;
}

.credential-claim-row {
  display: grid;
  grid-template-columns: minmax(10rem, 0.65fr) minmax(16rem, 1.35fr);
  gap: 1rem;
  align-items: start;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  background: white;
}

.credential-claim-row > div {
  display: grid;
  gap: 0.35rem;
}

.credential-claim-row small,
.credential-claim-absent {
  color: var(--muted);
}

.credential-claim-row pre {
  max-height: 18rem;
  margin: 0;
}

.error-text {
  color: var(--danger);
}

@media (max-width: 700px) {
  .credential-claim-row {
    grid-template-columns: 1fr;
  }
}
</style>
