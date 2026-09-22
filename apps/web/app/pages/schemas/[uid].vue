<script setup lang="ts">
const route = useRoute()
const localePath = useLocalePath()
const uid = computed(() => String(route.params.uid))
const { t } = useI18n()
const { getSchema } = useXcsApi()
const { data, pending, error, refresh } = await useAsyncData(
  () => `schema:${uid.value}`,
  () => getSchema(uid.value),
)

useSeoMeta({
  title: () => (data.value ? `${data.value.name} — XCS` : t('schemas.metaTitle')),
  description: () => data.value?.description ?? t('schemas.description'),
  robots: 'index,follow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <EmptyState v-if="pending" loading />
    <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
    <template v-else-if="data">
      <StatusPill :value="data.valid ? 'valid' : 'invalid'" />
      <h1 class="mt-3 text-4xl break-words">{{ data.name }}</h1>
      <p class="mt-2 mb-6 max-w-2xl text-toned">{{ data.description }}</p>
      <MetadataList data-testid="explorer-metadata">
        <dt>UID</dt>
        <dd>
          <code>{{ data.uid }}</code>
        </dd>
        <dt>Publisher</dt>
        <dd>
          <code>{{ data.publisher }}</code>
        </dd>
        <dt>{{ $t('schemas.ledger') }}</dt>
        <dd>{{ data.ledgerIndex }} · tx {{ data.transactionIndex }}</dd>
        <dt>{{ $t('schemas.registration') }}</dt>
        <dd>
          <NuxtLink :to="localePath(`/transactions/${data.registrationTransactionHash}`)">
            <code>{{ data.registrationTransactionHash }}</code>
          </NuxtLink>
        </dd>
        <template v-if="data.parentUid">
          <dt>{{ $t('schemas.parent') }}</dt>
          <dd>
            <NuxtLink :to="localePath(`/schemas/${data.parentUid}`)"
              ><code>{{ data.parentUid }}</code></NuxtLink
            >
          </dd>
        </template>
        <template v-if="data.supersedesUid">
          <dt>{{ $t('schemas.supersedes') }}</dt>
          <dd>
            <NuxtLink :to="localePath(`/schemas/${data.supersedesUid}`)"
              ><code>{{ data.supersedesUid }}</code></NuxtLink
            >
          </dd>
        </template>
      </MetadataList>
      <p class="my-6 border-l-2 border-accented pl-3 text-sm text-toned">
        {{ $t('schemas.neutrality') }}
      </p>
      <h2 class="mt-8 mb-3 text-xl font-semibold">{{ $t('schemas.fields') }}</h2>
      <div class="grid gap-2">
        <div
          v-for="(field, name) in data.resolved.fields"
          :key="name"
          class="flex flex-wrap gap-3 rounded-[0.45rem] bg-elevated px-4 py-2 ring-1 ring-default"
        >
          <code class="min-w-0 font-mono break-words">{{ name }}</code>
          <span class="text-sm text-toned">{{ field.type }}</span>
          <small class="text-muted">{{
            field.optional ? $t('schemas.optional') : $t('schemas.required')
          }}</small>
        </div>
      </div>
      <template v-if="data.resolved.lineage.length">
        <h2 class="mt-8 mb-3 text-xl font-semibold">{{ $t('schemas.lineage') }}</h2>
        <ol class="grid gap-2">
          <li v-for="ancestor in data.resolved.lineage" :key="ancestor" class="min-w-0">
            <NuxtLink :to="localePath(`/schemas/${ancestor}`)"
              ><code class="font-mono break-words">{{ ancestor }}</code></NuxtLink
            >
          </li>
        </ol>
      </template>
      <h2 class="mt-8 mb-3 text-xl font-semibold">{{ $t('schemas.definition') }}</h2>
      <JsonBlock :code="JSON.stringify(data.definition, null, 2)" />
      <UButton :to="localePath(`/issue?schema=${data.uid}`)" color="neutral" variant="solid">
        {{ $t('schemas.use') }}
      </UButton>
    </template>
  </UContainer>
</template>
