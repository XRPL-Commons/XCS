<script setup lang="ts">
defineProps<{ claims: Record<string, unknown> }>()

function nestedFields(value: object): Record<string, unknown> {
  return Array.isArray(value)
    ? Object.fromEntries(value.map((item, index) => [String(index + 1), item]))
    : Object.fromEntries(Object.entries(value))
}
</script>

<template>
  <dl class="grid gap-3" data-testid="attestation-fields">
    <div v-for="(value, key) in claims" :key="key" class="rounded border border-default p-3">
      <dt class="font-semibold break-words">{{ key }}</dt>
      <dd class="mt-1 break-words whitespace-pre-wrap">
        <AttestationFields
          v-if="value !== null && typeof value === 'object'"
          class="mt-2"
          :claims="nestedFields(value)"
        />
        <template v-else-if="value === null">{{ $t('simpleUi.notProvided') }}</template>
        <template v-else-if="typeof value === 'boolean'">{{
          $t(value ? 'simpleUi.yes' : 'simpleUi.no')
        }}</template>
        <template v-else>{{ String(value) }}</template>
      </dd>
    </div>
  </dl>
</template>
