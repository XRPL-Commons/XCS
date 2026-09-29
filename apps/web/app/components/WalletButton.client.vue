<script setup lang="ts">
import { useWallet as useXrplConnectWallet } from '@xrpl-commons/xrpl-connect-vue'
import { CrossmarkSDK, isWalletError, WalletErrorCode } from 'xrpl-connect'
import { bindCrossmarkSession } from '~/utils/crossmarkSession'
import { walletCredentialSupport } from '~/utils/walletCompatibility'
import { observeWalletAvailability } from '~/utils/walletDiscovery'
import { supportsWalletLinkProof } from '~/utils/roleJourney'
import {
  connectWallet,
  WALLET_CONNECTION_CANCELLED,
  WALLET_CONNECTION_TIMEOUT,
} from '~/utils/walletConnection'

interface WalletChoice {
  readonly id: string
  readonly name: string
  readonly url?: string | undefined
  readonly available: boolean
}

const props = withDefaults(defineProps<{ proofOnly?: boolean; testIdPrefix?: string }>(), {
  proofOnly: false,
  testIdPrefix: 'wallet',
})
// Callers give local pickers a distinct prefix; avoid consuming SSR IDs in this client component.
const menuId = `${props.testIdPrefix}-menu`

const walletConnection = useXrplConnectWallet()
const { connecting, disconnect, manager } = walletConnection
const { t } = useI18n()
const { account, busy: operationBusy, error: operationError } = useWallet()
const open = ref(false)
const discovering = ref(false)
const localError = ref<string | null>(null)
const wallets = shallowRef<WalletChoice[]>([])
const trigger = ref<{ $el?: HTMLElement } | null>(null)
let discoveryRun = 0
let stopDiscovery: (() => void) | undefined
const pendingWallet = ref<string | null>(null)
let connectionAttempt: AbortController | undefined
const busy = computed(
  () =>
    pendingWallet.value !== null || connecting.value || operationBusy.value || discovering.value,
)
const error = computed(() => localError.value ?? operationError.value)
const unbindCrossmark = props.proofOnly
  ? () => {}
  : bindCrossmarkSession({
      events: CrossmarkSDK.default,
      manager,
      disconnect,
      onError: (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        localError.value =
          message === 'CROSSMARK_SESSION_CHANGED'
            ? t('wallet.sessionChanged')
            : message.startsWith('CROSSMARK_SESSION_REFRESH_')
              ? t('wallet.sessionRefreshFailed')
              : message
      },
    })

async function closeWalletMenu() {
  discoveryRun += 1
  stopDiscovery?.()
  stopDiscovery = undefined
  discovering.value = false
  open.value = false
  await nextTick()
  if (!discovering.value) trigger.value?.$el?.focus()
}

function onOpenRequest(next: boolean) {
  if (next) void toggle()
  else {
    connectionAttempt?.abort()
    void closeWalletMenu()
  }
}

async function toggle() {
  if (busy.value) return
  localError.value = null
  if (account.value) {
    try {
      await disconnect()
    } catch (cause) {
      localError.value = cause instanceof Error ? cause.message : String(cause)
    }
    return
  }
  discovering.value = true
  const run = ++discoveryRun
  stopDiscovery?.()
  stopDiscovery = observeWalletAvailability({
    manager,
    events: CrossmarkSDK.default,
    onChange: (availableWallets) => {
      if (run !== discoveryRun) return
      const available = new Set(availableWallets.map((wallet) => wallet.id))
      wallets.value = manager.wallets
        .filter((wallet) => !props.proofOnly || supportsWalletLinkProof(wallet.id))
        .map((wallet) => ({
          id: wallet.id,
          name: wallet.name,
          ...(wallet.url ? { url: wallet.url } : {}),
          available: available.has(wallet.id),
        }))
      open.value = true
      discovering.value = false
    },
    onError: (cause) => {
      if (run !== discoveryRun) return
      localError.value = cause instanceof Error ? cause.message : String(cause)
      discovering.value = false
    },
  })
}

function handleEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || (!open.value && !discovering.value && !pendingWallet.value)) return
  event.stopPropagation()
  connectionAttempt?.abort()
  void closeWalletMenu()
}

onMounted(() => document.addEventListener('keydown', handleEscape))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleEscape)
  connectionAttempt?.abort()
  stopDiscovery?.()
  unbindCrossmark()
})

