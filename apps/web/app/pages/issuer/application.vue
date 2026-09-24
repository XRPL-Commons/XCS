<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })
const { t } = useI18n()
const localePath = useLocalePath()
const { data, error, refresh } = useIssuerWorkspace()
useSeoMeta({ title: () => `${t('issuer.application')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="max-w-3xl py-10">
    <PageHeader :title="$t('issuer.application')" :lead="$t('issuer.approvalMeaning')" />
    <StatusBox v-if="error" tone="error" role="alert"
      >{{ $t('issuer.error')
      }}<UButton class="ml-3" @click="refresh()">{{ $t('issuer.retry') }}</UButton></StatusBox
    >
    <p v-if="data && !data.organizations.length" class="mb-5">{{ $t('issuer.noApplications') }}</p>
    <ul class="grid gap-5">
      <li v-for="org in data?.organizations" :key="org.id">
        <UCard>
          <h2 class="text-xl font-semibold">{{ org.name }}</h2>
          <p class="mt-2">{{ $t(`issuer.states.${org.applicationStatus}`) }}</p>
          <p v-if="org.reviewReason" class="mt-2 whitespace-pre-wrap">{{ org.reviewReason }}</p>
          <p v-if="org.applicationStatus === 'pending'" class="mt-3 text-muted">
            {{ $t('issuer.pendingHelp') }}
          </p>
          <p
            v-if="org.applicationStatus === 'rejected' || org.applicationStatus === 'suspended'"
            class="mt-3 text-muted"
          >
            {{ $t('issuer.declinedHelp') }}
          </p>
          <UButton
            v-if="org.status === 'active' && org.applicationStatus === 'approved'"
            :to="{ path: localePath('/issuer/schemas'), query: { organizationId: org.id } }"
            class="mt-5"
            >{{ $t('issuer.openWorkspace') }}</UButton
          >
        </UCard>
      </li>
    </ul>
    <UButton :to="localePath('/issuer/apply')" class="mt-5">{{ $t('issuer.apply') }}</UButton>
  </UContainer>
</template>
