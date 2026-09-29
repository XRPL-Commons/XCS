<script setup lang="ts">
const props = defineProps<{ value: string; label?: string }>()
const color = computed(() => {
  if (['active', 'valid', 'trusted', 'ready', 'accepted', 'created'].includes(props.value)) {
    return 'success'
  }
  if (['tampered', 'invalid', 'untrusted', 'deleted', 'halted', 'rejected'].includes(props.value)) {
    return 'error'
  }
  if (
    [
      'pending',
      'unavailable',
      'unknown',
      'not_checked',
      'starting',
      'catching_up',
      'expired',
    ].includes(props.value)
  ) {
    return 'warning'
  }
  return 'neutral'
})
</script>

<template>
  <UBadge :color="color" variant="subtle" :label="label ?? value" :data-tone="color" />
</template>
