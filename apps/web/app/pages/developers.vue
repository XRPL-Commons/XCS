<script setup lang="ts">
import { parseCredentialPayload, verifyPayloadIntegrity } from '@xcs-protocol/core'
import { credentialHexToUri } from '@xcs-protocol/sdk'
import type {
  ApiCredentialGenerationDetail,
  ApiSchemaDetail,
  VerificationResponse,
} from '~/composables/useXcsApi'
import {
  assertDeveloperExactGeneration,
  assertDeveloperSnapshotCurrent,
  buildDeveloperQuickstartSnippets,
  normalizeDeveloperApiBaseUrl,
  normalizeDeveloperGenerationId,
  parseDeveloperLocalPayload,
} from '~/utils/developerQuickstart'
import { loadCredentialReview, type CredentialReview } from '~/utils/credentialReview'

interface DeveloperEvidence {
  readonly profileId: string
  readonly detail: ApiCredentialGenerationDetail
  readonly schema: ApiSchemaDetail
  readonly review: CredentialReview
}

const config = useRuntimeConfig()
const localePath = useLocalePath()
const { t } = useI18n()
const { getActiveNetworkProfile, getCredentialGeneration, getSchema, verify } = useXcsApi()
const apiBaseUrl = normalizeDeveloperApiBaseUrl(String(config.public.apiBaseUrl))
const apiDocumentationUrl = computed(() => `${apiBaseUrl}/documentation`)

const {
  data: activeProfile,
  pending: profilePending,
  error: profileError,
  refresh: refreshProfile,
} = await useAsyncData('developers:active-network-profile', () => getActiveNetworkProfile())

const generationInput = ref('')
const payloadInput = ref('')
const evidence = shallowRef<DeveloperEvidence | null>(null)
const payloadReport = shallowRef<VerificationResponse | null>(null)
const busy = ref(false)
const errorCode = ref('')
let flowRevision = 0

const developerError = computed(() => {
  if (!errorCode.value) return ''
  if (errorCode.value === 'DEVELOPER_GENERATION_REPLACED') {
    return t('developers.errors.replaced')
  }
  if (errorCode.value === 'DEVELOPER_GENERATION_ID_INVALID') {
    return t('developers.errors.generationId')
  }
  if (
    errorCode.value === 'DEVELOPER_PAYLOAD_OBJECT_REQUIRED' ||
    errorCode.value.startsWith('PAYLOAD_') ||
    errorCode.value.startsWith('JSON_')
  ) {
    return t('developers.errors.payload')
  }
  if (errorCode.value === 'DEVELOPER_GENERATION_CHANGED') {
    return t('developers.errors.changed')
  }
  return t('developers.errors.generic')
})

const snippets = computed(() => {
  const loaded = evidence.value
  if (!activeProfile.value || !loaded) return null
  return buildDeveloperQuickstartSnippets({
    apiBaseUrl,
    profileId: loaded.profileId,
    generationId: loaded.review.generationId,
    ...(loaded.review.uri === null
      ? {}
      : {
          credential: {
            issuer: loaded.review.issuer,
            subject: loaded.review.subject,
            schemaUid: loaded.review.schemaUid,
            uri: loaded.review.uri,
            standaloneSchema: loaded.schema.definition.extends === undefined,
          },
        }),
  })
})

function credentialForReview(detail: ApiCredentialGenerationDetail) {
  return { ...detail.generation, state: detail.state }
}

function errorMessage(caught: unknown): string {
  if (
    typeof caught === 'object' &&
    caught !== null &&
    'code' in caught &&
    typeof caught.code === 'string'
  ) {
    return caught.code
  }
  return caught instanceof Error ? caught.message : String(caught)
}

function retryActiveProfile(): void {
  void refreshProfile()
}

function invalidateFlow(): void {
  flowRevision += 1
  evidence.value = null
  payloadReport.value = null
  payloadInput.value = ''
  errorCode.value = ''
}

watch(generationInput, invalidateFlow)
watch(payloadInput, () => {
  payloadReport.value = null
  if (
    errorCode.value === 'DEVELOPER_PAYLOAD_OBJECT_REQUIRED' ||
    errorCode.value.includes('PAYLOAD') ||
    errorCode.value.includes('JSON')
  ) {
    errorCode.value = ''
  }
})

