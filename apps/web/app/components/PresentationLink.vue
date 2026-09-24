<script setup lang="ts">
import { renderSVG } from 'uqr'

const props = defineProps<{ url: string }>()
const copied = ref(false)
const failed = ref(false)
const qr = computed(
  () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(props.url))}`,
)
watch(
  () => props.url,
  () => {
    copied.value = false
    failed.value = false
  },
)
async function copy() {
  try {
    await navigator.clipboard.writeText(props.url)
    copied.value = true
    failed.value = false
  } catch {
    failed.value = true
  }
}
</script>
<template>
  <section
    class="mt-5 rounded border border-default p-4"
    :aria-label="$t('presentation.shareLink')"
  >
    <p class="mb-3 text-sm text-muted">{{ $t('presentation.copyOnce') }}</p>
    <label class="block font-semibold" for="presentation-created-link">{{
      $t('presentation.shareLink')
    }}</label>
    <input
      id="presentation-created-link"
      :value="url"
      readonly
      class="mt-2 w-full rounded border border-default bg-default p-3 font-mono text-sm"
      @focus="($event.target as HTMLInputElement).select()"
    />
    <img
      :src="qr"
      :alt="$t('presentation.qrAlt')"
      width="240"
      height="240"
      class="mx-auto my-4 bg-white p-3"
    />
    <UButton @click="copy">{{ $t('presentation.copy') }}</UButton>
    <p v-if="copied" role="status" class="mt-2">{{ $t('presentation.copied') }}</p>
    <p v-if="failed" role="alert" class="mt-2">{{ $t('presentation.copyFailed') }}</p>
  </section>
</template>
