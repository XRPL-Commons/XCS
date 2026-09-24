<script setup lang="ts">
import type { Transaction } from 'xrpl-connect'
import { requiresGemWalletRawSigning } from '~/utils/gemWalletRawSigning'

const props = defineProps<{
  transaction: Transaction | null
  busy?: boolean
  compact?: boolean
  confirmLabel?: string
}>()
const emit = defineEmits<{ confirm: [] }>()
const { walletId, account, consentToRawSigning } = useWallet()
const actionKey = computed(() => {
  switch (props.transaction?.TransactionType) {
    case 'CredentialCreate':
      return 'issue'
    case 'CredentialAccept':
      return 'accept'
    case 'CredentialDelete':
      return 'remove'
    case 'Payment':
      return 'payment'
    default:
      return 'other'
  }
})
function formatDrops(drops: unknown): string | null {
  if (typeof drops !== 'string' || !/^\d+$/.test(drops)) return null
  const padded = drops.padStart(7, '0')
  return `${padded.slice(0, -6)}.${padded.slice(-6)}`
}
const fee = computed(() => formatDrops(props.transaction?.Fee))
const paymentAmount = computed(() =>
  props.transaction?.TransactionType === 'Payment' ? formatDrops(props.transaction.Amount) : null,
)
const rawSigning = computed(() =>
  requiresGemWalletRawSigning(walletId.value, props.transaction?.TransactionType),
)
const rawAcknowledged = ref(false)
watch(
  [() => props.transaction, walletId],
  () => {
    rawAcknowledged.value = false
  },
  { deep: true },
)

function confirm() {
  if (!props.transaction || props.busy || (rawSigning.value && !rawAcknowledged.value)) return
  if (rawSigning.value) consentToRawSigning(props.transaction)
  rawAcknowledged.value = false
  emit('confirm')
}
</script>

<template>
  <UCard v-if="transaction" class="mb-6" data-testid="transaction-preview" aria-live="polite">
    <h2 class="text-xl font-semibold">{{ $t('transaction.preview') }}</h2>
    <p class="mt-3 font-semibold">{{ $t(`simpleUi.signActions.${actionKey}`) }}</p>
    <p class="mt-2 text-sm">{{ $t('simpleUi.walletWillAsk') }}</p>
    <p class="mt-2 font-semibold">
      {{
        account?.network.id === 'testnet' ? $t('simpleUi.testNetwork') : $t('simpleUi.checkNetwork')
      }}
    </p>
    <p class="mt-2">
      {{ fee === null ? $t('simpleUi.feeUnknown') : $t('simpleUi.fee', { fee }) }}
    </p>
    <p v-if="paymentAmount !== null" class="mt-2">
      {{ $t('simpleUi.paymentAmount', { amount: paymentAmount }) }}
    </p>
    <details class="mt-4" data-testid="transaction-technical-details">
      <summary class="cursor-pointer font-semibold">{{ $t('simpleUi.technicalDetails') }}</summary>
      <MetadataList>
        <template v-for="(value, key) in transaction" :key="key">
          <dt>{{ key }}</dt>
          <dd>
            <code>{{ typeof value === 'object' ? JSON.stringify(value) : value }}</code>
          </dd>
        </template>
      </MetadataList>
    </details>
    <StatusBox v-if="rawSigning" tone="warning" class="mt-5">
      <p>{{ $t('transaction.rawWarning') }}</p>
      <UCheckbox
        v-model="rawAcknowledged"
        :disabled="busy"
        data-testid="raw-signing-consent"
        :label="$t('transaction.rawConsent')"
      />
    </StatusBox>
    <StatusBox v-else-if="!compact" tone="warning" class="mt-5">{{
      $t('transaction.confirmWarning')
    }}</StatusBox>
    <UButton
      class="mt-3"
      data-testid="transaction-sign"
      :disabled="busy || (rawSigning && !rawAcknowledged)"
      @click="confirm"
    >
      {{ busy ? $t('common.working') : (confirmLabel ?? $t('transaction.sign')) }}
    </UButton>
  </UCard>
</template>
