<script setup lang="ts">
import { rippleTimeToIso } from '@xcs-protocol/core'
import { buildCredentialDelete } from '@xcs-protocol/sdk'
import type { CredentialDelete } from 'xrpl'
import type { WalletSubmissionResult } from '~/composables/useWallet'
import {
  credentialRevocationBlockReason,
  parseApiCredentialDetail,
  parseVerificationDimensions,
  type ApiCredentialDetail,
  type VerificationDimensions,
} from '~/utils/credentialReview'
import {
  assertLinkGeneration,
  assertLinkProfile,
  buildCredentialPermalink,
  singleRouteQueryValue,
} from '~/utils/operationLinks'
import { parseWalletCredentialTransactionError } from '~/utils/walletCompatibility'
import { decodeHexUtf8 } from '~/utils/serialization'

const route = useRoute()
const { t } = useI18n()
const { account, busy: walletBusy, prepare, signAndSubmit } = useWallet()
const { getActiveNetworkProfile, getCredential, verify } = useXcsApi()
const subject = ref(singleRouteQueryValue(route.query.subject))
const schemaUid = ref(singleRouteQueryValue(route.query.schema))
const linkedProfileId = ref(singleRouteQueryValue(route.query.profile))
const linkedGenerationId = ref(singleRouteQueryValue(route.query.generation))
const transaction = shallowRef<CredentialDelete | null>(null)
const credential = shallowRef<ApiCredentialDetail | null>(null)
const report = shallowRef<VerificationDimensions | null>(null)
const reviewProfileId = ref<string | null>(null)
const reviewBusy = ref(false)
const message = ref('')
const result = shallowRef<WalletSubmissionResult | null>(null)
const busy = computed(() => walletBusy.value || reviewBusy.value)
const messageDisplay = computed(() => {
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
const decodedUri = computed(() => {
  if (!credential.value?.uriHex) return null
  try {
    return decodeHexUtf8(credential.value.uriHex)
  } catch {
    return null
  }
})
const expiration = computed(() =>
  credential.value?.expiration === null || credential.value?.expiration === undefined
    ? null
    : rippleTimeToIso(credential.value.expiration),
)
let previewRevision = 0

function invalidatePreview() {
  previewRevision += 1
  transaction.value = null
  credential.value = null
  report.value = null
  reviewProfileId.value = null
  result.value = null
}

watch([subject, schemaUid, linkedProfileId, linkedGenerationId], invalidatePreview)
watch(
  [() => account.value?.address ?? '', () => account.value?.network.id ?? ''],
  invalidatePreview,
)
watch(
  () => [route.query.subject, route.query.schema, route.query.profile, route.query.generation],
  ([nextSubject, nextSchema, nextProfile, nextGeneration]) => {
    subject.value = singleRouteQueryValue(nextSubject)
    schemaUid.value = singleRouteQueryValue(nextSchema)
    linkedProfileId.value = singleRouteQueryValue(nextProfile)
    linkedGenerationId.value = singleRouteQueryValue(nextGeneration)
  },
)

async function fetchExactCredential(input: {
  issuer: string
  subject: string
  schemaUid: string
  profileId: string
  expectedGenerationId?: string | undefined
}) {
  const [rawCredential, rawReport] = await Promise.all([
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
  ])
  const exactCredential = parseApiCredentialDetail(rawCredential, input)
  assertLinkGeneration(input.expectedGenerationId, exactCredential.generationId)
  const dimensions = parseVerificationDimensions(rawReport)
  if (exactCredential.state !== dimensions.onChain) {
    throw new Error('CREDENTIAL_REVIEW_STATE_MISMATCH')
  }
  if (dimensions.generationId && dimensions.generationId !== exactCredential.generationId) {
    throw new Error('CREDENTIAL_REVIEW_GENERATION_MISMATCH')
  }
  const reason = credentialRevocationBlockReason(exactCredential)
  if (reason) throw new Error(reason)
  return { exactCredential, dimensions }
}

async function buildPreview() {
  invalidatePreview()
  message.value = ''
  if (!account.value) return void (message.value = 'WALLET_NOT_CONNECTED')

  reviewBusy.value = true
  const revision = previewRevision
  const issuerAddress = account.value.address
  const subjectAddress = subject.value
  const normalizedSchemaUid = schemaUid.value.toLowerCase()
  try {
    const profile = await getActiveNetworkProfile()
    assertLinkProfile(linkedProfileId.value || undefined, profile.profileId)
    const loaded = await fetchExactCredential({
      issuer: issuerAddress,
      subject: subjectAddress,
      schemaUid: normalizedSchemaUid,
      profileId: profile.profileId,
      ...(linkedGenerationId.value ? { expectedGenerationId: linkedGenerationId.value } : {}),
    })
    if (revision !== previewRevision) throw new Error('CREDENTIAL_REVIEW_CHANGED_DURING_LOAD')
    credential.value = loaded.exactCredential
    report.value = loaded.dimensions
    reviewProfileId.value = profile.profileId
    const raw = buildCredentialDelete({
      account: issuerAddress,
      issuer: issuerAddress,
      subject: subjectAddress,
      schemaUid: normalizedSchemaUid,
    })
    const prepared = (await prepare(raw, profile)) as CredentialDelete
    if (revision !== previewRevision) throw new Error('CREDENTIAL_REVIEW_CHANGED_DURING_BUILD')
    transaction.value = prepared
  } catch (error) {
    transaction.value = null
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    reviewBusy.value = false
  }
}

async function submit() {
  const preparedTransaction = transaction.value
  const expectedCredential = credential.value
  const expectedIssuer = account.value?.address
  const expectedSubject = subject.value
  const expectedSchemaUid = schemaUid.value.toLowerCase()
  const expectedLinkedProfileId = linkedProfileId.value
  const expectedLinkedGenerationId = linkedGenerationId.value
  const expectedReviewProfileId = reviewProfileId.value
  const expectedRevision = previewRevision
  if (!preparedTransaction || !expectedCredential || !expectedIssuer) {
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
        account.value?.address !== expectedIssuer ||
        subject.value !== expectedSubject ||
        schemaUid.value.toLowerCase() !== expectedSchemaUid ||
        linkedProfileId.value !== expectedLinkedProfileId ||
        linkedGenerationId.value !== expectedLinkedGenerationId ||
        reviewProfileId.value !== expectedReviewProfileId
      ) {
        throw new Error('CREDENTIAL_REVIEW_CHANGED_BEFORE_SIGNATURE')
      }
    }
    assertCurrent()
    const profile = await getActiveNetworkProfile()
    assertLinkProfile(expectedLinkedProfileId || undefined, profile.profileId)
    assertLinkProfile(expectedReviewProfileId ?? undefined, profile.profileId)
    const loaded = await fetchExactCredential({
      issuer: expectedIssuer,
      subject: expectedSubject,
      schemaUid: expectedSchemaUid,
      profileId: profile.profileId,
      ...(expectedLinkedGenerationId ? { expectedGenerationId: expectedLinkedGenerationId } : {}),
    })
    assertCurrent()
    if (loaded.exactCredential.generationId !== expectedCredential.generationId) {
      throw new Error('CREDENTIAL_GENERATION_CHANGED_BEFORE_SIGNATURE')
    }
    credential.value = loaded.exactCredential
    report.value = loaded.dimensions
    const response = await signAndSubmit(
      preparedTransaction,
      {
        action: 'credential-revoke',
        issuer: expectedIssuer,
        subject: expectedSubject,
        schemaUid: expectedSchemaUid,
        generationId: loaded.exactCredential.generationId,
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
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    reviewBusy.value = false
  }
}
</script>

<template>
  <section class="section-wrap form-page">
    <p class="eyebrow">Credential issuer</p>
    <h1>{{ $t('revoke.title') }}</h1>
    <p class="lead">{{ $t('revoke.description') }}</p>
    <div class="warning-box">{{ $t('revoke.warning') }}</div>

    <div class="form-card form-grid">
      <label for="revoke-subject">Subject</label>
      <input id="revoke-subject" v-model.trim="subject" placeholder="r…" :disabled="busy" />
      <label for="revoke-schema">Schema UID</label>
      <input
        id="revoke-schema"
        v-model.trim="schemaUid"
        pattern="[0-9a-fA-F]{64}"
        :disabled="busy"
      />
      <button class="button" type="button" :disabled="busy" @click="buildPreview">
        {{ busy ? $t('common.working') : $t('revoke.review') }}
      </button>
    </div>

    <div v-if="message" class="error-box" role="alert" data-testid="revoke-error">
      <strong>{{ messageDisplay }}</strong>
      <p v-if="messageIsLocalized">
        <code>{{ message }}</code>
      </p>
    </div>
    <article v-if="credential && report" class="form-card">
      <h2>{{ $t('revoke.exactCredential') }}</h2>
      <dl class="metadata-list">
        <dt>Issuer</dt>
        <dd>
          <code>{{ credential.issuer }}</code>
        </dd>
        <dt>Subject</dt>
        <dd>
          <code>{{ credential.subject }}</code>
        </dd>
        <dt>Schema UID</dt>
        <dd>
          <code>{{ credential.schemaUid }}</code>
        </dd>
        <dt>{{ $t('revoke.state') }}</dt>
        <dd><StatusPill :value="credential.state" /></dd>
        <dt>{{ $t('revoke.expiration') }}</dt>
        <dd>{{ expiration ?? $t('revoke.noExpiration') }}</dd>
        <dt>URI</dt>
        <dd>
          <code>{{ decodedUri ?? '—' }}</code>
        </dd>
        <dt>{{ $t('revoke.generation') }}</dt>
        <dd>
          <code>{{ credential.generationId }}</code>
        </dd>
      </dl>
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
      data-testid="revoke-result-permalink"
      :to="resultCredentialLink"
    >
      {{ $t('revoke.openPermalink') }}
    </NuxtLinkLocale>
  </section>
</template>
