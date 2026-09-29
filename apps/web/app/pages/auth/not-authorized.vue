<script setup lang="ts">
const { t } = useI18n()
const route = useRoute()
const localePath = useLocalePath()
useSeoMeta({ title: () => `${t('auth.notAuthorized')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader :title="$t('auth.notAuthorized')" />
    <StatusBox :tone="route.query.reason === 'unavailable' ? 'error' : 'warning'">
      {{ $t(route.query.reason === 'unavailable' ? 'auth.unavailable' : 'auth.notAuthorizedHelp') }}
    </StatusBox>
    <div class="mt-6 flex flex-wrap gap-3">
      <UButton :to="localePath('/account')">{{ $t('auth.account') }}</UButton>
      <UButton :to="localePath('/')" color="neutral" variant="outline">{{
        $t('auth.backHome')
      }}</UButton>
    </div>
  </UContainer>
</template>
