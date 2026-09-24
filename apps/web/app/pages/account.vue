<script setup lang="ts">
import { useWallet as useXrplConnectWallet } from '@xrpl-commons/xrpl-connect-vue'
import { signWalletLinkChallenge } from '~/utils/walletLinkProof'
import { supportsWalletLinkProof, walletLinkReturnPath } from '~/utils/roleJourney'

definePageMeta({ middleware: ['auth'] })
const { locale, t } = useI18n()
const localePath = useLocalePath()
const route = useRoute()
const onboarding = computed(() => route.query.returnTo !== undefined)
const returnPath = computed(() => walletLinkReturnPath(route.query.returnTo, locale.value))
const auth = useAuth()
const { user, expiresAt, absoluteExpiresAt } = auth
const wallet = import.meta.client ? useXrplConnectWallet() : undefined
const { account: walletAccount } = useWallet()
const busy = ref(false)
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})
const error = ref('')
const notice = ref('')
const canLink = computed(() => {
  // Read Vue's account ref before the SDK's plain getters can short-circuit tracking.
  const current = walletAccount.value
  return Boolean(
    current?.network.id === 'testnet' &&
    wallet?.manager.connected &&
    supportsWalletLinkProof(wallet.manager.wallet?.id ?? '') &&
    wallet.manager.supports('signMessage'),
  )
})
const isLinked = computed(() =>
  user.value?.wallets.some(
    (link) => link.address === walletAccount.value?.address && link.networkId === 1,
  ),
)
const hasLinkedWallet = computed(
  () => user.value?.wallets.some((link) => link.networkId === 1) === true,
)
const formatDate = (value?: string) =>
  value
    ? new Intl.DateTimeFormat(locale.value, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value))
    : '—'

async function action(work: () => Promise<void>, success?: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await work()
    if (success) notice.value = t(success)
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : ''
    error.value = t(
      code.startsWith('WALLET_LINK_SESSION_CHANGED') ? 'auth.walletChanged' : 'auth.actionFailed',
    )
  } finally {
    busy.value = false
  }
}

async function link(): Promise<void> {
  const current = walletAccount.value
  const manager = wallet?.manager
  if (!current || !manager || !canLink.value) throw new Error('WALLET_LINK_UNSUPPORTED')
  const challenge = await auth.createWalletChallenge(current.address)
  const proof = await signWalletLinkChallenge(
    manager,
    { address: current.address, networkId: 'testnet' },
    challenge.message,
  )
  await auth.linkWallet(challenge.id, proof)
}

async function logout(): Promise<void> {
  await auth.logout()
  await navigateTo(localePath('/auth/login'))
}

