<script setup lang="ts">
import { connectAndValidateNetwork } from '#xcs/sdk/index.js'
import {
  loadWalletCredentialCandidates,
  resolveWalletCredentialInbox,
  type WalletCredentialInboxItem,
} from '~/utils/credentialInbox'
import { displayDate, httpStatusFromError } from '~/utils/explorer'
import { buildCredentialAcceptLink } from '~/utils/operationLinks'
import { assertPublicRpcUrl } from '~/utils/publicRpcUrl'

const { t, locale } = useI18n()
const localePath = useLocalePath()
const { $xrplClientFactory } = useNuxtApp()
const { account } = useWallet()
const { getActiveNetworkProfile, getCredential } = useXcsApi()
const credentials = shallowRef<WalletCredentialInboxItem[]>([])
const profileId = ref('')
const loading = ref(false)
const errorCode = ref('')
let requestRevision = 0

const subject = computed(() => account.value?.address ?? '')

function actionLink(credential: WalletCredentialInboxItem): string {
  return buildCredentialAcceptLink({
    profileId: profileId.value,
    issuer: credential.issuer,
    schemaUid: credential.schemaUid,
    generationId: credential.generationId,
    action: credential.state === 'expired' ? 'reject' : 'accept',
  })
}

function expirationLabel(credential: WalletCredentialInboxItem): string {
  if (credential.expiration === null) return t('walletSpace.noExpiration')
  return displayDate(credential.expiration, locale.value) ?? credential.expiration
}

async function refresh(): Promise<void> {
  const request = ++requestRevision
  const expectedSubject = subject.value
  credentials.value = []
  profileId.value = ''
  errorCode.value = ''
  if (!expectedSubject) {
    loading.value = false
    return
  }

  loading.value = true
  const config = useRuntimeConfig()
  const client = $xrplClientFactory(assertPublicRpcUrl(config.public.rpcUrl))
  try {
    const profile = await getActiveNetworkProfile()
    await connectAndValidateNetwork(client, profile)
    const candidates = await loadWalletCredentialCandidates(client, expectedSubject)
    const pendingCredentials = await resolveWalletCredentialInbox(candidates, async (candidate) => {
      try {
        return await getCredential(
          candidate.issuer,
          candidate.subject,
          candidate.schemaUid,
          profile.profileId,
        )
      } catch (error) {
        // A native 32-byte CredentialType is only XCS when the exact projection
        // recognizes its schema and generation. Non-XCS tuples are omitted.
        if (httpStatusFromError(error) === 404) return undefined
        throw error
      }
    })
    if (request !== requestRevision || subject.value !== expectedSubject) return
    profileId.value = profile.profileId
    credentials.value = pendingCredentials
  } catch (error) {
    if (request !== requestRevision || subject.value !== expectedSubject) return
    errorCode.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (client.isConnected()) await client.disconnect().catch(() => undefined)
    if (request === requestRevision) loading.value = false
  }
}

watch(subject, () => void refresh(), { immediate: true })
onBeforeUnmount(() => {
  requestRevision += 1
})

useSeoMeta({
  title: () => `${t('walletSpace.title')} — XCS`,
  description: () => t('walletSpace.description'),
  robots: 'noindex,nofollow',
})
</script>

<template>
  <UContainer class="py-8 sm:py-12">
    <PageHeader
      eyebrow="Wallet · XRPL Testnet"
      :title="$t('walletSpace.title')"
      :lead="$t('walletSpace.description')"
    >
      <template #actions>
        <UButton
          v-if="account"
          color="neutral"
          variant="outline"
          :disabled="loading"
          data-testid="wallet-inbox-refresh"
          @click="refresh"
        >
          {{ $t('walletSpace.refresh') }}
        </UButton>
      </template>
    </PageHeader>
    <EmptyState v-if="!account" data-testid="wallet-inbox-disconnected">{{
      $t('walletSpace.connectFirst')
    }}</EmptyState>
    <template v-else>
      <StatusBox>
        <strong>{{ $t('walletSpace.address') }}</strong>
        <code class="block">{{ account.address }}</code>
      </StatusBox>
      <p class="mb-6 text-sm text-muted">{{ $t('walletSpace.privacy') }}</p>
      <p v-if="loading" class="py-8 text-muted" role="status">{{ $t('walletSpace.loading') }}</p>
      <StatusBox v-else-if="errorCode" tone="error" :title="$t('walletSpace.error')">
        <p>
          <code>{{ errorCode }}</code>
        </p>
        <UButton color="neutral" variant="outline" @click="refresh">{{
          $t('common.retry')
        }}</UButton>
      </StatusBox>
      <EmptyState v-else-if="credentials.length === 0" data-testid="wallet-inbox-empty">{{
        $t('walletSpace.empty')
      }}</EmptyState>
      <div v-else class="grid gap-6" data-testid="wallet-inbox-list">
        <UCard
          v-for="credential in credentials"
          :key="credential.ledgerObjectId"
          data-testid="wallet-inbox-credential"
        >
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p class="text-xs font-semibold tracking-[0.2em] text-muted uppercase">
                  {{ $t(`walletSpace.states.${credential.state}`) }}
                </p>
                <h2 class="text-xl font-semibold">{{ $t('walletSpace.credential') }}</h2>
              </div>
              <UButton :to="localePath(actionLink(credential))">
                {{
                  $t(
                    credential.state === 'expired'
                      ? 'walletSpace.reviewExpired'
                      : 'walletSpace.reviewPending',
                  )
                }}
              </UButton>
            </div>
          </template>
          <MetadataList>
            <dt>{{ $t('walletSpace.issuer') }}</dt>
            <dd>
              <code>{{ credential.issuer }}</code>
            </dd>
            <dt>{{ $t('walletSpace.schema') }}</dt>
            <dd>
              <code>{{ credential.schemaUid }}</code>
            </dd>
            <dt>{{ $t('walletSpace.expiration') }}</dt>
            <dd>{{ expirationLabel(credential) }}</dd>
            <dt>{{ $t('walletSpace.generation') }}</dt>
            <dd>
              <code>{{ credential.generationId }}</code>
            </dd>
          </MetadataList>
        </UCard>
      </div>
    </template>
  </UContainer>
</template>
