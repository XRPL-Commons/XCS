<script setup lang="ts">
import { singleQueryValue } from '~/utils/explorer'

const route = useRoute()
const localePath = useLocalePath()
const { t } = useI18n()
const cursor = computed(() => singleQueryValue(route.query.cursor))
const { getSchemaActivity } = useXcsApi()
const { data, pending, error, refresh } = await useAsyncData(
  () => `schema-activity:${cursor.value}`,
  () => getSchemaActivity({ ...(cursor.value === '' ? {} : { cursor: cursor.value }), limit: 25 }),
)

function nextPage(): ReturnType<typeof navigateTo> | undefined {
  if (data.value?.nextCursor === undefined) return undefined
  return navigateTo({ path: localePath('/activity'), query: { cursor: data.value.nextCursor } })
}

useSeoMeta({
  title: () => `${t('activity.title')} — XCS`,
  description: () => t('activity.description'),
  robots: 'index,follow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader eyebrow="Explorer" :title="$t('activity.title')">
      <template #actions>
        <UButton :to="localePath('/schemas')" color="neutral" variant="outline">
          {{ $t('nav.schemas') }}
        </UButton>
      </template>
    </PageHeader>
    <p class="mb-3 max-w-2xl text-toned">{{ $t('activity.description') }}</p>
    <p class="mb-6 border-l-2 border-accented pl-3 text-sm text-toned">
      {{ $t('activity.scope') }}
    </p>

    <EmptyState v-if="pending" loading />
    <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
    <ol v-else-if="data?.items.length" class="grid gap-4">
      <li v-for="registration in data.items" :key="registration.transactionHash" class="min-w-0">
        <UCard>
          <div class="mb-4 flex flex-wrap items-center gap-2">
            <StatusPill :value="registration.status" />
            <strong>{{ $t(`activity.${registration.status}`) }}</strong>
            <p class="w-full min-w-0 text-sm break-words text-muted">
              {{ $t('activity.by') }} <code class="font-mono">{{ registration.publisher }}</code>
            </p>
          </div>
          <MetadataList compact>
            <dt>{{ $t('schemas.ledger') }}</dt>
            <dd>{{ registration.ledgerIndex }} · tx {{ registration.transactionIndex }}</dd>
            <dt>{{ $t('activity.transaction') }}</dt>
            <dd>
              <NuxtLink :to="localePath(`/transactions/${registration.transactionHash}`)"
                ><code>{{ registration.transactionHash }}</code></NuxtLink
              >
            </dd>
            <template v-if="registration.schemaUid">
              <dt>Schema UID</dt>
              <dd>
                <NuxtLink :to="localePath(`/schemas/${registration.schemaUid}`)"
                  ><code>{{ registration.schemaUid }}</code></NuxtLink
                >
              </dd>
            </template>
            <template v-if="registration.reasonCode">
              <dt>{{ $t('activity.reason') }}</dt>
              <dd>
                <code>{{ registration.reasonCode }}</code>
              </dd>
            </template>
          </MetadataList>
        </UCard>
      </li>
    </ol>
    <EmptyState v-else>{{ $t('activity.empty') }}</EmptyState>

    <Pagination
      v-if="data"
      :first-to="cursor ? localePath('/activity') : undefined"
      :has-next="Boolean(data?.nextCursor)"
      @next="nextPage"
    />
  </UContainer>
</template>
