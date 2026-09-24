<script setup lang="ts">
defineProps<{ page: number; pageSize: number; total: number; busy?: boolean }>()
defineEmits<{ change: [page: number] }>()
</script>

<template>
  <nav
    v-if="page > 1 || total > pageSize"
    class="mt-6 flex items-center gap-4"
    :aria-label="$t('admin.pagination')"
  >
    <UButton
      color="neutral"
      variant="outline"
      :disabled="busy || page <= 1"
      @click="$emit('change', page - 1)"
      >{{ $t('admin.previous') }}</UButton
    >
    <span>{{ $t('admin.page', { page, total: Math.max(1, Math.ceil(total / pageSize)) }) }}</span>
    <UButton
      color="neutral"
      variant="outline"
      :disabled="busy || page * pageSize >= total"
      @click="$emit('change', page + 1)"
      >{{ $t('admin.next') }}</UButton
    >
  </nav>
</template>
