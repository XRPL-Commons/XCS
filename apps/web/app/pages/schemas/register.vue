<script setup lang="ts">
import { legacyPortalDestination } from '~/utils/portalRoutes'

const { locale } = useI18n()
await navigateTo(legacyPortalDestination('/schemas/register', locale.value), {
  replace: true,
  redirectCode: 308,
})
</script>

<template><div /></template>