async function chooseWallet(walletId: string) {
  if (busy.value) return
  if (props.proofOnly && !supportsWalletLinkProof(walletId)) return
  localError.value = null
  const attempt = new AbortController()
  connectionAttempt = attempt
  pendingWallet.value = manager.wallets.find((wallet) => wallet.id === walletId)?.name ?? walletId
  try {
    await connectWallet(walletConnection, walletId, attempt.signal, 90_000, () => {
      if (!account.value && !connectionAttempt) localError.value = t('wallet.disconnectFailed')
    })
    await closeWalletMenu()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (message !== WALLET_CONNECTION_CANCELLED) {
      localError.value =
        message === WALLET_CONNECTION_TIMEOUT
          ? t('wallet.connectionTimeout')
          : isWalletError(cause) && cause.code === WalletErrorCode.NETWORK_MISMATCH
            ? t('wallet.networkMismatch')
            : message
    }
  } finally {
    if (connectionAttempt === attempt) {
      connectionAttempt = undefined
      pendingWallet.value = null
    }
  }
}

function safeWalletUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-5)}`
}
</script>

<template>
  <div class="relative min-w-0 max-w-[calc(100vw-7rem)]">
    <UPopover
      :open="!account && (open || pendingWallet !== null)"
      :content="{ side: 'bottom', align: 'end', collisionPadding: 8 }"
      @update:open="onOpenRequest"
    >
      <UButton
        ref="trigger"
        color="neutral"
        :variant="account ? 'outline' : 'solid'"
        size="sm"
        class="max-w-full px-2 sm:px-3 [&_span]:truncate"
        :data-testid="`${testIdPrefix}-toggle`"
        :disabled="busy"
        :aria-busy="busy"
        :title="account ? $t('wallet.disconnect') : undefined"
        :aria-expanded="account ? undefined : open || pendingWallet !== null"
        :aria-controls="account ? undefined : menuId"
        type="button"
      >
        <span class="truncate">{{
          pendingWallet
            ? $t('wallet.connecting', { wallet: pendingWallet })
            : account
              ? `${manager.wallet?.name} · ${shortAddress(account.address)}`
              : $t(proofOnly ? 'roleJourney.chooseCompatibleWallet' : 'wallet.connect')
        }}</span>
      </UButton>
      <template #content>
        <div
          v-if="!account"
          :id="menuId"
          :data-testid="`${testIdPrefix}-menu`"
          class="max-h-[min(36rem,80vh)] w-[min(22rem,calc(100vw-1rem))] space-y-3 overflow-y-auto p-4"
        >
          <StatusBox v-if="error" tone="error">{{ error }}</StatusBox>
          <div v-if="pendingWallet" role="status" :data-testid="`${testIdPrefix}-pending`">
            <p>{{ $t('wallet.approvalPending', { wallet: pendingWallet }) }}</p>
            <UButton color="neutral" variant="link" @click="connectionAttempt?.abort()">
              {{ $t('wallet.cancelConnection') }}
            </UButton>
          </div>
          <strong>{{
            $t(proofOnly ? 'roleJourney.chooseCompatibleWallet' : 'wallet.choose')
          }}</strong>
          <div
            v-for="wallet in wallets"
            :key="wallet.id"
            class="flex items-start justify-between gap-3 border-t border-default pt-3"
            :data-wallet-choice="wallet.id"
          >
            <span class="grid min-w-0 gap-0.5 text-sm">
              <strong>{{ wallet.name }}</strong>
              <small class="text-muted">{{
                $t(wallet.available ? 'wallet.available' : 'wallet.unavailable')
              }}</small>
              <small
                class="text-muted"
                :data-credential-support="walletCredentialSupport(wallet.id)"
              >
                {{ $t(`wallet.credentials.${walletCredentialSupport(wallet.id)}`) }}
              </small>
            </span>
            <UButton
              v-if="wallet.available"
              color="neutral"
              variant="link"
              size="sm"
              class="shrink-0 px-0"
              :data-wallet-id="wallet.id"
              type="button"
              :disabled="busy"
              @click="chooseWallet(wallet.id)"
            >
              {{ $t('wallet.select') }}
            </UButton>
            <UButton
              v-else-if="safeWalletUrl(wallet.url)"
              color="neutral"
              variant="link"
              size="sm"
              class="shrink-0 px-0"
              :data-wallet-id="wallet.id"
              :href="safeWalletUrl(wallet.url)"
              rel="noopener noreferrer"
              target="_blank"
            >
              {{ $t('wallet.setup') }}
            </UButton>
          </div>
          <UButton v-if="!pendingWallet" color="neutral" variant="link" @click="closeWalletMenu">
            {{ $t('common.close') }}
          </UButton>
        </div>
      </template>
    </UPopover>
    <p
      v-if="account"
      class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted"
      role="status"
      :data-testid="`${testIdPrefix}-status`"
    >
      {{ $t('wallet.connected') }} · {{ account.network.name }}
      <UButton
        color="neutral"
        variant="link"
        size="xs"
        class="p-0"
        :disabled="busy"
        @click="toggle"
      >
        {{ $t('wallet.disconnect') }}
      </UButton>
    </p>
    <p
      v-if="error && !open && !pendingWallet"
      class="absolute top-full right-0 mt-1 w-[min(20rem,calc(100vw-1rem))] rounded bg-default p-2 text-xs break-words text-error"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>
