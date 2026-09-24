<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'role'], requiredRole: 'admin' })
const { t } = useI18n()
useSeoMeta({ title: () => `${t('admin.verifiers')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader :title="$t('admin.verifiers')" :lead="$t('admin.verifiersIntro')" />
    <AdminNav />
    <StatusBox>{{ $t('admin.privateClaims') }}</StatusBox>
    <AdminApplications verifiers />
  </UContainer>
</template>
