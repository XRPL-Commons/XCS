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

const localePath = useLocalePath()
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
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      eyebrow="XRPL submission journal"
      :title="$t('operations.title')"
      :lead="$t('operations.description')"
    >
      <template #actions>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="busy || operations.length === 0"
          @click="downloadReceipts"
        >
          {{ $t('operations.export') }}
        </UButton>
        <UButton color="neutral" variant="outline" :disabled="busy" @click="refresh">
          {{ $t('operations.refresh') }}
        </UButton>
      </template>
    </PageHeader>

    <StatusBox tone="warning">{{ $t('operations.localOnly') }}</StatusBox>
    <HostedPublicationRecovery />
    <StatusBox v-if="pageError" tone="error">{{ pageError }}</StatusBox>
    <StatusBox
      v-if="resultMessage"
      :tone="resultTone === 'error' ? 'error' : resultTone === 'success' ? 'success' : 'notice'"
    >
      {{ resultMessage }}
    </StatusBox>
    <EmptyState v-if="operations.length === 0">{{ $t('operations.empty') }}</EmptyState>

    <div v-else class="grid gap-4">
      <UCard
        v-for="operation in operations"
        :key="operation.operationId"
        class="min-w-0"
        data-testid="operation-card"
      >
        <template #header>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs tracking-wide text-muted uppercase">
                {{ operation.transactionType }}
              </p>
              <h2 class="text-xl font-semibold break-words">{{ operation.stage }}</h2>
            </div>
            <div class="flex flex-wrap gap-3">
              <UButton
                v-if="canRetryOperation(operation)"
                color="neutral"
                variant="solid"
                :disabled="busy"
                @click="retry(operation.operationId)"
              >
                {{ $t('operations.retry') }}
              </UButton>
              <UButton
                v-if="canReconfirmOperation(operation)"
                color="neutral"
                variant="outline"
                data-testid="operation-reconfirm"
                :disabled="busy"
                @click="reconfirm(operation.operationId)"
              >
                {{ $t('operations.reconfirm') }}
              </UButton>
              <UButton
                v-if="canAbandonOperation(operation)"
                color="neutral"
                variant="outline"
                :disabled="busy"
                @click="abandon(operation.operationId)"
              >
                {{ $t('operations.abandon') }}
              </UButton>
            </div>
          </div>
        </template>
        <MetadataList>
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
        </MetadataList>
        <div class="mt-4 flex flex-wrap gap-3">
          <UButton
            v-if="operationAcceptLink(operation)"
            color="neutral"
            variant="outline"
            :to="localePath(operationAcceptLink(operation) ?? '/accept')"
          >
            {{ $t('operations.acceptLink') }}
          </UButton>
          <UButton
            v-if="operationCredentialLink(operation)"
            color="neutral"
            variant="outline"
            data-testid="operation-credential-link"
            :to="localePath(operationCredentialLink(operation) ?? '/')"
          >
            {{ $t('operations.credentialLink') }}
          </UButton>
        </div>
        <p v-if="operation.message" class="mt-3 text-sm break-words text-muted">
          {{ operation.message }}
        </p>
      </UCard>
    </div>
  </UContainer>
</template>
