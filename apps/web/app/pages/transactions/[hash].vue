<script setup lang="ts">
import { singleQueryValue } from '~/utils/explorer'

const route = useRoute()
const localePath = useLocalePath()
const transactionHash = computed(() => String(route.params.hash))
const cursor = computed(() => singleQueryValue(route.query.cursor))
const { t } = useI18n()
const { getTransaction } = useXcsApi()
const { data, pending, error, refresh } = await useAsyncData(
  () => `transaction:${transactionHash.value}:${cursor.value}`,
  () =>
    getTransaction(transactionHash.value, {
      ...(cursor.value === '' ? {} : { cursor: cursor.value }),
      limit: 25,
    }),
)

function nextPage(): ReturnType<typeof navigateTo> | undefined {
  const nextCursor = data.value?.credentialEvents.nextCursor
  if (nextCursor === undefined) return undefined
  return navigateTo({
    path: localePath(`/transactions/${transactionHash.value.toLowerCase()}`),
    query: { cursor: nextCursor },
  })
}

useSeoMeta({
  title: () => `${t('transactionExplorer.title')} — XCS`,
  description: () => t('transactionExplorer.description'),
  robots: 'noindex,nofollow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      eyebrow="Explorer · XRPL"
      :title="$t('transactionExplorer.title')"
      :lead="$t('transactionExplorer.description')"
    />

    <EmptyState v-if="pending" loading />
    <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
    <template v-else-if="data">
      <MetadataList data-testid="explorer-metadata">
        <dt>{{ $t('transactionExplorer.hash') }}</dt>
        <dd>
          <code>{{ data.transactionHash }}</code>
        </dd>
        <dt>{{ $t('schemas.ledger') }}</dt>
        <dd>{{ data.ledgerIndex }} · tx {{ data.transactionIndex }}</dd>
        <dt>{{ $t('transactionExplorer.ledgerHash') }}</dt>
        <dd>
          <code>{{ data.ledgerHash }}</code>
        </dd>
      </MetadataList>

      <UCard v-if="data.registration" class="mt-6 mb-6">
        <template #header>
          <div class="flex flex-wrap items-center gap-3">
            <h2 class="text-xl font-semibold">{{ $t('transactionExplorer.registration') }}</h2>
            <StatusPill :value="data.registration.status" />
          </div>
        </template>
        <MetadataList>
          <dt>{{ $t('transactionExplorer.publisher') }}</dt>
          <dd>
            <code>{{ data.registration.publisher }}</code>
          </dd>
          <template v-if="data.registration.schemaUid">
            <dt>Schema UID</dt>
            <dd>
              <NuxtLink :to="localePath(`/schemas/${data.registration.schemaUid}`)"
                ><code>{{ data.registration.schemaUid }}</code></NuxtLink
              >
            </dd>
          </template>
          <template v-if="data.registration.schemaDigestHex">
            <dt>{{ $t('transactionExplorer.schemaDigest') }}</dt>
            <dd>
              <code>{{ data.registration.schemaDigestHex }}</code>
            </dd>
          </template>
          <template v-if="data.registration.reasonCode">
            <dt>{{ $t('activity.reason') }}</dt>
            <dd>
              <code>{{ data.registration.reasonCode }}</code>
            </dd>
          </template>
        </MetadataList>
      </UCard>

      <UCard v-if="data.credentialEvents.items.length" class="mb-6">
        <template #header>
          <h2 class="text-xl font-semibold">{{ $t('transactionExplorer.credentialEvents') }}</h2>
        </template>
        <div class="grid gap-4">
          <article
            v-for="event in data.credentialEvents.items"
            :key="event.nodeIndex"
            class="min-w-0"
          >
            <StatusPill :value="event.eventType" />
            <MetadataList compact class="mt-2">
              <dt>{{ $t('credential.generation') }}</dt>
              <dd>
                <NuxtLink
                  v-if="event.generationId"
                  :to="localePath(`/credentials/${event.generationId}`)"
                  ><code>{{ event.generationId }}</code></NuxtLink
                >
                <span v-else>—</span>
              </dd>
              <dt>{{ $t('credential.issuer') }}</dt>
              <dd>
                <code>{{ event.issuer }}</code>
              </dd>
              <dt>{{ $t('credential.subject') }}</dt>
              <dd>
                <code>{{ event.subject }}</code>
              </dd>
              <dt>{{ $t('credential.schema') }}</dt>
              <dd>
                <NuxtLink :to="localePath(`/schemas/${event.schemaUid}`)"
                  ><code>{{ event.schemaUid }}</code></NuxtLink
                >
              </dd>
              <template v-if="event.deletionCause">
                <dt>{{ $t('transactionExplorer.deletionCause') }}</dt>
                <dd>
                  <code>{{ event.deletionCause }}</code>
                </dd>
              </template>
            </MetadataList>
          </article>
        </div>
      </UCard>

      <EmptyState v-if="!data.registration && data.credentialEvents.items.length === 0">
        {{ $t('transactionExplorer.empty') }}
      </EmptyState>

      <Pagination
        :first-to="cursor ? localePath(`/transactions/${transactionHash}`) : undefined"
        :has-next="Boolean(data.credentialEvents.nextCursor)"
        @next="nextPage"
      />
    </template>
  </UContainer>
</template>
