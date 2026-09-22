<script setup lang="ts">
const props = withDefaults(
  defineProps<{ tone?: 'error' | 'warning' | 'success' | 'notice'; title?: string }>(),
  { tone: 'notice', title: undefined },
)
const attrs = useAttrs()

const color = computed(
  () => ({ error: 'error', warning: 'warning', success: 'success', notice: 'neutral' }) as const,
)
const testId = computed(() =>
  props.tone === 'error' && attrs['data-testid'] === undefined ? 'status-error' : undefined,
)
</script>

<template>
  <UAlert
    :color="color[tone]"
    variant="subtle"
    :title="title"
    :role="tone === 'error' ? 'alert' : undefined"
    :data-testid="testId"
    :data-tone="tone"
    class="mb-4"
  >
    <template #description>
      <div class="space-y-2 text-sm [&_code]:font-mono">
        <slot />
      </div>
    </template>
  </UAlert>
</template>
