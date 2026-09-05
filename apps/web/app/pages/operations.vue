<script setup lang="ts">
import {
  canAbandonOperation,
  canReconfirmOperation,
  canRetryOperation,
  operationBusinessEvidence,
  operationBusinessConfirmation,
  serializeOperationReceipts,
  type StoredOperation,
} from '~/utils/operationJournal'
import { buildCredentialAcceptLink, buildCredentialPermalink } from '~/utils/operationLinks'

const { operations, busy, loadOperations, retryOperation, reconfirmOperation, abandonOperation } =
  useWallet()
const pageError = ref('')
const resultMessage = ref('')
const resultTone = ref<'success' | 'notice' | 'error'>('notice')

async function refresh() {
  pageError.value = ''
  try {
    await loadOperations()
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : String(error)
  }
}

async function retry(operationId: string) {
  pageError.value = ''
  resultMessage.value = ''
  resultTone.value = 'notice'
  try {
    const result = await retryOperation(operationId)
    resultMessage.value = `XRPL_VALIDATED:${result.txHash} XCS:${result.businessConfirmation ?? 'pending'}`
    resultTone.value =
      result.businessConfirmation === 'confirmed'
        ? 'success'
        : result.businessConfirmation === 'mismatch' || result.businessConfirmation === 'rejected'
          ? 'error'
          : 'notice'
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : String(error)
  }
}

async function abandon(operationId: string) {
  pageError.value = ''
  resultMessage.value = ''
  resultTone.value = 'notice'
  try {
    await abandonOperation(operationId)
    resultMessage.value = 'OPERATION_ABANDONED'
    resultTone.value = 'success'
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : String(error)
  }
}

