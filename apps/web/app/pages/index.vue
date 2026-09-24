<script setup lang="ts">
const { getStats } = useXcsApi()
const { locale, t } = useI18n()
const localePath = useLocalePath()
const auth = useAuth()
const issuerEnabled = String(useRuntimeConfig().public.issuerEnabled) === '1'
await auth.load()
const simpleNavigation = computed(() => issuerEnabled && auth.enabled.value)
const actions = computed(() => [
  { name: 'receive', to: '/recipient', icon: 'i-lucide-inbox' },
  {
    name: 'issue',
    to: auth.hasRole('issuer') ? '/issuer' : '/issuer/application',
    icon: 'i-lucide-send',
  },
  { name: 'verify', to: '/presentations', icon: 'i-lucide-badge-check' },
])
const {
  data: stats,
  pending,
  error,
  refresh,
} = await useAsyncData('explorer-stats', () => getStats(), {
  immediate: !simpleNavigation.value,
})

const numberFormat = computed(() => new Intl.NumberFormat(locale.value))

useSeoMeta({
  title: () => t(simpleNavigation.value ? 'simpleNavigation.metaTitle' : 'home.metaTitle'),
  description: () =>
    t(simpleNavigation.value ? 'simpleNavigation.description' : 'home.description'),
  robots: 'index,follow',
})
</script>

