<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })
const { t } = useI18n()
useSeoMeta({ title: () => `${t('simpleIssuer.applyTitle')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <OrganizationApplicationForm role="issuer" />
</template>