function assertFlowCurrent(revision: number): void {
  if (revision !== flowRevision) throw new Error('DEVELOPER_FLOW_CHANGED')
}

function assertPayloadCurrent(payloadText: string): void {
  if (payloadInput.value !== payloadText) throw new Error('DEVELOPER_FLOW_CHANGED')
}

async function readExactEvidence(generationId: string): Promise<DeveloperEvidence> {
  const profile = await getActiveNetworkProfile()
  const detail = await getCredentialGeneration(generationId, profile.profileId)
  assertDeveloperExactGeneration(generationId, detail.generation.generationId)

  const schema = await getSchema(detail.generation.schemaUid, profile.profileId)
  if (schema.uid.toLowerCase() !== detail.generation.schemaUid.toLowerCase()) {
    throw new Error('DEVELOPER_SCHEMA_MISMATCH')
  }

  // This call never resolves the URI and therefore returns payload:not_checked.
  const report = await verify(
    {
      issuer: detail.generation.issuer,
      subject: detail.generation.subject,
      schemaUid: detail.generation.schemaUid,
      resolvePayload: false,
    },
    profile.profileId,
  )
  assertDeveloperExactGeneration(generationId, report.generationId)
  const review = await loadCredentialReview({
    credential: credentialForReview(detail),
    report,
    issuer: detail.generation.issuer,
    subject: detail.generation.subject,
    schemaUid: detail.generation.schemaUid,
    schema: schema.resolved,
  })
  return { profileId: profile.profileId, detail, schema, review }
}