<template>
  <div v-if="simpleNavigation" data-testid="simple-home">
    <UContainer class="py-16 sm:py-24">
      <div class="max-w-3xl">
        <p class="mb-4 text-sm font-semibold text-muted">{{ $t('simpleNavigation.eyebrow') }}</p>
        <h1 class="text-4xl leading-tight tracking-tight sm:text-5xl">
          {{ $t('simpleNavigation.title') }}
        </h1>
        <p class="mt-6 max-w-2xl text-lg text-toned">{{ $t('simpleNavigation.description') }}</p>
      </div>
      <nav
        class="mt-12 grid gap-5 md:grid-cols-3"
        :aria-label="$t('simpleNavigation.actionsLabel')"
      >
        <NuxtLink
          v-for="action in actions"
          :key="action.name"
          :to="localePath(action.to)"
          class="group rounded-xl border border-default bg-elevated p-6 text-default no-underline transition-colors hover:bg-accented focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          <UIcon :name="action.icon" class="mb-5 size-7" aria-hidden="true" />
          <h2 class="text-2xl font-semibold">{{ $t(`simpleNavigation.${action.name}`) }}</h2>
          <p class="mt-3 text-sm leading-relaxed text-toned">
            {{ $t(`simpleNavigation.${action.name}Description`) }}
          </p>
          <span class="mt-6 inline-flex items-center gap-2 font-semibold">
            {{ $t(`simpleNavigation.${action.name}Action`) }}
            <UIcon name="i-lucide-arrow-right" class="size-4" aria-hidden="true" />
          </span>
        </NuxtLink>
      </nav>
      <p class="mt-8 max-w-2xl text-sm text-muted">{{ $t('simpleNavigation.walletHelp') }}</p>
    </UContainer>
  </div>
  <div v-else>
    <section
      class="relative isolate overflow-hidden bg-neutral-950 text-neutral-50"
      aria-labelledby="landing-title"
      data-testid="landing-hero"
    >
      <picture class="absolute inset-0 -z-10" aria-hidden="true" data-testid="landing-art">
        <img
          src="/images/xcs-orbit-hero.jpg"
          alt=""
          width="1672"
          height="941"
          fetchpriority="high"
          decoding="async"
          class="size-full object-cover opacity-60"
        />
      </picture>
      <UContainer class="py-20 sm:py-28">
        <div class="max-w-3xl min-w-0">
          <p
            class="mb-5 inline-flex items-center gap-2 text-xs font-semibold tracking-[0.2em] uppercase"
          >
            <span class="size-2 rounded-full bg-sage-300" aria-hidden="true" />{{
              $t('home.badge')
            }}
          </p>
          <h1
            id="landing-title"
            class="text-4xl leading-tight tracking-tight break-words sm:text-5xl lg:text-6xl"
          >
            {{ $t('home.title') }}
          </h1>
          <p class="mt-6 max-w-2xl text-lg text-neutral-200">{{ $t('home.description') }}</p>
          <div class="mt-8 flex flex-wrap gap-3">
            <UButton :to="localePath('/studio')" color="neutral" variant="outline" size="lg">
              <span class="font-mono" aria-hidden="true">&gt;_</span>
              {{ $t('home.start') }}
            </UButton>
            <UButton
              href="https://github.com/XRPL-Commons/XCS"
              target="_blank"
              rel="noopener noreferrer"
              color="neutral"
              variant="ghost"
              size="lg"
              class="text-neutral-50"
            >
              {{ $t('home.github') }} <span aria-hidden="true">↗</span>
            </UButton>
          </div>
          <div
            class="mt-8 inline-flex max-w-full min-w-0 flex-wrap items-center gap-3 rounded-[0.45rem] bg-neutral-900/80 px-4 py-2 font-mono text-sm ring-1 ring-neutral-700"
            :aria-label="$t('home.commandLabel')"
            data-testid="install-command"
          >
            <span aria-hidden="true">$</span>
            <code class="break-words">pnpm install</code>
          </div>
        </div>
      </UContainer>
    </section>

    <UContainer class="py-12 sm:py-16" aria-labelledby="network-overview-title">
      <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div class="min-w-0">
          <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">
            {{ $t('home.stats.eyebrow') }}
          </p>
          <h2 id="network-overview-title" class="text-3xl break-words">
            {{ $t('home.stats.title') }}
          </h2>
        </div>
        <UButton :to="localePath('/status')" color="neutral" variant="link" class="px-0">
          {{ $t('home.stats.status') }}
        </UButton>
      </div>
      <p class="mb-4 max-w-2xl text-toned">{{ $t('home.searchIntro') }}</p>
      <ExplorerSearch />
      <EmptyState v-if="pending" loading />
      <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
      <div v-else-if="stats" class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <UCard
          v-for="stat in [
            { value: stats.schemas.total, label: $t('home.stats.schemas') },
            { value: stats.schemas.publishers, label: $t('home.stats.publishers') },
            { value: stats.credentialGenerations.total, label: $t('home.stats.credentials') },
            { value: stats.checkpoint.ledgerIndex, label: $t('home.stats.ledger') },
          ]"
          :key="stat.label"
        >
          <strong class="block font-display text-3xl break-words">{{
            numberFormat.format(stat.value)
          }}</strong>
          <span class="text-sm text-muted">{{ stat.label }}</span>
        </UCard>
      </div>
    </UContainer>

    <UContainer class="py-12" aria-labelledby="landing-flow-title">
      <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">
        {{ $t('home.flowEyebrow') }}
      </p>
      <h2 id="landing-flow-title" class="mb-6 text-3xl">{{ $t('home.flowTitle') }}</h2>
      <ol class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <li
          v-for="(step, index) in ['schema', 'issue', 'accept', 'verify']"
          :key="step"
          class="min-w-0 rounded-[0.6rem] bg-elevated p-5 ring-1 ring-default"
        >
          <span class="block font-mono text-sm text-muted">0{{ index + 1 }}</span>
          {{ $t(`home.flow.${step}`) }}
        </li>
      </ol>
    </UContainer>

    <UContainer class="py-12">
      <div class="grid gap-4 sm:grid-cols-3">
        <UCard v-for="pillar in ['keys', 'data', 'trust']" :key="pillar">
          <h2 class="text-xl font-semibold">{{ $t(`home.pillars.${pillar}.title`) }}</h2>
          <p class="mt-2 text-sm text-toned">{{ $t(`home.pillars.${pillar}.copy`) }}</p>
        </UCard>
      </div>
    </UContainer>
  </div>
</template>
