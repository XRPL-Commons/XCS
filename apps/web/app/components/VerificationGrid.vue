<script setup lang="ts">
withDefaults(
  defineProps<{
    report: { onChain: string; schema: string; payload: string; issuerTrust: string }
    testIdPrefix?: string
    note?: boolean
  }>(),
  { testIdPrefix: undefined, note: true },
)
</script>

<template>
  <div class="my-6">
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <article
        v-for="dimension in [
          { key: 'on-chain', label: $t('verify.onChain'), value: report.onChain },
          { key: 'schema', label: $t('verify.schema'), value: report.schema },
          { key: 'payload', label: $t('verify.payload'), value: report.payload },
          { key: 'trust', label: $t('verify.trust'), value: report.issuerTrust },
        ]"
        :key="dimension.key"
        class="flex items-center justify-between gap-3 rounded-[0.6rem] bg-elevated px-4 py-3 ring-1 ring-default"
        :data-testid="testIdPrefix ? `${testIdPrefix}-${dimension.key}` : undefined"
      >
        <span class="text-sm font-semibold">{{ dimension.label }}</span>
        <StatusPill :value="dimension.value" />
      </article>
    </div>
    <p v-if="note" class="mt-3 border-l-2 border-accented pl-3 text-sm text-toned">
      {{ $t('verify.trustNote') }}
    </p>
  </div>
</template>
