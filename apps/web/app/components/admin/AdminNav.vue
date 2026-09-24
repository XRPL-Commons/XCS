<script setup lang="ts">
const localePath = useLocalePath()
const route = useRoute()
const links = [
  { path: '/admin', label: 'admin.queue' },
  { path: '/admin/verifiers', label: 'admin.verifiers' },
  { path: '/admin/audit', label: 'admin.audit' },
]
</script>

<template>
  <nav class="mb-7 flex flex-wrap gap-3" :aria-label="$t('admin.navigation')">
    <UButton
      v-for="link in links"
      :key="link.path"
      :to="localePath(link.path)"
      color="neutral"
      :variant="route.path === localePath(link.path) ? 'solid' : 'outline'"
      :aria-current="route.path === localePath(link.path) ? 'page' : undefined"
      >{{ $t(link.label) }}</UButton
    >
  </nav>
</template>
