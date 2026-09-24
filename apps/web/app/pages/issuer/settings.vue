<script setup lang="ts">
definePageMeta({ layout: 'issuer', middleware: ['auth', 'role'], requiredRole: 'issuer' })
const localePath = useLocalePath()
</script>
<template>
  <div>
    <PageHeader :title="$t('issuer.settings')" :lead="$t('issuer.settingsHelp')" />
    <div class="flex flex-wrap gap-4">
      <UButton :to="localePath('/issuer/application')">{{ $t('issuer.application') }}</UButton>
      <UButton :to="localePath('/account')">{{ $t('auth.linkedWallets') }}</UButton>
    </div>
  </div>
</template>
