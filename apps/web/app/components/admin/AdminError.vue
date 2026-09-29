<script setup lang="ts">
const props = defineProps<{ error: unknown }>()
defineEmits<{ retry: [] }>()
const localePath = useLocalePath()
const status = computed(() => {
  const error = props.error as { statusCode?: number; status?: number }
  return error?.statusCode ?? error?.status
})
const message = computed(() => {
  if (status.value === 401) return 'admin.errors.session'
  if (status.value === 403) return 'admin.errors.forbidden'
  if (status.value === 404) return 'admin.errors.missing'
  if (status.value === 409) return 'admin.errors.conflict'
  if (status.value === 503) return 'admin.errors.unavailable'
  return 'admin.errors.generic'
})
</script>

<template>
  <StatusBox v-if="error" tone="error">
    <p>{{ $t(message) }}</p>
    <UButton v-if="status === 401" :to="localePath('/auth/login')" size="sm">{{
      $t('auth.signIn')
    }}</UButton>
    <UButton
      v-else-if="status !== 403"
      size="sm"
      variant="outline"
      color="neutral"
      @click="$emit('retry')"
      >{{ $t('admin.retry') }}</UButton
    >
  </StatusBox>
</template>
