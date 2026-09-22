<script setup lang="ts">
import type { BusinessConfirmation, BusinessEvidence } from '~/utils/operationJournal'

defineProps<{
  txHash: string
  engineResult?: string | null
  ledgerIndex?: number | undefined
  businessConfirmation?: Exclude<BusinessConfirmation, 'pending'> | undefined
  businessEvidence?: BusinessEvidence | undefined
}>()
</script>

<template>
  <UCard class="mb-6" data-testid="business-finality">
    <template #header>
      <h2 class="text-xl font-semibold">{{ $t('finality.title') }}</h2>
    </template>
    <StatusBox tone="notice" :title="$t('finality.xrplValidated')" data-testid="xrpl-finality">
      <p>
        <code>{{ txHash }}</code>
      </p>
      <p>{{ engineResult ?? 'tesSUCCESS' }} · ledger {{ ledgerIndex ?? '—' }}</p>
    </StatusBox>
    <StatusBox
      v-if="businessConfirmation === 'confirmed'"
      tone="success"
      :title="$t('finality.xcsConfirmed')"
      data-testid="xcs-confirmed"
    />
    <StatusBox
      v-else-if="businessConfirmation === 'rejected'"
      tone="error"
      :title="$t('finality.xcsRejected')"
      data-testid="xcs-rejected"
    >
      <code v-if="businessEvidence?.reasonCode">{{ businessEvidence.reasonCode }}</code>
    </StatusBox>
    <StatusBox
      v-else-if="businessConfirmation === 'mismatch'"
      tone="error"
      :title="$t('finality.xcsMismatch')"
      data-testid="xcs-mismatch"
    />
    <StatusBox v-else tone="notice" :title="$t('finality.xcsPending')" data-testid="xcs-pending">
      <p>{{ $t('finality.reconfirm') }}</p>
    </StatusBox>
    <MetadataList v-if="businessEvidence" class="mt-5">
      <dt>{{ $t('finality.proofLedger') }}</dt>
      <dd>{{ businessEvidence.ledgerIndex }}</dd>
      <dt>{{ $t('finality.proofLedgerHash') }}</dt>
      <dd>
        <code>{{ businessEvidence.ledgerHash }}</code>
      </dd>
      <dt>{{ $t('finality.proofTransactionIndex') }}</dt>
      <dd>{{ businessEvidence.transactionIndex }}</dd>
      <template v-if="businessEvidence.schemaUid">
        <dt>Schema UID</dt>
        <dd>
          <code>{{ businessEvidence.schemaUid }}</code>
        </dd>
      </template>
      <template v-if="businessEvidence.generationId">
        <dt>Generation ID</dt>
        <dd>
          <code>{{ businessEvidence.generationId }}</code>
        </dd>
      </template>
      <template v-if="businessEvidence.eventType">
        <dt>{{ $t('finality.proofEvent') }}</dt>
        <dd>
          <code>{{ businessEvidence.eventType }}</code>
        </dd>
      </template>
      <template v-if="businessEvidence.deletionCause">
        <dt>{{ $t('finality.proofDeletionCause') }}</dt>
        <dd>
          <code>{{ businessEvidence.deletionCause }}</code>
        </dd>
      </template>
    </MetadataList>
  </UCard>
</template>
