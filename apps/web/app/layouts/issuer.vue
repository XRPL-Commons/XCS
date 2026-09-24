<script setup lang="ts">
const localePath = useLocalePath()
const route = useRoute()
const links = [
  ['schemas', '/issuer/schemas'],
  ['recipients', '/issuer/recipients'],
  ['credentials', '/issuer/credentials'],
  ['settings', '/issuer/settings'],
]
</script>

<template>
  <NuxtLayout name="default">
    <UContainer class="py-8">
      <nav :aria-label="$t('issuer.navigation')" class="mb-7 flex flex-wrap gap-3">
        <UButton
          v-for="[label, path] in links"
          :key="path"
          color="neutral"
          variant="outline"
          :to="{
            path: localePath(path!),
            query: route.query.organizationId ? { organizationId: route.query.organizationId } : {},
          }"
        >
          {{ $t(`simpleIssuer.nav.${label}`) }}
        </UButton>
      </nav>
      <slot />
    </UContainer>
  </NuxtLayout>
</template>
