<script setup lang="ts">
import { hasControlledPilotProfileId } from '~/utils/controlledPilotProfile'
import { displayDate, displayXrplTime } from '~/utils/explorer'

const { locale, t } = useI18n()
const { getActiveNetworkProfile, getNetworkStatus, getStats } = useXcsApi()
const { data, pending, error, refresh } = await useAsyncData('network-overview', async () => {
  const profile = await getActiveNetworkProfile()
  const [status, stats] = await Promise.all([
    getNetworkStatus(profile.profileId),
    getStats(profile.profileId),
  ])
  return { profile, status, stats }
})
const updatedAt = computed(() => displayDate(data.value?.status.updatedAt, locale.value))
const checkpointCloseTime = computed(() =>
  displayXrplTime(data.value?.stats.checkpoint.closeTime, locale.value),
)
const registryLabel = computed(() =>
  hasControlledPilotProfileId(data.value?.profile.profileId)
    ? t('networkStatus.controlledRegistry')
    : t('networkStatus.registry'),
)

useSeoMeta({
  title: () => `${t('networkStatus.title')} — XCS`,
  description: () => t('networkStatus.description'),
  robots: 'index,follow',
})
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      eyebrow="Explorer · Network"
      :title="$t('networkStatus.title')"
      :lead="$t('networkStatus.description')"
    />

    <EmptyState v-if="pending" loading />
    <ExplorerError v-else-if="error" :error="error" @retry="refresh" />
    <template v-else-if="data">
      <div class="flex flex-wrap items-center gap-3">
        <StatusPill :value="data.status.state" />
        <strong>{{ $t(`networkStatus.states.${data.status.state}`) }}</strong>
      </div>
      <p class="my-4 border-l-2 border-accented pl-3 text-sm text-toned">
        {{ $t('networkStatus.failClosed') }}
      </p>
      <MetadataList data-testid="explorer-metadata">
        <dt>{{ $t('networkStatus.profile') }}</dt>
        <dd>
          <code>{{ data.profile.profileId }}</code>
        </dd>
        <dt>{{ $t('networkStatus.networkId') }}</dt>
        <dd>{{ data.profile.networkId }}</dd>
        <dt>{{ registryLabel }}</dt>
        <dd>
          <code>{{ data.profile.registryAddress }}</code>
        </dd>
        <dt>{{ $t('networkStatus.activation') }}</dt>
        <dd>
          {{ data.profile.activationLedgerIndex }} ·
          <code>{{ data.profile.activationLedgerHash }}</code>
        </dd>
        <dt>{{ $t('networkStatus.primaryTip') }}</dt>
        <dd>{{ data.status.sourceTips.primary ?? '—' }}</dd>
        <dt>{{ $t('networkStatus.secondaryTip') }}</dt>
        <dd>{{ data.status.sourceTips.secondary ?? '—' }}</dd>
        <dt>{{ $t('networkStatus.agreedLedger') }}</dt>
        <dd v-if="data.status.lastAgreedLedger">
          {{ data.status.lastAgreedLedger.index }} ·
          <code>{{ data.status.lastAgreedLedger.hash }}</code>
        </dd>
        <dd v-else>—</dd>
        <dt>{{ $t('networkStatus.authoritativeCheckpoint') }}</dt>
        <dd>
          {{ data.stats.checkpoint.ledgerIndex }} ·
          <code>{{ data.stats.checkpoint.ledgerHash }}</code>
        </dd>
        <dt>{{ $t('networkStatus.checkpointTime') }}</dt>
        <dd>{{ checkpointCloseTime ?? data.stats.checkpoint.closeTime }}</dd>
        <dt>{{ $t('networkStatus.transactionRoot') }}</dt>
        <dd>
          <code>{{ data.stats.checkpoint.transactionRoot }}</code>
        </dd>
        <dt>{{ $t('networkStatus.updated') }}</dt>
        <dd>{{ updatedAt ?? data.status.updatedAt }}</dd>
        <template v-if="data.status.errorCode">
          <dt>{{ $t('networkStatus.errorCode') }}</dt>
          <dd>
            <code>{{ data.status.errorCode }}</code>
          </dd>
        </template>
      </MetadataList>
    </template>
  </UContainer>
</template>
