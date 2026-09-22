<script setup lang="ts">
import type { ApiSchemaDetail } from '~/composables/useXcsApi'
import {
  assertPayloadFetchConsentCurrent,
  createPayloadFetchConsentToken,
  loadCredentialReview,
  loadCredentialReviewWithConsent,
  type CredentialReview,
  type PayloadFetchConsentToken,
} from '~/utils/credentialReview'
import {
  assertLinkGeneration,
  assertLinkProfile,
  singleRouteQueryValue,
} from '~/utils/operationLinks'
import { LOCAL_PAYLOAD_LOCATION } from '~/utils/localPayloadStore'
import { normalizedHex256 } from '~/utils/explorer'

const route = useRoute()
const localePath = useLocalePath()
const { t } = useI18n()
const { getActiveNetworkProfile, getCredential, getSchema, verify } = useXcsApi()
const localPayloadStore = useLocalPayloadStore()
const issuer = ref(singleRouteQueryValue(route.query.issuer))
const subject = ref(singleRouteQueryValue(route.query.subject))
const schemaUid = ref(singleRouteQueryValue(route.query.schema))
const linkedProfileId = ref(singleRouteQueryValue(route.query.profile))
const linkedGenerationId = ref(singleRouteQueryValue(route.query.generation))
const generationLookup = ref(singleRouteQueryValue(route.query.generation))
const generationLookupError = ref('')
const busy = ref(false)
const error = ref('')
const review = shallowRef<CredentialReview | null>(null)
const schemaDetail = shallowRef<ApiSchemaDetail | null>(null)
const payloadConsent = ref(false)
const payloadConsentToken = shallowRef<PayloadFetchConsentToken | null>(null)
let reviewRevision = 0

const payloadHost = computed(() => {
  if (!review.value?.uri) return null
  try {
    return localPayloadStore.inspectPayloadLocation(review.value.uri)
  } catch {
    return null
  }
})
const payloadUsesLocalStore = computed(() => payloadHost.value === LOCAL_PAYLOAD_LOCATION)
const payloadHostError = computed(() => {
  if (!review.value?.uri) return 'CREDENTIAL_URI_REQUIRED'
  try {
    localPayloadStore.inspectPayloadLocation(review.value.uri)
    return ''
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught)
  }
})
const payloadHostErrorMessage = computed(() =>
  payloadHostError.value === 'LOCAL_PAYLOAD_NOT_AVAILABLE_IN_BROWSER'
    ? t('verify.localPayloadUnavailable')
    : payloadHostError.value,
)

function invalidateReview() {
  reviewRevision += 1
  review.value = null
  schemaDetail.value = null
  payloadConsent.value = false
  payloadConsentToken.value = null
}

watch([issuer, subject, schemaUid, linkedProfileId, linkedGenerationId], invalidateReview)
watch(
  () => [
    route.query.issuer,
    route.query.subject,
    route.query.schema,
    route.query.profile,
    route.query.generation,
  ],
  ([nextIssuer, nextSubject, nextSchema, nextProfile, nextGeneration]) => {
    issuer.value = singleRouteQueryValue(nextIssuer)
    subject.value = singleRouteQueryValue(nextSubject)
    schemaUid.value = singleRouteQueryValue(nextSchema)
    linkedProfileId.value = singleRouteQueryValue(nextProfile)
    linkedGenerationId.value = singleRouteQueryValue(nextGeneration)
    generationLookup.value = singleRouteQueryValue(nextGeneration)
  },
)

async function openGeneration(): Promise<void> {
  generationLookupError.value = ''
  const normalized = normalizedHex256(generationLookup.value)
  if (normalized === undefined) {
    generationLookupError.value = t('verify.generationError')
    return
  }
  await navigateTo(localePath(`/credentials/${normalized}`))
}

async function loadExactMetadata(input: {
  issuer: string
  subject: string
  schemaUid: string
  profileId: string
  requireSchema: boolean
}): Promise<{ credentialReview: CredentialReview; schema: ApiSchemaDetail | null }> {
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
      (caught: unknown) => ({ error: caught }),
    ),
  ])
  if ('error' in schemaResult && input.requireSchema) throw schemaResult.error
  const schema = 'schema' in schemaResult ? schemaResult.schema : null
  const credentialReview = await loadCredentialReview({
    credential,
    report: metadataReport,
    issuer: input.issuer,
    subject: input.subject,
    schemaUid: input.schemaUid,
    ...(schema ? { schema: schema.resolved } : {}),
  })
  assertLinkGeneration(linkedGenerationId.value || undefined, credentialReview.generationId)
  return { credentialReview, schema }
}

