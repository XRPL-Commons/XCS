<script setup lang="ts">
const { t } = useI18n()
const localePath = useLocalePath()

useSeoMeta({
  title: () => `${t('studio.title')} — XCS`,
  description: () => t('studio.description'),
  robots: 'index,follow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      :eyebrow="$t('nav.create')"
      :title="$t('studio.title')"
      :lead="$t('studio.description')"
    />
    <p class="mb-8 border-l-2 border-accented pl-3 text-sm text-toned">
      {{ $t('studio.nonCustodial') }}
    </p>

    <div class="grid gap-4 sm:grid-cols-2">
      <NuxtLink
        :to="localePath('/schemas/register')"
        data-testid="create-primary-card"
        class="block min-w-0 rounded-[0.6rem] bg-elevated p-6 ring-1 ring-default hover:ring-accented"
      >
        <span class="block font-mono text-sm text-muted">01 / {{ $t('studio.schemaType') }}</span>
        <h2 class="mt-2 text-2xl break-words">{{ $t('studio.schemaTitle') }}</h2>
        <p class="mt-2 text-sm text-toned">{{ $t('studio.register') }}</p>
        <strong class="mt-4 block text-sm"
          >{{ $t('studio.schemaCta') }} <span aria-hidden="true">↗</span></strong
        >
      </NuxtLink>
      <NuxtLink
        :to="localePath('/issue')"
        data-testid="create-primary-card"
        class="block min-w-0 rounded-[0.6rem] bg-neutral-950 p-6 text-neutral-50 ring-1 ring-default hover:ring-accented"
      >
        <span class="block font-mono text-sm text-neutral-400"
          >02 / {{ $t('studio.credentialType') }}</span
        >
        <h2 class="mt-2 text-2xl break-words">{{ $t('studio.credentialTitle') }}</h2>
        <p class="mt-2 text-sm text-neutral-300">{{ $t('studio.issue') }}</p>
        <strong class="mt-4 block text-sm"
          >{{ $t('studio.credentialCta') }} <span aria-hidden="true">↗</span></strong
        >
      </NuxtLink>
    </div>

    <div class="mt-12 mb-6 flex flex-wrap items-end justify-between gap-4">
      <div class="min-w-0">
        <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">
          {{ $t('studio.manageEyebrow') }}
        </p>
        <h2 class="text-3xl break-words">{{ $t('studio.manageTitle') }}</h2>
      </div>
      <p class="max-w-xl text-sm text-toned">{{ $t('studio.manageDescription') }}</p>
    </div>
    <div class="grid gap-4 sm:grid-cols-3">
      <NuxtLink
        v-for="entry in [
          { index: '03', to: '/accept', title: $t('nav.accept'), copy: $t('studio.accept') },
          { index: '04', to: '/revoke', title: $t('nav.revoke'), copy: $t('studio.revoke') },
          {
            index: '05',
            to: '/operations',
            title: $t('nav.operations'),
            copy: $t('studio.operations'),
          },
        ]"
        :key="entry.to"
        :to="localePath(entry.to)"
        class="block min-w-0 rounded-[0.6rem] bg-elevated p-5 ring-1 ring-default hover:ring-accented"
      >
        <span class="block font-mono text-sm text-muted">{{ entry.index }}</span>
        <h2 class="mt-1 text-xl break-words">{{ entry.title }}</h2>
        <p class="mt-2 text-sm text-toned">{{ entry.copy }}</p>
      </NuxtLink>
    </div>
  </UContainer>
</template>
