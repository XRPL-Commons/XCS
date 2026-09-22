<!-- eslint-disable vue/multi-word-component-names -->
<script setup lang="ts">
defineProps<{ firstTo?: string; hasNext: boolean }>()
defineEmits<{ next: [] }>()
</script>

<template>
  <nav class="mt-8 flex flex-wrap gap-3" :aria-label="$t('explorer.pagination.label')">
    <UButton v-if="firstTo" :to="firstTo" color="neutral" variant="outline" size="sm">
      {{ $t('explorer.pagination.first') }}
    </UButton>
    <UButton v-if="hasNext" color="neutral" variant="outline" size="sm" @click="$emit('next')">
      {{ $t('explorer.pagination.next') }}
    </UButton>
  </nav>
</template>
