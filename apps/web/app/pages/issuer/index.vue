<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'role'], requiredRole: 'issuer' })
const localePath = useLocalePath()
await navigateTo(
  { path: localePath('/issuer/schemas'), query: useRoute().query },
  { replace: true },
)
</script>

<template>
  <div />
</template>
