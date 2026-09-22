<script setup lang="ts">
import type { WalletChoice } from '~/composables/useWallet'

const { account, busy, error, walletChoices, connect, disconnect } = useWallet()
const open = ref(false)
const wallets = ref<WalletChoice[]>([])
const trigger = ref<{ $el?: HTMLElement } | null>(null)
let walletMenuRequest = 0

function focusTrigger(): void {
  const element = trigger.value?.$el
  if (element instanceof HTMLElement) element.focus()
}

async function closeWalletMenu(): Promise<void> {
  walletMenuRequest += 1
  open.value = false
  await nextTick()
  focusTrigger()
}

async function toggle() {
  if (account.value) {
    await disconnect()
    return
  }
  const request = ++walletMenuRequest
  const discoveredWallets = await walletChoices()
  if (request !== walletMenuRequest || account.value) return
  wallets.value = discoveredWallets
  open.value = true
}

function onOpenRequest(next: boolean): void {
  if (next) void toggle()
  else void closeWalletMenu()
}

async function chooseWallet(walletId: string) {
  try {
    await connect(walletId)
    await closeWalletMenu()
  } catch {
    // useWallet exposes the adapter error next to the control.
  }
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-5)}`
}
</script>

<template>
  <div class="relative" @keydown.esc.stop="closeWalletMenu()">
    <UPopover
      :open="open"
      :content="{ side: 'bottom', align: 'end', collisionPadding: 8 }"
      @update:open="onOpenRequest"
    >
      <UButton
        ref="trigger"
        data-testid="wallet-toggle"
        color="neutral"
        :variant="account ? 'outline' : 'solid'"
        size="sm"
        :disabled="busy"
        class="whitespace-nowrap"
      >
        {{ account ? shortAddress(account.address) : $t('wallet.connect') }}
      </UButton>

      <template #content>
        <div v-if="!account" id="wallet-menu" class="w-[min(20rem,calc(100vw-1rem))] space-y-3 p-4">
          <strong class="block text-sm">{{ $t('wallet.choose') }}</strong>
          <div
            v-for="wallet in wallets"
            :key="wallet.id"
            class="flex items-start justify-between gap-3 border-t border-default pt-3"
            :data-wallet-choice="wallet.id"
          >
            <span class="grid gap-0.5 text-sm">
              <strong>{{ wallet.name }}</strong>
              <small class="text-muted">
                {{ $t(wallet.available ? 'wallet.available' : 'wallet.unavailable') }}
              </small>
              <small class="text-muted" :data-credential-support="wallet.credentialSupport">
                {{ $t(`wallet.credentials.${wallet.credentialSupport}`) }}
              </small>
            </span>
            <UButton
              v-if="wallet.available"
              color="neutral"
              variant="link"
              size="sm"
              class="px-0"
              :data-wallet-id="wallet.id"
              @click="chooseWallet(wallet.id)"
            >
              {{ $t('wallet.select') }}
            </UButton>
            <UButton
              v-else-if="wallet.url"
              color="neutral"
              variant="link"
              size="sm"
              class="px-0"
              :data-wallet-id="wallet.id"
              :href="wallet.url"
              rel="noopener noreferrer"
              target="_blank"
            >
              {{ $t('wallet.setup') }}
            </UButton>
          </div>
          <p v-if="wallets.length === 0" class="text-sm text-muted">{{ $t('wallet.none') }}</p>
          <UButton color="neutral" variant="link" size="sm" class="px-0" @click="closeWalletMenu()">
            {{ $t('common.close') }}
          </UButton>
        </div>
      </template>
    </UPopover>
    <p v-if="error" class="absolute top-full right-0 mt-1 text-xs whitespace-nowrap text-error">
      {{ error }}
    </p>
  </div>
</template>