useSeoMeta({ title: () => `${t('auth.account')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader
      :title="$t(onboarding ? 'roleJourney.walletTitle' : 'auth.account')"
      :lead="$t(onboarding ? 'roleJourney.walletIntro' : 'auth.accountIntro')"
    />
    <StatusBox v-if="error" tone="error" class="mb-5" role="alert">{{ error }}</StatusBox>
    <StatusBox v-if="notice" tone="success" class="mb-5" role="status">{{ notice }}</StatusBox>
    <template v-if="user">
      <UCard v-if="!onboarding">
        <h2 class="text-xl font-semibold">{{ $t('auth.profile') }}</h2>
        <MetadataList class="mt-4">
          <dt>{{ $t('auth.name') }}</dt>
          <dd>{{ user.displayName ?? '—' }}</dd>
          <dt>{{ $t('auth.email') }}</dt>
          <dd>{{ user.email ?? '—' }}</dd>
          <dt>{{ $t('auth.personalRoles') }}</dt>
          <dd>{{ user.roles.map((role) => $t(`auth.roles.${role}`)).join(', ') || '—' }}</dd>
          <dt>{{ $t('auth.sessionExpires') }}</dt>
          <dd>{{ formatDate(expiresAt) }} UTC</dd>
          <dt>{{ $t('auth.sessionMaximum') }}</dt>
          <dd>{{ formatDate(absoluteExpiresAt) }} UTC</dd>
        </MetadataList>
        <div class="mt-5 flex flex-wrap gap-3">
          <UButton
            :disabled="!mounted || busy"
            @click="action(auth.refresh, 'auth.sessionExtended')"
            >{{ $t('auth.extendSession') }}</UButton
          >
          <UButton
            :disabled="!mounted || busy"
            color="neutral"
            variant="outline"
            data-testid="auth-logout"
            @click="action(logout)"
            >{{ $t('auth.signOut') }}</UButton
          >
        </div>
        <p class="mt-3 text-sm text-muted">{{ $t('auth.signOutHelp') }}</p>
      </UCard>

      <section v-if="!onboarding" class="mt-8" aria-labelledby="account-organizations">
        <h2 id="account-organizations" class="text-2xl font-semibold">
          {{ $t('auth.organizations') }}
        </h2>
        <p v-if="!user.organizations.length" class="mt-3 text-muted">
          {{ $t('auth.noOrganizations') }}
        </p>
        <ul v-else class="mt-4 grid gap-3 sm:grid-cols-2">
          <li v-for="organization in user.organizations" :key="organization.id">
            <UCard>
              <h3 class="font-semibold">{{ organization.name }}</h3>
              <p class="mt-1 text-sm text-muted">
                {{ organization.roles.map((role) => $t(`auth.roles.${role}`)).join(', ') }}
              </p>
            </UCard>
          </li>
        </ul>
        <UButton v-if="auth.hasRole('issuer')" class="mt-4" :to="localePath('/issuer')">{{
          $t('auth.issuerSpace')
        }}</UButton>
      </section>

      <section class="mt-8" aria-labelledby="account-wallets">
        <h2 id="account-wallets" class="text-2xl font-semibold">{{ $t('auth.linkedWallets') }}</h2>
        <StatusBox v-if="hasLinkedWallet" class="mt-6" tone="success">{{
          $t('roleJourney.walletReady')
        }}</StatusBox>
        <UButton
          v-if="hasLinkedWallet"
          :to="returnPath"
          class="mt-3"
          data-testid="wallet-link-continue"
          >{{ $t('roleJourney.continueRecipient') }}</UButton
        >

        <details
          class="my-5 rounded border border-default p-5"
          :open="!hasLinkedWallet && !canLink"
          aria-labelledby="wallet-onboarding"
        >
          <summary id="wallet-onboarding" class="cursor-pointer text-lg font-semibold">
            {{ $t('roleJourney.walletGuide') }}
          </summary>
          <ol class="mt-4 list-decimal space-y-4 pl-5">
            <li>
              <strong>{{ $t('roleJourney.setupTitle') }}</strong>
              <p class="mt-1 text-sm text-muted">{{ $t('roleJourney.setupHelp') }}</p>
            </li>
            <li>
              <strong>{{ $t('roleJourney.backupTitle') }}</strong>
              <p class="mt-1 text-sm text-muted">{{ $t('roleJourney.backupHelp') }}</p>
            </li>
            <li>
              <strong>{{ $t('roleJourney.networkTitle') }}</strong>
              <p class="mt-1 text-sm text-muted">{{ $t('roleJourney.networkHelp') }}</p>
            </li>
            <li>
              <strong>{{ $t('roleJourney.proofTitle') }}</strong>
              <p class="mt-1 text-sm text-muted">{{ $t('auth.walletLinkHelp') }}</p>
            </li>
          </ol>
        </details>
        <ClientOnly
          ><div class="mt-5"><WalletButton proof-only test-id-prefix="wallet-link" /></div
        ></ClientOnly>
        <p v-if="!canLink && !hasLinkedWallet" class="mt-3 text-sm text-muted">
          {{ $t('roleJourney.walletSelectionHelp') }}
        </p>
        <p class="mt-3 text-toned">{{ $t('auth.walletLinkHelp') }}</p>
        <details class="mt-2 text-sm text-muted">
          <summary class="cursor-pointer">{{ $t('simpleRecipient.walletCompatibility') }}</summary>
          <p class="mt-2">{{ $t('auth.masterKeyOnly') }}</p>
        </details>
        <p v-if="!user.wallets.length" class="mt-4 text-muted">{{ $t('auth.noWallets') }}</p>
        <details v-else class="mt-4 rounded border border-default p-4">
          <summary class="cursor-pointer font-semibold">
            {{ $t('simpleRecipient.manageWallet') }}
          </summary>
          <div class="mt-3 overflow-x-auto">
            <table class="w-full text-left text-sm" data-testid="linked-wallets">
              <caption class="sr-only">
                {{
                  $t('auth.linkedWallets')
                }}
              </caption>
              <thead>
                <tr class="border-b border-default">
                  <th class="p-3" scope="col">{{ $t('auth.walletAddress') }}</th>
                  <th class="p-3" scope="col">{{ $t('auth.network') }}</th>
                  <th class="p-3" scope="col">{{ $t('auth.verifiedAt') }}</th>
                  <th class="p-3" scope="col">{{ $t('auth.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="linked in user.wallets" :key="linked.id" class="border-b border-default">
                  <td class="p-3 font-mono break-all">{{ linked.address }}</td>
                  <td class="p-3">
                    {{ linked.networkId === 1 ? 'XRPL Testnet' : linked.networkId }}
                  </td>
                  <td class="p-3">{{ formatDate(linked.verifiedAt) }} UTC</td>
                  <td class="p-3">
                    <UButton
                      :disabled="!mounted || busy"
                      color="neutral"
                      variant="outline"
                      :aria-label="$t('auth.unlinkAddress', { address: linked.address })"
                      @click="action(() => auth.unlinkWallet(linked.id), 'auth.walletUnlinked')"
                      >{{ $t('auth.unlink') }}</UButton
                    >
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
        <ClientOnly>
          <div class="mt-5">
            <details v-if="walletAccount && !isLinked" class="mb-3 text-sm">
              <summary class="cursor-pointer">{{ $t('simpleRecipient.walletDetails') }}</summary>
              <p class="mt-2 break-all font-mono">{{ walletAccount.address }}</p>
            </details>
            <p v-if="!walletAccount" class="mb-3 text-muted">
              {{ $t('roleJourney.connectFirst') }}
            </p>
            <p v-else-if="!canLink" class="mb-3 text-muted">{{ $t('auth.walletUnsupported') }}</p>
            <p v-else-if="isLinked" class="mb-3 text-muted">{{ $t('auth.alreadyLinked') }}</p>
            <UButton
              :disabled="!mounted || busy || !canLink || isLinked"
              :loading="busy"
              data-testid="auth-link-wallet"
              @click="action(link, 'auth.walletLinked')"
              >{{ $t('auth.linkCurrentWallet') }}</UButton
            >
          </div>
        </ClientOnly>
        <UButton
          v-if="onboarding"
          :to="localePath('/account')"
          color="neutral"
          variant="link"
          class="mt-3 ml-3"
          >{{ $t('auth.account') }}</UButton
        >
      </section>
    </template>
    <UButton v-else :to="localePath('/auth/login')">{{ $t('auth.signIn') }}</UButton>
  </UContainer>
</template>
