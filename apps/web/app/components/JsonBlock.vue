<script setup lang="ts">
defineProps<{ code: string }>()
</script>

<template>
  <pre
    class="my-4 overflow-x-auto rounded-[0.6rem] bg-neutral-950 p-4 text-[0.8rem] leading-relaxed whitespace-pre-wrap text-neutral-50"
  ><code>{{ code }}</code></pre>
</template>
