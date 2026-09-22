<script setup lang="ts">
const props = defineProps<{
  readonly title: string
  readonly code: string
  readonly copyLabel: string
  readonly copiedLabel: string
  readonly copyErrorLabel: string
}>()

const copyState = ref<'idle' | 'copied' | 'error'>('idle')

watch(
  () => props.code,
  () => {
    copyState.value = 'idle'
  },
)

async function copyCode(): Promise<void> {
  copyState.value = 'idle'
  try {
    if (!import.meta.client || navigator.clipboard === undefined) {
      throw new Error('CLIPBOARD_UNAVAILABLE')
    }
    await navigator.clipboard.writeText(props.code)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'error'
  }
}
</script>

<template>
  <UCard class="mb-6">
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-lg font-semibold">{{ title }}</h3>
        <UButton color="neutral" variant="outline" size="sm" @click="copyCode">
          {{ copyLabel }}
        </UButton>
      </div>
    </template>
    <JsonBlock :code="code" class="my-0" />
    <p v-if="copyState === 'copied'" class="mt-3 text-sm text-muted" role="status">
      {{ copiedLabel }}
    </p>
    <p v-else-if="copyState === 'error'" class="mt-3 text-sm text-error" role="status">
      {{ copyErrorLabel }}
    </p>
  </UCard>
</template>
