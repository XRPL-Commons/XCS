<script setup lang="ts">
import { singleQueryValue } from '~/utils/explorer'

const route = useRoute()
const localePath = useLocalePath()
const { t } = useI18n()
const cursor = computed(() => singleQueryValue(route.query.cursor))
const { listSchemas } = useXcsApi()
const { data, pending, error, refresh } = await useAsyncData(
  () => `schemas:${cursor.value}`,
  () => listSchemas({ ...(cursor.value === '' ? {} : { cursor: cursor.value }), limit: 18 }),
)

function nextPage(): ReturnType<typeof navigateTo> | undefined {
  if (data.value?.nextCursor === undefined) return undefined
  return navigateTo({ path: localePath('/schemas'), query: { cursor: data.value.nextCursor } })
}

useSeoMeta({
  title: () => t('schemas.metaTitle'),
  description: () => t('schemas.description'),
  robots: 'index,follow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader eyebrow="Registry" :title="$t('schemas.title')">
      <template #actions>
        <UButton :to="localePath('/schemas/register')" color="neutral" variant="solid">
          {{ $t('schemas.register') }}
        </UButton>
      </template>
    </PageHeader>
    <p class="mb-6 max-w-2xl text-toned">{{ $t('schemas.description') }}</p>

    <EmptyState v-if="pending" loading />
    <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
    <div v-else-if="data?.items.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <NuxtLink
        v-for="schema in data.items"
        :key="schema.uid"
        :to="localePath(`/schemas/${schema.uid}`)"
        data-testid="schema-card"
        class="block min-w-0 rounded-[0.6rem] bg-elevated p-5 ring-1 ring-default hover:ring-accented"
      >
        <StatusPill :value="schema.valid ? 'valid' : 'invalid'" />
        <h2 class="mt-2 text-lg break-words">{{ schema.name }}</h2>
        <p class="mt-1 text-sm text-toned">{{ schema.description }}</p>
        <code class="mt-2 block font-mono text-xs break-words text-muted">{{ schema.uid }}</code>
        <small class="mt-2 block break-words text-muted">{{ schema.publisher }}</small>
        <small class="mt-1 block text-muted">{{
          $t('explorer.ledger', { ledger: schema.ledgerIndex })
        }}</small>
      </NuxtLink>
    </div>
    <EmptyState v-else>{{ $t('schemas.empty') }}</EmptyState>

    <Pagination
      v-if="data"
      :first-to="cursor ? localePath('/schemas') : undefined"
      :has-next="Boolean(data?.nextCursor)"
      @next="nextPage"
    />
  </UContainer>
</template>
