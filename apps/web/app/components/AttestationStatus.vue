<script setup lang="ts">
const props = defineProps<{ value: string }>()
const state = computed(() =>
  ['active', 'pending', 'expired', 'deleted', 'not_found'].includes(props.value)
    ? props.value
    : 'unknown',
)
</script>

<template>
  <StatusPill :value="state" :label="$t(`simpleUi.states.${state}`)" />
</template>
