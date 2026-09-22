<script setup lang="ts">
defineProps<{ compact?: boolean }>()
</script>

<template>
  <dl
    class="grid gap-x-6 gap-y-2 text-sm [&>dd]:m-0 [&>dd]:min-w-0 [&>dd]:break-words [&>dt]:font-semibold [&>dt]:text-muted [&_code]:font-mono [&_code]:text-[0.85em]"
    :class="compact ? 'sm:grid-cols-[auto_1fr]' : 'sm:grid-cols-[12rem_1fr]'"
  >
    <slot />
  </dl>
</template>
