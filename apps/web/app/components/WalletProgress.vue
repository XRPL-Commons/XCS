<script setup lang="ts">
defineProps<{ stage: 'prepare' | 'connect' | 'prove' | 'ready' }>()
const steps = ['prepare', 'connect', 'prove', 'ready'] as const
</script>

<template>
  <ol class="grid gap-3 sm:grid-cols-4" :aria-label="$t('portal.walletProgress.title')">
    <li
      v-for="(step, index) in steps"
      :key="step"
      class="rounded border border-default p-3"
      :aria-current="step === stage ? 'step' : undefined"
    >
      <span class="text-sm text-muted">{{ index + 1 }}</span>
      <p class="font-semibold">{{ $t(`portal.walletProgress.${step}`) }}</p>
    </li>
  </ol>
</template>