async function loadGeneration(): Promise<void> {
  invalidateFlow()
  busy.value = true
  const revision = flowRevision
  try {
    const generationId = normalizeDeveloperGenerationId(generationInput.value)
    const loaded = await readExactEvidence(generationId)
    assertFlowCurrent(revision)
    evidence.value = loaded
  } catch (caught) {
    errorCode.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

function evidenceIdentity(value: DeveloperEvidence) {
  return {
    profileId: value.profileId,
    generationId: value.review.generationId,
    issuer: value.review.issuer,
    subject: value.review.subject,
    schemaUid: value.review.schemaUid,
    uri: value.review.uri,
  }
}

async function verifyLocalPayload(): Promise<void> {
  const displayed = evidence.value
  if (!displayed) return
  payloadReport.value = null
  errorCode.value = ''
  busy.value = true
  const revision = flowRevision
  const payloadText = payloadInput.value
  try {
    const generationId = normalizeDeveloperGenerationId(generationInput.value)
    parseDeveloperLocalPayload(payloadText)

    // Re-read profile, exact generation, schema and current metadata before
    // transmitting the locally supplied public claims to the verifier.
    const latest = await readExactEvidence(generationId)
    assertFlowCurrent(revision)
    assertPayloadCurrent(payloadText)
    assertDeveloperSnapshotCurrent(evidenceIdentity(displayed), evidenceIdentity(latest))
    if (latest.review.uri === null) throw new Error('PAYLOAD_URI_INVALID')

    const payload = parseCredentialPayload(payloadText, {
      issuer: latest.review.issuer,
      subject: latest.review.subject,
      schemaUid: latest.review.schemaUid,
      fields: latest.schema.resolved.fields,
    })
    const uri = credentialHexToUri(latest.detail.generation.uriHex ?? '')
    if (uri !== latest.review.uri || !verifyPayloadIntegrity(payloadText, uri).valid) {
      throw new Error('PAYLOAD_INTEGRITY_INVALID')
    }

    // Supplying payload and resolvePayload together is forbidden by the v0.1
    // API contract. Omitting resolvePayload keeps automatic URI resolution off.
    const report = await verify(
      {
        issuer: latest.review.issuer,
        subject: latest.review.subject,
        schemaUid: latest.review.schemaUid,
        payload,
      },
      latest.profileId,
    )
    assertDeveloperExactGeneration(generationId, report.generationId)
    const checkedReview = await loadCredentialReview({
      credential: credentialForReview(latest.detail),
      report,
      issuer: latest.review.issuer,
      subject: latest.review.subject,
      schemaUid: latest.review.schemaUid,
      schema: latest.schema.resolved,
    })
    assertFlowCurrent(revision)
    assertPayloadCurrent(payloadText)
    assertDeveloperSnapshotCurrent(evidenceIdentity(displayed), {
      ...evidenceIdentity(latest),
      generationId: checkedReview.generationId,
    })
    payloadReport.value = checkedReview.report
  } catch (caught) {
    errorCode.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

useSeoMeta({
  title: () => `${t('developers.title')} — XCS`,
  description: () => t('developers.description'),
  robots: 'index,follow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      :eyebrow="$t('nav.docs')"
      :title="$t('developers.title')"
      :lead="$t('developers.description')"
    />

    <UCard class="mb-6" aria-labelledby="developer-runtime-title">
      <template #header>
        <p class="text-xs font-semibold tracking-wide text-muted uppercase">Runtime</p>
        <h2 id="developer-runtime-title" class="text-xl font-semibold">
          {{ $t('developers.runtime.title') }}
        </h2>
      </template>
      <MetadataList compact>
        <dt>API</dt>
        <dd>
          <code data-testid="developer-api-base">{{ apiBaseUrl }}</code>
        </dd>
        <dt>{{ $t('developers.runtime.profile') }}</dt>
        <dd>
          <span v-if="profilePending">{{ $t('common.loading') }}</span>
          <code v-else-if="activeProfile" data-testid="developer-profile-id">
            {{ activeProfile.profileId }}
          </code>
          <UButton
            v-else
            color="neutral"
            variant="link"
            class="px-0"
            type="button"
            @click="retryActiveProfile"
          >
            {{ $t('common.retry') }}
          </UButton>
        </dd>
        <dt>XRPL</dt>
        <dd>{{ $t('developers.runtime.testnet') }}</dd>
      </MetadataList>
      <StatusBox v-if="profileError" tone="error" class="mt-4">
        {{ $t('developers.runtime.unavailable') }}
      </StatusBox>
    </UCard>

    <div class="mb-6 grid gap-4 sm:grid-cols-3">
      <UCard>
        <h2 class="mb-2 text-lg font-semibold">REST API</h2>
        <p class="mb-3 text-sm">{{ $t('developers.rest') }}</p>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :href="apiDocumentationUrl"
          rel="noreferrer"
        >
          OpenAPI
        </UButton>
      </UCard>
      <UCard>
        <h2 class="mb-2 text-lg font-semibold">SDK</h2>
        <p class="mb-3 text-sm">{{ $t('developers.sdk') }}</p>
        <code class="text-sm break-all">@xcs-protocol/sdk</code>
      </UCard>
      <UCard>
        <h2 class="mb-2 text-lg font-semibold">CLI</h2>
        <p class="mb-3 text-sm">{{ $t('developers.cli') }}</p>
        <code class="text-sm break-all">@xcs-protocol/cli</code>
      </UCard>
    </div>

    <section class="mb-6" aria-labelledby="developer-quickstart-title">
      <p class="text-xs font-semibold tracking-wide text-muted uppercase">Quickstart</p>
      <h2 id="developer-quickstart-title" class="mb-2 text-2xl font-semibold">
        {{ $t('developers.quickstart.title') }}
      </h2>
      <p class="mb-3">{{ $t('developers.quickstart.intro') }}</p>
      <ol class="mb-5 grid list-decimal gap-1 pl-5">
        <li>{{ $t('developers.quickstart.stepGeneration') }}</li>
        <li>{{ $t('developers.quickstart.stepSchema') }}</li>
        <li>{{ $t('developers.quickstart.stepMetadata') }}</li>
        <li>{{ $t('developers.quickstart.stepPayload') }}</li>
      </ol>

      <UCard as="form" class="mb-6" @submit.prevent="loadGeneration">
        <div class="grid gap-5">
          <UFormField label="Generation ID" :help="$t('developers.quickstart.exactOnly')">
            <UInput
              id="developer-generation-id"
              v-model.trim="generationInput"
              name="generationId"
              inputmode="text"
              autocomplete="off"
              pattern="[0-9a-fA-F]{64}"
              :placeholder="$t('developers.quickstart.generationPlaceholder')"
              :disabled="busy"
              data-testid="developer-generation-input"
            />
          </UFormField>
          <div>
            <UButton
              type="submit"
              :disabled="busy || profilePending || !activeProfile"
              data-testid="developer-load-generation"
            >
              {{ busy ? $t('common.working') : $t('developers.quickstart.load') }}
            </UButton>
          </div>
        </div>
      </UCard>

      <StatusBox
        v-if="errorCode"
        tone="error"
        role="alert"
        data-testid="developer-error"
        :title="developerError"
      >
        <code>{{ errorCode }}</code>
      </StatusBox>

      <template v-if="evidence">
        <UCard class="mb-6" data-testid="developer-evidence">
          <template #header>
            <h3 class="text-lg font-semibold">
              {{ $t('developers.quickstart.evidenceTitle') }}
            </h3>
          </template>
          <MetadataList compact>
            <dt>Generation ID</dt>
            <dd>
              <code>{{ evidence.review.generationId }}</code>
            </dd>
            <dt>{{ $t('credential.issuer') }}</dt>
            <dd>
              <code>{{ evidence.review.issuer }}</code>
            </dd>
            <dt>{{ $t('credential.subject') }}</dt>
            <dd>
              <code>{{ evidence.review.subject }}</code>
            </dd>
            <dt>Schema</dt>
            <dd>
              <strong>{{ evidence.schema.name }}</strong>
              <code>{{ evidence.review.schemaUid }}</code>
            </dd>
            <dt>{{ $t('developers.quickstart.metadataPayload') }}</dt>
            <dd><StatusPill :value="evidence.review.report.payload" /></dd>
          </MetadataList>
          <p class="mt-4 border-l-2 border-accented pl-3 text-sm text-toned">
            {{ $t('developers.quickstart.generationGuard') }}
          </p>
        </UCard>

        <UCard
          v-if="evidence.review.uri !== null"
          as="form"
          class="mb-6"
          @submit.prevent="verifyLocalPayload"
        >
          <div class="grid gap-5">
            <UFormField
              label="credential.json"
              :help="$t('developers.quickstart.canonicalPayload')"
            >
              <UTextarea
                id="developer-local-payload"
                v-model="payloadInput"
                name="payload"
                :rows="12"
                spellcheck="false"
                :placeholder="$t('developers.quickstart.payloadPlaceholder')"
                :disabled="busy"
                data-testid="developer-payload-input"
              />
            </UFormField>
            <StatusBox tone="warning" :title="$t('developers.quickstart.transmissionTitle')">
              <p>{{ $t('developers.quickstart.transmission') }}</p>
              <p>{{ $t('developers.quickstart.localAlternative') }}</p>
            </StatusBox>
            <div>
              <UButton
                type="submit"
                :disabled="busy || payloadInput.length === 0"
                data-testid="developer-verify-payload"
              >
                {{ busy ? $t('common.working') : $t('developers.quickstart.verify') }}
              </UButton>
            </div>
          </div>
        </UCard>
        <p
          v-else
          class="border-l-2 border-accented pl-3 text-sm text-toned"
          data-testid="developer-no-payload-uri"
        >
          {{ $t('developers.quickstart.noPayloadUri') }}
        </p>

        <section
          v-if="payloadReport"
          aria-labelledby="developer-dimensions-title"
          data-testid="developer-dimensions"
        >
          <h3 id="developer-dimensions-title" class="text-lg font-semibold">
            {{ $t('developers.quickstart.resultTitle') }}
          </h3>
          <VerificationGrid :report="payloadReport" test-id-prefix="developer-dimension" />
        </section>
      </template>
    </section>

    <section v-if="snippets" class="mb-6" aria-labelledby="developer-code-title">
      <h2 id="developer-code-title" class="mb-2 text-2xl font-semibold">
        {{ $t('developers.code.title') }}
      </h2>
      <p class="mb-3">{{ $t('developers.code.intro') }}</p>
      <CodeSnippet
        :title="$t('developers.code.curl')"
        :code="snippets.curl"
        :copy-label="$t('developers.code.copy')"
        :copied-label="$t('developers.code.copied')"
        :copy-error-label="$t('developers.code.copyError')"
      />
      <p class="my-3 border-l-2 border-accented pl-3 text-sm text-toned">
        {{ $t('developers.code.curlScope') }}
      </p>
      <CodeSnippet
        :title="$t('developers.code.typescript')"
        :code="snippets.typescript"
        :copy-label="$t('developers.code.copy')"
        :copied-label="$t('developers.code.copied')"
        :copy-error-label="$t('developers.code.copyError')"
      />
      <CodeSnippet
        v-if="snippets.cli"
        :title="$t('developers.code.cli')"
        :code="snippets.cli"
        :copy-label="$t('developers.code.copy')"
        :copied-label="$t('developers.code.copied')"
        :copy-error-label="$t('developers.code.copyError')"
      />
      <StatusBox tone="warning" :title="$t('developers.code.alphaTitle')">
        <p>{{ $t('developers.code.alpha') }}</p>
      </StatusBox>
      <h3 class="mt-6 mb-2 text-lg font-semibold">{{ $t('developers.code.signerTitle') }}</h3>
      <p class="mb-3">{{ $t('developers.code.signer') }}</p>
      <CodeSnippet
        :title="$t('developers.code.signerExample')"
        :code="snippets.signer"
        :copy-label="$t('developers.code.copy')"
        :copied-label="$t('developers.code.copied')"
        :copy-error-label="$t('developers.code.copyError')"
      />
    </section>

    <section class="mb-6" aria-labelledby="developer-catalog-title">
      <h2 id="developer-catalog-title" class="mb-2 text-2xl font-semibold">
        {{ $t('developers.endpoints') }}
      </h2>
      <p class="mb-4">{{ $t('developers.catalog.intro') }}</p>
      <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <UCard>
          <h3 class="mb-2 text-lg font-semibold">{{ $t('developers.catalog.aggregateTitle') }}</h3>
          <p class="mb-3 text-sm">{{ $t('developers.catalog.aggregateIntro') }}</p>
          <ul class="grid gap-1 text-sm [&_code]:break-all">
            <li><code>GET /v1/networks</code></li>
            <li><code>GET /v1/networks/:network/status</code></li>
            <li><code>GET /v1/networks/:network/stats</code></li>
            <li><code>GET /v1/networks/:network/schemas</code></li>
            <li><code>GET /v1/networks/:network/search?q=</code></li>
            <li><code>GET /v1/networks/:network/activity</code></li>
          </ul>
        </UCard>
        <UCard>
          <h3 class="mb-2 text-lg font-semibold">{{ $t('developers.catalog.exactTitle') }}</h3>
          <p class="mb-3 text-sm">{{ $t('developers.catalog.exactIntro') }}</p>
          <ul class="grid gap-1 text-sm [&_code]:break-all">
            <li><code>GET /v1/networks/:network/schemas/:uid</code></li>
            <li>
              <code>GET /v1/networks/:network/schema-registrations/:transactionHash</code>
            </li>
            <li>
              <code>GET /v1/networks/:network/credential-generations/:generationId</code>
            </li>
            <li><code>GET /v1/networks/:network/transactions/:transactionHash</code></li>
            <li>
              <code>GET /v1/networks/:network/credentials/:issuer/:subject/:schemaUid</code>
            </li>
            <li>
              <code>GET /v1/networks/:network/credentials/:issuer/:subject/:schemaUid/events</code>
            </li>
            <li>
              <code
                >GET
                /v1/networks/:network/credentials/:issuer/:subject/:schemaUid/events/:transactionHash</code
              >
            </li>
            <li><code>POST /v1/verify</code></li>
          </ul>
        </UCard>
        <UCard>
          <h3 class="mb-2 text-lg font-semibold">{{ $t('developers.catalog.optionalTitle') }}</h3>
          <p class="mb-3 text-sm">{{ $t('developers.catalog.optionalIntro') }}</p>
          <ul class="grid gap-1 text-sm [&_code]:break-all">
            <li><code>POST /v1/pinning/challenges</code></li>
            <li><code>POST /v1/pinning/pins</code></li>
          </ul>
        </UCard>
      </div>
      <p class="mt-4 border-l-2 border-accented pl-3 text-sm text-toned">
        {{ $t('developers.catalog.privacy') }}
      </p>
    </section>

    <UButton :to="localePath('/learn')">{{ $t('developers.learn') }}</UButton>
  </UContainer>
</template>
