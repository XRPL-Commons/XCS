<script setup lang="ts">
defineProps<{ eyebrow?: string; title: string; lead?: string }>()
</script>

<template>
  <UPageHeader :headline="eyebrow" :title="title" :description="lead" class="mb-8">
    <template v-if="$slots.actions" #links>
      <div class="flex flex-wrap gap-3">
        <slot name="actions" />
      </div>
    </template>
    <slot />
  </UPageHeader>
</template>
