<script setup lang="ts">
import { legacyPortalDestination } from '~/utils/portalRoutes'

const { locale } = useI18n()
await navigateTo(legacyPortalDestination('/verify', locale.value), {
  replace: true,
  redirectCode: 308,
})
</script>

<template><div /></template>