async function loadMetadata() {
  invalidateReview()
  busy.value = true
  error.value = ''
  const revision = reviewRevision
  const expected = {
    issuer: issuer.value,
    subject: subject.value,
    schemaUid: schemaUid.value.toLowerCase(),
  }
  try {
    const profile = await getActiveNetworkProfile()
    assertLinkProfile(linkedProfileId.value || undefined, profile.profileId)
    const loaded = await loadExactMetadata({
      ...expected,
      profileId: profile.profileId,
      requireSchema: false,
    })
    if (revision !== reviewRevision) throw new Error('CREDENTIAL_REVIEW_CHANGED_DURING_LOAD')
    review.value = loaded.credentialReview
    schemaDetail.value = loaded.schema
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}

function setPayloadConsent(granted: boolean) {
  if (!granted) {
    payloadConsent.value = false
    payloadConsentToken.value = null
    return
  }
  try {
    if (!review.value) throw new Error('CREDENTIAL_PAYLOAD_CONSENT_REQUIRED')
    payloadConsentToken.value = createPayloadFetchConsentToken(review.value)
    payloadConsent.value = true
    error.value = ''
  } catch (caught) {
    payloadConsent.value = false
    payloadConsentToken.value = null
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

async function verifyPayload() {
  const displayedReview = review.value
  const consent = payloadConsentToken.value
  if (!displayedReview || !consent) {
    error.value = 'CREDENTIAL_PAYLOAD_CONSENT_REQUIRED'
    return
  }
  busy.value = true
  error.value = ''
  const revision = reviewRevision
  const expected = {
    issuer: issuer.value,
    subject: subject.value,
    schemaUid: schemaUid.value.toLowerCase(),
  }
  try {
    const profile = await getActiveNetworkProfile()
    assertLinkProfile(linkedProfileId.value || undefined, profile.profileId)
    const loaded = await loadExactMetadata({
      ...expected,
      profileId: profile.profileId,
      requireSchema: true,
    })
    if (revision !== reviewRevision) throw new Error('CREDENTIAL_REVIEW_CHANGED_DURING_LOAD')
    assertPayloadFetchConsentCurrent(loaded.credentialReview, consent)
    if (!loaded.schema) throw new Error('CREDENTIAL_SCHEMA_UNAVAILABLE')

    // Generation/profile/link checks happen above, before this browser contacts the issuer host.
    const localReview = await loadCredentialReviewWithConsent({
      credential: await getCredential(
        expected.issuer,
        expected.subject,
        expected.schemaUid,
        profile.profileId,
      ),
      report: await verify({ ...expected, resolvePayload: false }, profile.profileId),
      ...expected,
      schema: loaded.schema.resolved,
      consent,
      payloadReader: localPayloadStore.readPayload,
    })
    if (revision !== reviewRevision) throw new Error('CREDENTIAL_REVIEW_CHANGED_DURING_FETCH')
    if (!localReview.payload) throw new Error('CREDENTIAL_PAYLOAD_REVIEW_FAILED')

    // The API validates the parsed object only; it never receives a request to resolve the URI.
    const verifiedReport = await verify(
      { ...expected, payload: localReview.payload },
      profile.profileId,
    )
    const verifiedMetadata = await loadCredentialReview({
      credential: await getCredential(
        expected.issuer,
        expected.subject,
        expected.schemaUid,
        profile.profileId,
      ),
      report: verifiedReport,
      ...expected,
    })
    assertPayloadFetchConsentCurrent(verifiedMetadata, consent)
    if (verifiedMetadata.generationId !== displayedReview.generationId) {
      throw new Error('CREDENTIAL_GENERATION_CHANGED_DURING_VERIFICATION')
    }
    review.value = {
      ...verifiedMetadata,
      payload: localReview.payload,
      claims: localReview.claims,
      payloadDigestHex: localReview.payloadDigestHex,
      payloadByteLength: localReview.payloadByteLength,
      payloadCheckedAt: localReview.payloadCheckedAt,
    }
    schemaDetail.value = loaded.schema
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}

useSeoMeta({
  title: () => `${t('verify.title')} — XCS`,
  description: () => t('verify.description'),
  robots: 'index,follow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      :eyebrow="$t('nav.verify')"
      :title="$t('verify.title')"
      :lead="$t('verify.description')"
    />

    <UCard as="form" class="mb-6" novalidate @submit.prevent="openGeneration">
      <UFormField
        :label="$t('verify.generationLabel')"
        :help="$t('verify.generationHint')"
        :error="generationLookupError || undefined"
      >
        <div class="flex flex-wrap items-center gap-2">
          <UInput
            id="verify-generation"
            v-model.trim="generationLookup"
            name="generation"
            inputmode="text"
            autocomplete="off"
            pattern="[0-9a-fA-F]{64}"
            class="min-w-0 flex-1"
            :placeholder="$t('verify.generationPlaceholder')"
            :aria-describedby="generationLookupError ? 'verify-generation-error' : undefined"
          />
          <UButton type="submit">{{ $t('verify.openGeneration') }}</UButton>
        </div>
        <p
          v-if="generationLookupError"
          id="verify-generation-error"
          role="alert"
          class="mt-2 text-sm text-error"
        >
          {{ generationLookupError }}
        </p>
      </UFormField>
    </UCard>

    <UCollapsible :default-open="Boolean(issuer || subject || schemaUid)" class="mb-6">
      <UButton color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" block>
        <span class="min-w-0 text-left">
          {{ $t('verify.advancedTitle') }}
          <small class="text-muted">{{ $t('verify.advancedDescription') }}</small>
        </span>
      </UButton>
      <template #content>
        <UCard class="mt-3">
          <div class="grid gap-5">
            <UFormField label="Issuer">
              <UInput id="verify-issuer" v-model.trim="issuer" placeholder="r…" :disabled="busy" />
            </UFormField>
            <UFormField label="Subject">
              <UInput
                id="verify-subject"
                v-model.trim="subject"
                placeholder="r…"
                :disabled="busy"
              />
            </UFormField>
            <UFormField label="Schema UID">
              <UInput
                id="verify-schema"
                v-model.trim="schemaUid"
                pattern="[0-9a-fA-F]{64}"
                :disabled="busy"
              />
            </UFormField>
            <div>
              <UButton :disabled="busy" @click="loadMetadata">
                {{ busy ? $t('common.working') : $t('verify.loadMetadata') }}
              </UButton>
            </div>
          </div>
        </UCard>
      </template>
    </UCollapsible>

    <StatusBox v-if="error" tone="error">{{ error }}</StatusBox>

    <UCard v-if="review" class="mb-6">
      <template #header>
        <h2 class="text-xl font-semibold">{{ $t('verify.metadata') }}</h2>
      </template>
      <MetadataList>
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
        <dt>Generation ID</dt>
        <dd>
          <code>{{ review.generationId }}</code>
        </dd>
        <dt>URI</dt>
        <dd>
          <code>{{ review.uri ?? '—' }}</code>
        </dd>
      </MetadataList>

      <VerificationGrid :report="review.report" />

      <StatusBox v-if="!review.payload" tone="warning">
        <p>
          {{
            $t(
              payloadUsesLocalStore
                ? 'verify.localPayloadConsentIntro'
                : 'verify.payloadConsentIntro',
              { host: payloadHost ?? '—' },
            )
          }}
        </p>
        <StatusBox v-if="payloadHostError" tone="error">{{ payloadHostErrorMessage }}</StatusBox>
        <UCheckbox
          v-else-if="payloadHost"
          data-testid="payload-consent"
          :model-value="payloadConsent"
          :disabled="busy"
          :label="
            $t(payloadUsesLocalStore ? 'verify.localPayloadConsent' : 'verify.payloadConsent')
          "
          @update:model-value="setPayloadConsent(Boolean($event))"
        />
        <UButton
          data-testid="payload-fetch"
          color="neutral"
          variant="outline"
          :disabled="busy || !payloadConsent"
          @click="verifyPayload"
        >
          {{ $t(payloadUsesLocalStore ? 'verify.localFetch' : 'verify.fetch') }}
        </UButton>
      </StatusBox>
      <StatusBox v-else tone="success">
        {{ $t('verify.payloadChecked', { bytes: review.payloadByteLength ?? 0 }) }}
        <code>{{ review.payloadDigestHex }}</code>
      </StatusBox>
    </UCard>
  </UContainer>
</template>
