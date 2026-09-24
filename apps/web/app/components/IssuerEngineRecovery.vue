<script setup lang="ts">
import type { IssuerEngineRecord } from '~/utils/issuerEngine'
defineProps<{
  pending: IssuerEngineRecord | null
  saved: boolean
  busy: boolean
  error: string
  canRestart?: boolean
}>()
defineEmits<{ retry: []; restart: [] }>()
const localePath = useLocalePath()
</script>

<template>
  <StatusBox v-if="pending" tone="warning" role="status" data-testid="issuer-save-pending">
    <p>{{ $t(canRestart ? 'issuer.engine.failedOperation' : 'issuer.engine.savePending') }}</p>
    <div class="mt-3 flex gap-3">
      <UButton v-if="canRestart" :disabled="busy" @click="$emit('restart')">{{
        $t('issuer.engine.restartFailedOperation')
      }}</UButton>
      <UButton v-else :disabled="busy" @click="$emit('retry')">{{
        $t('issuer.engine.retrySave')
      }}</UButton>
      <UButton :to="localePath('/operations')" color="neutral" variant="outline">{{
        $t('nav.operations')
      }}</UButton>
    </div>
    <p v-if="error" role="alert">{{ $t('simpleUi.saveError') }}</p>
    <details class="mt-3">
      <summary class="cursor-pointer">{{ $t('simpleUi.technicalDetails') }}</summary>
      <code class="break-all">{{ pending.transactionHash }}</code>
      <p v-if="error">{{ error }}</p>
    </details>
  </StatusBox>
  <StatusBox v-else-if="saved" tone="success" role="status">{{
    $t('issuer.engine.saved')
  }}</StatusBox>
</template>
