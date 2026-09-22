<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    initialQuery?: string
    compact?: boolean
    autofocus?: boolean
  }>(),
  {
    initialQuery: '',
    compact: false,
    autofocus: false,
  },
)

const query = ref(props.initialQuery)
const localePath = useLocalePath()

watch(
  () => props.initialQuery,
  (value) => {
    query.value = value
  },
)

async function submitSearch(): Promise<void> {
  const normalized = query.value.trim().slice(0, 128)
  if (normalized.length < 2) return
  await navigateTo({ path: localePath('/search'), query: { q: normalized } })
}
</script>

<template>
  <form
    class="flex w-full items-center gap-2"
    :class="compact ? 'max-w-xs' : 'max-w-2xl'"
    role="search"
    data-testid="explorer-search"
    @submit.prevent="submitSearch"
  >
    <label class="sr-only" :for="compact ? 'global-explorer-search' : 'explorer-search'">
      {{ $t('explorer.search.label') }}
    </label>
    <UInput
      :id="compact ? 'global-explorer-search' : 'explorer-search'"
      v-model="query"
      type="search"
      name="q"
      maxlength="128"
      minlength="2"
      autocomplete="off"
      :autofocus="autofocus"
      :placeholder="$t('explorer.search.placeholder')"
      :size="compact ? 'sm' : 'lg'"
      class="flex-1"
    />
    <UButton type="submit" :size="compact ? 'sm' : 'md'" :disabled="query.trim().length < 2">
      {{ $t('explorer.search.submit') }}
    </UButton>
  </form>
</template>
