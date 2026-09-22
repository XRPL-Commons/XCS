<script setup lang="ts">
defineProps<{ loading?: boolean }>()
</script>

<template>
  <p v-if="loading" class="my-6 text-sm text-muted" role="status">{{ $t('common.loading') }}</p>
  <div
    v-else
    class="my-6 rounded-[0.6rem] border border-dashed border-accented px-6 py-10 text-center text-sm text-muted"
  >
    <slot />
  </div>
</template>
