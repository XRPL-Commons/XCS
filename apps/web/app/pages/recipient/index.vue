<script setup lang="ts">
import type { RecipientCredential } from '../../../server/xcs/recipient/types'

definePageMeta({ middleware: ['auth'] })
const { t, locale } = useI18n()
const auth = useAuth()
const hasLinkedWallet = computed(
  () => auth.user.value?.wallets.some((wallet) => wallet.networkId === 1) === true,
)
const localePath = useLocalePath()
const { data, error, status, refresh } = useRecipientWorkspace()
const groups = computed(() => [
  {
    key: 'ready',
    credentials: data.value?.credentials.filter((item) => item.status.state === 'pending') ?? [],
  },
  {
    key: 'accepted',
    credentials: data.value?.credentials.filter((item) => item.status.state === 'active') ?? [],
  },
  {
    key: 'inactive',
    credentials:
      data.value?.credentials.filter(
        (item) => !['active', 'pending'].includes(item.status.state),
      ) ?? [],
  },
])
const waiting = computed(() => data.value?.invitations.filter((item) => !item.generationId) ?? [])
function credentialLink(item: Pick<RecipientCredential, 'generationId' | 'profileId'>) {
  return {
    path: localePath(`/recipient/credentials/${item.generationId}`),
    query: { profile: item.profileId },
  }
}
const date = (value: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(value))
useSeoMeta({ title: () => `${t('recipient.title')} — XCS`, robots: 'noindex,nofollow' })
</script>
<template>
  <UContainer class="max-w-5xl py-10">
    <PageHeader :title="$t('recipient.title')" :lead="$t('recipient.intro')">
      <template #actions>
        <UButton
          :to="{ path: localePath('/account'), query: { returnTo: localePath('/recipient') } }"
          color="neutral"
          variant="outline"
          >{{
            $t(hasLinkedWallet ? 'simpleRecipient.manageWallet' : 'roleJourney.prepareWallet')
          }}</UButton
        >
        <UButton :loading="status === 'pending'" @click="refresh()">{{
          $t('recipient.refresh')
        }}</UButton>
      </template>
    </PageHeader>
    <StatusBox v-if="error" tone="error" role="alert">{{ $t('recipient.error') }}</StatusBox>
    <p v-else-if="status === 'pending'">{{ $t('issuer.loading') }}</p>
    <template v-else-if="data">
      <section
        v-if="data.notifications.length"
        class="mb-8"
        aria-labelledby="recipient-notifications"
      >
        <h2 id="recipient-notifications" class="text-xl font-semibold">
          {{ $t('recipient.notifications') }}
        </h2>
        <ul class="mt-3 grid gap-2">
          <li
            v-for="notice in data.notifications"
            :key="notice.id"
            class="rounded border border-default p-3"
          >
            <NuxtLink :to="credentialLink(notice)">{{
              $t(`recipient.notification.${notice.kind}`, { issuer: notice.organizationName })
            }}</NuxtLink>
            <time :datetime="notice.createdAt" class="ml-3 text-sm text-muted">{{
              date(notice.createdAt)
            }}</time>
          </li>
        </ul>
      </section>
      <p v-if="!data.invitations.length && !data.credentials.length" class="mb-6 text-muted">
        {{ $t('recipient.empty') }}
      </p>
      <section v-if="waiting.length" class="mb-8" aria-labelledby="recipient-waiting">
        <h2 id="recipient-waiting" class="text-xl font-semibold">{{ $t('recipient.waiting') }}</h2>
        <ul class="mt-3 grid gap-3 sm:grid-cols-2">
          <li v-for="invite in waiting" :key="invite.id">
            <UCard>
              <h3 class="font-semibold">{{ invite.schemaName ?? $t('recipient.credential') }}</h3>
              <p class="mt-1">{{ invite.organizationName }}</p>
              <p class="mt-3 text-sm text-muted">
                {{
                  $t(
                    invite.revokedAt
                      ? 'recipient.invitationInactive'
                      : hasLinkedWallet
                        ? 'recipient.waitingHelp'
                        : 'roleJourney.walletRequiredBeforeIssuance',
                  )
                }}
              </p>
              <UButton
                v-if="!invite.revokedAt && !hasLinkedWallet"
                class="mt-4"
                :to="{
                  path: localePath('/account'),
                  query: { returnTo: localePath('/recipient') },
                }"
                >{{ $t('roleJourney.prepareWallet') }}</UButton
              >
            </UCard>
          </li>
        </ul>
      </section>
      <section
        v-for="group in groups"
        :key="group.key"
        class="mb-8"
        :aria-labelledby="`recipient-${group.key}`"
      >
        <h2 :id="`recipient-${group.key}`" class="text-xl font-semibold">
          {{ $t(`recipient.${group.key}`) }} ({{ group.credentials.length }})
        </h2>
        <p v-if="!group.credentials.length" class="mt-3 text-sm text-muted">
          {{ $t('recipient.noItems') }}
        </p>
        <ul v-else class="mt-3 grid gap-3 sm:grid-cols-2">
          <li
            v-for="credential in group.credentials"
            :key="`${credential.profileId}:${credential.generationId}`"
          >
            <UCard>
              <h3 class="font-semibold">
                {{ credential.schemaName ?? $t('recipient.credential') }}
              </h3>
              <p class="mt-1">{{ credential.organizationName }}</p>
              <AttestationStatus class="mt-3" :value="credential.status.state" />
              <p class="mt-3 text-sm text-muted">
                {{ $t(`recipient.visibility.${credential.visibility}`) }}
              </p>
              <UButton :to="credentialLink(credential)" class="mt-4">{{
                $t(group.key === 'ready' ? 'simpleRecipient.reviewAttestation' : 'recipient.open')
              }}</UButton>
            </UCard>
          </li>
        </ul>
      </section>
    </template>
  </UContainer>
</template>
