<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })
const { t } = useI18n()
useSeoMeta({ title: () => `${t('verifier.apply')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <OrganizationApplicationForm role="verifier" />
</template>
