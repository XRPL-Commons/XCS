<script setup lang="ts">
import { authReturnPath } from '~/utils/authReturnPath'
const { t } = useI18n()
const localePath = useLocalePath()
const route = useRoute()
const { load, enabled, user, unavailable } = useAuth()
await load()
const returnTo = computed(() => authReturnPath(route.query.returnTo ?? localePath('/account')))
if (user.value) await navigateTo(returnTo.value, { replace: true })
const loginUrl = computed(() => `/api/auth/login?returnTo=${encodeURIComponent(returnTo.value)}`)
useSeoMeta({ title: () => `${t('auth.signIn')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader :title="$t('auth.signIn')" :lead="$t('auth.loginIntro')" />
    <StatusBox v-if="unavailable" tone="error">{{ $t('auth.unavailable') }}</StatusBox>
    <StatusBox v-else-if="!enabled" tone="notice">{{ $t('auth.disabled') }}</StatusBox>
    <template v-else>
      <StatusBox v-if="route.query.error" tone="error" class="mb-5">{{
        $t('auth.loginFailed')
      }}</StatusBox>
      <UButton :href="loginUrl" external data-testid="auth-signin">{{
        $t('auth.continue')
      }}</UButton>
    </template>
    <p class="mt-6 text-sm text-muted">{{ $t('auth.walletSeparate') }}</p>
    <UButton class="mt-4" :to="localePath('/')" color="neutral" variant="link">{{
      $t('auth.backHome')
    }}</UButton>
  </UContainer>
</template>