async function reconfirm(operationId: string) {
  pageError.value = ''
  resultMessage.value = ''
  resultTone.value = 'notice'
  try {
    const confirmation = await reconfirmOperation(operationId)
    resultMessage.value = `BUSINESS_CONFIRMATION:${confirmation}`
    resultTone.value =
      confirmation === 'confirmed'
        ? 'success'
        : confirmation === 'mismatch' || confirmation === 'rejected'
          ? 'error'
          : 'notice'
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : String(error)
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(
    new Date(value),
  )
}

function downloadReceipts() {
  const content = serializeOperationReceipts(operations.value)
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `xcs-operation-receipts-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function operationAcceptLink(operation: StoredOperation): string | null {
  const business = operation.business
  const evidence = operationBusinessEvidence(operation)
  if (
    operationBusinessConfirmation(operation) !== 'confirmed' ||
    business?.action !== 'credential-issue' ||
    !evidence?.generationId
  ) {
    return null
  }
  return buildCredentialAcceptLink({
    profileId: operation.profileId,
    issuer: business.issuer,
    schemaUid: business.schemaUid,
    generationId: evidence.generationId,
  })
}

function operationCredentialLink(operation: StoredOperation): string | null {
  if (operationBusinessConfirmation(operation) !== 'confirmed') return null
  const generationId = operationBusinessEvidence(operation)?.generationId
  return generationId
    ? buildCredentialPermalink({ profileId: operation.profileId, generationId })
    : null
}

onMounted(refresh)
</script>

<template>
  <section class="section-wrap form-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">XRPL submission journal</p>
        <h1>{{ $t('operations.title') }}</h1>
        <p class="lead">{{ $t('operations.description') }}</p>
      </div>
      <div class="button-row">
        <button
          class="button secondary"
          type="button"
          :disabled="busy || operations.length === 0"
          @click="downloadReceipts"
        >
          {{ $t('operations.export') }}
        </button>
        <button class="button secondary" type="button" :disabled="busy" @click="refresh">
          {{ $t('operations.refresh') }}
        </button>
      </div>
    </div>

    <div class="warning-box">{{ $t('operations.localOnly') }}</div>
    <div v-if="pageError" class="error-box">{{ pageError }}</div>
    <div v-if="resultMessage" :class="`${resultTone}-box`">
      {{ resultMessage }}
    </div>
    <div v-if="operations.length === 0" class="empty-state">{{ $t('operations.empty') }}</div>

    <div v-else class="operation-list">
      <article
        v-for="operation in operations"
        :key="operation.operationId"
        class="form-card"
        data-testid="operation-card"
      >
        <div class="operation-heading">
          <div>
            <p class="eyebrow">{{ operation.transactionType }}</p>
            <h2>{{ operation.stage }}</h2>
          </div>
          <div class="button-row">
            <button
              v-if="canRetryOperation(operation)"
              class="button"
              type="button"
              :disabled="busy"
              @click="retry(operation.operationId)"
            >
              {{ $t('operations.retry') }}
            </button>
            <button
              v-if="canReconfirmOperation(operation)"
              class="button secondary"
              data-testid="operation-reconfirm"
              type="button"
              :disabled="busy"
              @click="reconfirm(operation.operationId)"
            >
              {{ $t('operations.reconfirm') }}
            </button>
            <button
              v-if="canAbandonOperation(operation)"
              class="button secondary"
              type="button"
              :disabled="busy"
              @click="abandon(operation.operationId)"
            >
              {{ $t('operations.abandon') }}
            </button>
          </div>
        </div>
        <dl class="metadata-list">
          <dt>{{ $t('operations.hash') }}</dt>
          <dd>
            <code>{{ operation.txHash ?? '—' }}</code>
          </dd>
          <dt>{{ $t('operations.profile') }}</dt>
          <dd>
            <code>{{ operation.profileId }}</code>
          </dd>
          <dt>{{ $t('operations.updated') }}</dt>
          <dd>{{ formatDate(operation.updatedAt) }}</dd>
          <dt>{{ $t('operations.lastLedger') }}</dt>
          <dd>{{ operation.lastLedgerSequence ?? '—' }}</dd>
          <dt>{{ $t('operations.result') }}</dt>
          <dd>
            <code>{{ operation.engineResult ?? '—' }}</code>
          </dd>
          <template v-if="operation.business">
            <dt>{{ $t('operations.action') }}</dt>
            <dd>
              <code>{{ operation.business.action }}</code>
            </dd>
            <template v-if="operation.business.action === 'schema-register'">
              <dt>Publisher</dt>
              <dd>
                <code>{{ operation.business.publisher ?? '—' }}</code>
              </dd>
              <dt>{{ $t('operations.schemaHash') }}</dt>
              <dd>
                <code>{{ operation.business.schemaDigestHex ?? '—' }}</code>
              </dd>
              <dt>{{ $t('operations.memoBytes') }}</dt>
              <dd>{{ operation.business.memoByteLength ?? '—' }}</dd>
            </template>
            <template v-else>
              <dt>Issuer</dt>
              <dd>
                <code>{{ operation.business.issuer }}</code>
              </dd>
              <dt>Subject</dt>
              <dd>
                <code>{{ operation.business.subject }}</code>
              </dd>
              <dt>Schema UID</dt>
              <dd>
                <code>{{ operation.business.schemaUid }}</code>
              </dd>
              <template v-if="operation.business.action !== 'credential-issue'">
                <dt>Generation ID</dt>
                <dd>
                  <code>{{ operation.business.generationId }}</code>
                </dd>
              </template>
              <template v-else>
                <dt>URI</dt>
                <dd>
                  <code>{{ operation.business.credentialUri ?? '—' }}</code>
                </dd>
                <dt>{{ $t('operations.expiration') }}</dt>
                <dd>{{ operation.business.expiration ?? '—' }}</dd>
              </template>
              <dt>{{ $t('operations.payloadHash') }}</dt>
              <dd>
                <code>{{ operation.business.payloadDigestHex ?? '—' }}</code>
              </dd>
            </template>
            <dt>{{ $t('operations.xcsResult') }}</dt>
            <dd data-testid="operation-xcs-result">
              <code>{{ operationBusinessConfirmation(operation) ?? '—' }}</code>
            </dd>
          </template>
          <dt>{{ $t('operations.ledger') }}</dt>
          <dd>{{ operation.ledgerIndex ?? '—' }}</dd>
          <template v-if="operationBusinessEvidence(operation)">
            <dt>{{ $t('operations.proofLedgerHash') }}</dt>
            <dd>
              <code>{{ operationBusinessEvidence(operation)?.ledgerHash }}</code>
            </dd>
            <dt>{{ $t('operations.proofTransactionIndex') }}</dt>
            <dd>{{ operationBusinessEvidence(operation)?.transactionIndex }}</dd>
            <dt v-if="operationBusinessEvidence(operation)?.schemaUid">Schema UID</dt>
            <dd v-if="operationBusinessEvidence(operation)?.schemaUid">
              <code>{{ operationBusinessEvidence(operation)?.schemaUid }}</code>
            </dd>
            <dt v-if="operationBusinessEvidence(operation)?.generationId">Generation ID</dt>
            <dd v-if="operationBusinessEvidence(operation)?.generationId">
              <code>{{ operationBusinessEvidence(operation)?.generationId }}</code>
            </dd>
            <dt v-if="operationBusinessEvidence(operation)?.reasonCode">
              {{ $t('operations.reason') }}
            </dt>
            <dd v-if="operationBusinessEvidence(operation)?.reasonCode">
              <code>{{ operationBusinessEvidence(operation)?.reasonCode }}</code>
            </dd>
          </template>
        </dl>
        <div v-if="operationAcceptLink(operation)" class="button-row">
          <NuxtLinkLocale
            class="button secondary"
            :to="operationAcceptLink(operation) ?? '/accept'"
          >
            {{ $t('operations.acceptLink') }}
          </NuxtLinkLocale>
        </div>
        <NuxtLinkLocale
          v-if="operationCredentialLink(operation)"
          class="button secondary"
          data-testid="operation-credential-link"
          :to="operationCredentialLink(operation) ?? '/'"
        >
          {{ $t('operations.credentialLink') }}
        </NuxtLinkLocale>
        <p v-if="operation.message" class="muted">{{ operation.message }}</p>
      </article>
    </div>
  </section>
</template>
