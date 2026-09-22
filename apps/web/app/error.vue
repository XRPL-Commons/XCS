<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const uiLocale = useUiLocale()
const localePath = useLocalePath()
const is404 = computed(() => props.error.statusCode === 404)

useSeoMeta({ title: () => `${props.error.statusCode} — XCS`, robots: 'noindex' })
</script>

<template>
  <UApp :locale="uiLocale">
    <UContainer class="flex min-h-screen flex-col items-center justify-center py-16 text-center">
      <p class="font-display text-7xl font-semibold text-sage-700">{{ error.statusCode }}</p>
      <h1 class="mt-4 text-3xl font-semibold">
        {{ is404 ? $t('explorer.errors.unavailable') : $t('explorer.errors.unavailable') }}
      </h1>
      <p v-if="!is404" class="mt-3 text-sm text-muted">
        {{ $t('explorer.errors.unavailableHint') }}
      </p>
      <UButton
        class="mt-8"
        :to="localePath('/')"
        @click="clearError({ redirect: localePath('/') })"
      >
        XCS
      </UButton>
    </UContainer>
  </UApp>
</template>
