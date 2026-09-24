<script setup lang="ts">
const uiLocale = useUiLocale()
const { locale } = useI18n()
useHead(() => ({ htmlAttrs: { lang: locale.value === 'fr' ? 'fr-FR' : 'en-US' } }))
const route = useRoute()
const localePath = useLocalePath()
// Issue and operations render recovery in context; other routes keep it reachable.
const showRecovery = computed(
  () => ![localePath('/issue'), localePath('/operations')].includes(route.path),
)
</script>

<template>
  <UApp :locale="uiLocale">
    <NuxtLayout>
      <UContainer v-if="showRecovery">
        <HostedPublicationRecovery />
      </UContainer>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
