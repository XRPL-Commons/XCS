<script setup lang="ts">
const { locale, locales, setLocale, t } = useI18n()
const localePath = useLocalePath()
const clientReady = ref(false)

const localeItems = computed(() =>
  locales.value.map((item) =>
    typeof item === 'string'
      ? { label: item, value: item }
      : { label: item.name, value: item.code },
  ),
)

const navigation = computed(() => [
  { label: t('nav.explorer'), to: localePath('/schemas') },
  { label: t('nav.create'), to: localePath('/studio') },
  { label: t('nav.verify'), to: localePath('/verify') },
  { label: t('nav.docs'), to: localePath('/developers') },
])

const footerLinks = computed(() => [
  { label: t('nav.schemas'), to: localePath('/schemas') },
  { label: t('nav.create'), to: localePath('/studio') },
  { label: t('nav.docs'), to: localePath('/developers') },
  { label: t('nav.activity'), to: localePath('/activity') },
  { label: t('nav.status'), to: localePath('/status') },
])

onMounted(() => {
  clientReady.value = true
})
</script>

<template>
  <div class="flex min-h-screen flex-col" :data-client-ready="clientReady ? 'true' : 'false'">
    <a
      class="fixed top-3 left-3 z-[100] -translate-y-[150%] rounded-[0.45rem] bg-neutral-950 px-4 py-3 font-bold text-white no-underline focus:translate-y-0"
      href="#main-content"
    >
      {{ $t('nav.skip') }}
    </a>

    <UHeader
      :ui="{
        root: 'bg-default/95 backdrop-blur-lg',
        container: 'px-3 sm:px-6 gap-2 sm:gap-3',
        left: 'gap-1 sm:gap-1.5',
        right: 'gap-1 sm:gap-1.5',
      }"
    >
      <template #left>
        <NuxtLink
          :to="localePath('/')"
          class="inline-flex items-center gap-2 text-lg font-extrabold tracking-tight sm:gap-3 sm:text-2xl"
          aria-label="XCS home"
        >
          <span
            class="relative size-7 rounded-full sm:size-9 bg-neutral-950 after:absolute after:inset-[28%] after:rounded-full after:bg-neutral-50 after:content-['']"
            aria-hidden="true"
          />
          <span>XCS</span>
        </NuxtLink>
      </template>

      <UNavigationMenu :items="navigation" data-testid="primary-nav" :aria-label="$t('nav.main')" />

      <template #right>
        <ExplorerSearch compact class="hidden md:flex" />
        <div class="hidden md:block">
          <label class="sr-only" for="locale">{{ $t('nav.language') }}</label>
          <USelect
            id="locale"
            :model-value="locale"
            :items="localeItems"
            size="sm"
            class="w-28"
            @update:model-value="setLocale($event as 'fr' | 'en')"
          />
        </div>
        <WalletButton />
      </template>

      <template #body>
        <UNavigationMenu :items="navigation" orientation="vertical" class="-mx-2.5" />
        <ExplorerSearch compact class="mt-4" />
        <div class="mt-4 md:hidden">
          <label class="sr-only" for="locale-mobile">{{ $t('nav.language') }}</label>
          <USelect
            id="locale-mobile"
            :model-value="locale"
            :items="localeItems"
            size="sm"
            class="w-28"
            @update:model-value="setLocale($event as 'fr' | 'en')"
          />
        </div>
      </template>
    </UHeader>

    <UMain id="main-content" tabindex="-1" class="flex-1 outline-none">
      <slot />
    </UMain>

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">{{ $t('footer.summary') }}</p>
      </template>
      <nav class="flex flex-wrap gap-x-5 gap-y-2 text-sm" :aria-label="$t('footer.navigation')">
        <NuxtLink
          v-for="link in footerLinks"
          :key="link.to"
          :to="link.to"
          class="text-muted hover:text-default"
        >
          {{ link.label }}
        </NuxtLink>
        <a
          class="text-muted hover:text-default"
          href="https://github.com/XRPLF/XRPL-Standards"
          rel="noreferrer"
        >
          XRPL Standards
        </a>
      </nav>
    </UFooter>
  </div>
</template>
