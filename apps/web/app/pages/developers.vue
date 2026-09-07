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
  <section class="section-wrap prose-page developers-page">
    <p class="eyebrow">{{ $t('nav.docs') }}</p>
    <h1>{{ $t('developers.title') }}</h1>
    <p class="lead">{{ $t('developers.description') }}</p>

    <section class="developer-runtime" aria-labelledby="developer-runtime-title">
      <div>
        <p class="eyebrow">Runtime</p>
        <h2 id="developer-runtime-title">{{ $t('developers.runtime.title') }}</h2>
      </div>
      <dl class="compact-metadata">
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
          <button v-else class="text-button" type="button" @click="retryActiveProfile">
            {{ $t('common.retry') }}
          </button>
        </dd>
        <dt>XRPL</dt>
        <dd>{{ $t('developers.runtime.testnet') }}</dd>
      </dl>
      <p v-if="profileError" class="error-box" role="alert">
        {{ $t('developers.runtime.unavailable') }}
      </p>
    </section>

    <div class="definition-grid developer-tools">
      <section>
        <h2>REST API</h2>
        <p>{{ $t('developers.rest') }}</p>
        <a class="button secondary compact" :href="apiDocumentationUrl" rel="noreferrer">
          OpenAPI
        </a>
      </section>
      <section>
        <h2>SDK</h2>
        <p>{{ $t('developers.sdk') }}</p>
        <code>@xcs-protocol/sdk</code>
      </section>
      <section>
        <h2>CLI</h2>
        <p>{{ $t('developers.cli') }}</p>
        <code>@xcs-protocol/cli</code>
      </section>
    </div>

    <section class="developer-quickstart" aria-labelledby="developer-quickstart-title">
      <p class="eyebrow">Quickstart</p>
      <h2 id="developer-quickstart-title">{{ $t('developers.quickstart.title') }}</h2>
      <p>{{ $t('developers.quickstart.intro') }}</p>
      <ol class="quickstart-steps">
        <li>{{ $t('developers.quickstart.stepGeneration') }}</li>
        <li>{{ $t('developers.quickstart.stepSchema') }}</li>
        <li>{{ $t('developers.quickstart.stepMetadata') }}</li>
        <li>{{ $t('developers.quickstart.stepPayload') }}</li>
      </ol>

      <form class="form-card form-grid" @submit.prevent="loadGeneration">
        <label for="developer-generation-id">Generation ID</label>
        <input
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
        <p class="form-hint">{{ $t('developers.quickstart.exactOnly') }}</p>
        <button
          class="button"
          type="submit"
          :disabled="busy || profilePending || !activeProfile"
          data-testid="developer-load-generation"
        >
          {{ busy ? $t('common.working') : $t('developers.quickstart.load') }}
        </button>
      </form>

      <div v-if="errorCode" class="error-box" role="alert" data-testid="developer-error">
        <strong>{{ developerError }}</strong>
        <code>{{ errorCode }}</code>
      </div>

      <template v-if="evidence">
        <section class="evidence-card" data-testid="developer-evidence">
          <h3>{{ $t('developers.quickstart.evidenceTitle') }}</h3>
          <dl class="compact-metadata">
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
          </dl>
          <p class="neutrality-note">{{ $t('developers.quickstart.generationGuard') }}</p>
        </section>

        <form
          v-if="evidence.review.uri !== null"
          class="form-card form-grid"
          @submit.prevent="verifyLocalPayload"
        >
          <label for="developer-local-payload">credential.json</label>
          <textarea
            id="developer-local-payload"
            v-model="payloadInput"
            name="payload"
            rows="12"
            spellcheck="false"
            :placeholder="$t('developers.quickstart.payloadPlaceholder')"
            :disabled="busy"
            data-testid="developer-payload-input"
          />
          <p class="form-hint">{{ $t('developers.quickstart.canonicalPayload') }}</p>
          <div class="warning-box developer-transmission-warning">
            <strong>{{ $t('developers.quickstart.transmissionTitle') }}</strong>
            <p>{{ $t('developers.quickstart.transmission') }}</p>
            <p>{{ $t('developers.quickstart.localAlternative') }}</p>
          </div>
          <button
            class="button"
            type="submit"
            :disabled="busy || payloadInput.length === 0"
            data-testid="developer-verify-payload"
          >
            {{ busy ? $t('common.working') : $t('developers.quickstart.verify') }}
          </button>
        </form>
        <p v-else class="neutrality-note" data-testid="developer-no-payload-uri">
          {{ $t('developers.quickstart.noPayloadUri') }}
        </p>

        <section
          v-if="payloadReport"
          aria-labelledby="developer-dimensions-title"
          data-testid="developer-dimensions"
        >
          <h3 id="developer-dimensions-title">{{ $t('developers.quickstart.resultTitle') }}</h3>
          <div class="verification-grid">
            <article data-testid="developer-dimension-on-chain">
              <span>{{ $t('verify.onChain') }}</span>
              <StatusPill :value="payloadReport.onChain" />
            </article>
            <article data-testid="developer-dimension-schema">
              <span>{{ $t('verify.schema') }}</span>
              <StatusPill :value="payloadReport.schema" />
            </article>
            <article data-testid="developer-dimension-payload">
              <span>{{ $t('verify.payload') }}</span>
              <StatusPill :value="payloadReport.payload" />
            </article>
            <article data-testid="developer-dimension-trust">
              <span>{{ $t('verify.trust') }}</span>
              <StatusPill :value="payloadReport.issuerTrust" />
            </article>
            <p class="verification-note">{{ $t('verify.trustNote') }}</p>
          </div>
        </section>
      </template>
    </section>

    <section v-if="snippets" class="developer-snippets" aria-labelledby="developer-code-title">
      <h2 id="developer-code-title">{{ $t('developers.code.title') }}</h2>
      <p>{{ $t('developers.code.intro') }}</p>
      <CodeSnippet
        :title="$t('developers.code.curl')"
        :code="snippets.curl"
        :copy-label="$t('developers.code.copy')"
        :copied-label="$t('developers.code.copied')"
        :copy-error-label="$t('developers.code.copyError')"
      />
      <p class="neutrality-note">{{ $t('developers.code.curlScope') }}</p>
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
      <div class="warning-box">
        <strong>{{ $t('developers.code.alphaTitle') }}</strong>
        <p>{{ $t('developers.code.alpha') }}</p>
      </div>
      <h3>{{ $t('developers.code.signerTitle') }}</h3>
      <p>{{ $t('developers.code.signer') }}</p>
      <CodeSnippet
        :title="$t('developers.code.signerExample')"
        :code="snippets.signer"
        :copy-label="$t('developers.code.copy')"
        :copied-label="$t('developers.code.copied')"
        :copy-error-label="$t('developers.code.copyError')"
      />
    </section>

    <section class="developer-catalog" aria-labelledby="developer-catalog-title">
      <h2 id="developer-catalog-title">{{ $t('developers.endpoints') }}</h2>
      <p>{{ $t('developers.catalog.intro') }}</p>
      <div class="endpoint-groups">
        <section>
          <h3>{{ $t('developers.catalog.aggregateTitle') }}</h3>
          <p>{{ $t('developers.catalog.aggregateIntro') }}</p>
          <ul>
            <li><code>GET /v1/networks</code></li>
            <li><code>GET /v1/networks/:network/status</code></li>
            <li><code>GET /v1/networks/:network/stats</code></li>
            <li><code>GET /v1/networks/:network/schemas</code></li>
            <li><code>GET /v1/networks/:network/search?q=</code></li>
            <li><code>GET /v1/networks/:network/activity</code></li>
          </ul>
        </section>
        <section>
          <h3>{{ $t('developers.catalog.exactTitle') }}</h3>
          <p>{{ $t('developers.catalog.exactIntro') }}</p>
          <ul>
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
        </section>
        <section>
          <h3>{{ $t('developers.catalog.optionalTitle') }}</h3>
          <p>{{ $t('developers.catalog.optionalIntro') }}</p>
          <ul>
            <li><code>POST /v1/pinning/challenges</code></li>
            <li><code>POST /v1/pinning/pins</code></li>
          </ul>
        </section>
      </div>
      <p class="privacy-panel">{{ $t('developers.catalog.privacy') }}</p>
    </section>

    <NuxtLinkLocale class="button" to="/learn">{{ $t('developers.learn') }}</NuxtLinkLocale>
  </section>
</template>
