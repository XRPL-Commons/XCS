<script setup lang="ts">
const props = withDefaults(defineProps<{ code: string; flush?: boolean }>(), { flush: false })
const marginClass = computed(() => (props.flush ? 'my-0' : 'my-4'))
</script>

<template>
  <pre
    :class="marginClass"
    class="overflow-x-auto rounded-[0.6rem] bg-neutral-950 p-4 text-[0.8rem] leading-relaxed whitespace-pre-wrap text-neutral-50"
  ><code>{{ code }}</code></pre>
</template>
