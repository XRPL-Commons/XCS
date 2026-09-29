<script setup lang="ts">
const uiLocale = useUiLocale()
const { locale } = useI18n()
useHead(() => ({ htmlAttrs: { lang: locale.value === 'fr' ? 'fr-FR' : 'en-US' } }))
onMounted(() => {
  if (window.location.hash !== '#xcs-legacy-redirect') return
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  )
})
</script>

<template>
  <UApp :locale="uiLocale">
    <span id="xcs-legacy-redirect" hidden aria-hidden="true" />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
