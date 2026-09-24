<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'role'], requiredRole: 'admin' })
const { t } = useI18n()
useSeoMeta({ title: () => `${t('admin.queue')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader :title="$t('admin.queue')" :lead="$t('admin.queueIntro')" />
    <AdminNav />
    <AdminApplications />
  </UContainer>
</template>
