<script setup lang="ts">
import { explorerResultPath, normalizedExplorerQuery } from '~/utils/explorer'

const route = useRoute()
const localePath = useLocalePath()
const { t } = useI18n()
const query = computed(() => normalizedExplorerQuery(route.query.q))
const { search } = useXcsApi()
const { data, pending, error, refresh } = await useAsyncData(
  () => `explorer-search:${query.value}`,
  () => (query.value === '' ? Promise.resolve({ items: [], hasMore: false }) : search(query.value)),
)

function resultPath(item: NonNullable<typeof data.value>['items'][number]): string {
  return localePath(explorerResultPath(item) ?? '/search')
}

useSeoMeta({
  title: () => `${t('explorer.search.title')} — XCS`,
  description: () => t('explorer.search.description'),
  robots: 'noindex,follow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      eyebrow="Explorer"
      :title="$t('explorer.search.title')"
      :lead="$t('explorer.search.description')"
    />
    <ExplorerSearch :initial-query="query" autofocus />

    <EmptyState v-if="pending" loading />
    <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
    <EmptyState v-else-if="query === ''">{{ $t('explorer.search.prompt') }}</EmptyState>
    <div v-else-if="data?.items.length" class="mt-8 grid gap-3">
      <NuxtLink
        v-for="item in data.items"
        :key="`${item.type}:${item.type === 'schema' ? item.schemaUid : item.type === 'credential_generation' ? item.generationId : item.transactionHash}`"
        :to="resultPath(item)"
        data-testid="result-card"
        class="flex min-w-0 items-start justify-between gap-3 rounded-[0.6rem] bg-elevated p-5 ring-1 ring-default hover:ring-accented"
      >
        <div class="min-w-0">
          <StatusPill
            :value="
              item.type === 'schema'
                ? 'schema'
                : item.type === 'credential_generation'
                  ? item.state
                  : 'transaction'
            "
          />
          <h2 v-if="item.type === 'schema'" class="mt-2 text-lg break-words">{{ item.name }}</h2>
          <h2 v-else-if="item.type === 'credential_generation'" class="mt-2 text-lg break-words">
            {{ $t('explorer.search.credential') }}
          </h2>
          <h2 v-else class="mt-2 text-lg break-words">{{ $t('explorer.search.transaction') }}</h2>
          <p v-if="item.type === 'schema'" class="mt-1 text-sm text-toned">
            {{ item.description }}
          </p>
          <code class="mt-2 block font-mono text-xs break-words text-muted">{{
            item.type === 'schema'
              ? item.schemaUid
              : item.type === 'credential_generation'
                ? item.generationId
                : item.transactionHash
          }}</code>
        </div>
        <span aria-hidden="true">→</span>
      </NuxtLink>
      <StatusBox v-if="data.hasMore" tone="warning">{{ $t('explorer.search.limited') }}</StatusBox>
    </div>
    <EmptyState v-else>{{ $t('explorer.search.empty') }}</EmptyState>
  </UContainer>
</template>
