<script setup lang="ts">
import { explorerErrorKind } from '~/utils/explorer'

const props = withDefaults(
  defineProps<{
    error?: unknown
    retryable?: boolean
  }>(),
  { error: undefined, retryable: true },
)

defineEmits<{ retry: [] }>()

const messageKey = computed(() => `explorer.errors.${explorerErrorKind(props.error)}`)
</script>

<template>
  <StatusBox tone="error" :title="$t(messageKey)" data-testid="explorer-error">
    <p v-if="explorerErrorKind(error) === 'unavailable'">
      {{ $t('explorer.errors.unavailableHint') }}
    </p>
    <UButton v-if="retryable" color="neutral" variant="link" class="px-0" @click="$emit('retry')">
      {{ $t('common.retry') }}
    </UButton>
  </StatusBox>
</template>
