<script setup lang="ts">
import type { Transaction } from 'xrpl'

defineProps<{ transaction: Transaction | null; busy?: boolean }>()
defineEmits<{ confirm: [] }>()
</script>

<template>
  <UCard v-if="transaction" class="mb-6" data-testid="transaction-preview" aria-live="polite">
    <template #header>
      <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">
        {{ $t('transaction.preview') }}
      </p>
      <h2 class="text-xl font-semibold">{{ transaction.TransactionType }}</h2>
    </template>
    <MetadataList>
      <template v-for="(value, key) in transaction" :key="key">
        <dt>{{ key }}</dt>
        <dd>
          <code>{{ typeof value === 'object' ? JSON.stringify(value) : value }}</code>
        </dd>
      </template>
    </MetadataList>
    <StatusBox tone="warning" class="mt-5">{{ $t('transaction.confirmWarning') }}</StatusBox>
    <UButton data-testid="transaction-sign" :disabled="busy" @click="$emit('confirm')">
      {{ busy ? $t('common.working') : $t('transaction.sign') }}
    </UButton>
  </UCard>
</template>
