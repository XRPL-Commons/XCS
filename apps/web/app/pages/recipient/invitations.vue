<script setup lang="ts">
import { purgePrivateLinkFragment } from '~/utils/privateLinkHistory'

const auth = useAuth()
const handoff = usePrivateLinkHandoff()
const localePath = useLocalePath()
const route = useRoute()
const { t } = useI18n()
const token = ref('')
const usableToken = computed(() => /^[A-Za-z0-9_-]{43}$/.test(token.value))
const loaded = ref(false)
const failed = ref(false)
const busy = ref(false)
const claimed = ref(false)
const hasLinkedWallet = computed(
  () => auth.user.value?.wallets.some((wallet) => wallet.networkId === 1) === true,
)
const preview = ref<{ organizationName?: string; schemaName?: string } | null>(null)
let revision = 0
let initialized = false
let disposed = false
function resetView() {
  revision += 1
  preview.value = null
  claimed.value = false
  failed.value = false
  busy.value = false
  loaded.value = false
}
function current(attempt: number, identity?: string) {
  return !disposed && attempt === revision && identity === auth.user.value?.id
}
async function loadPreview(refreshSession: boolean) {
  const attempt = revision
  if (refreshSession) await auth.load(true)
  if (disposed || attempt !== revision) return
  const identity = auth.user.value?.id
  const requestToken = token.value
  if (!/^[A-Za-z0-9_-]{43}$/.test(requestToken)) {
    failed.value = true
    loaded.value = true
    return
  }
  if (!identity) {
    loaded.value = true
    return
  }
  try {
    const result = await auth.mutateApplication<{ organizationName?: string; schemaName?: string }>(
      '/api/issuer/invitations/preview',
      { token: requestToken },
    )
    if (current(attempt, identity)) preview.value = result
  } catch {
    if (current(attempt, identity)) failed.value = true
  } finally {
    if (current(attempt, identity)) loaded.value = true
  }
}
function captureFragment() {
  const fragment = window.location.hash
  if (!fragment) return
  // Native and router hash navigation can reuse this page. Reading the live URL prevents
  // duplicate consumption; clearing the prior revision prevents late preview/claim responses.
  purgePrivateLinkFragment()
  resetView()
  token.value = fragment.slice(1)
  if (initialized) void loadPreview(true)
}
watch(
  () => route.hash,
  () => {
    if (import.meta.client) captureFragment()
  },
)
watch(
  () => auth.user.value?.id,
  () => {
    if (!initialized || disposed) return
    resetView()
    void loadPreview(false)
  },
)
onMounted(async () => {
  window.addEventListener('hashchange', captureFragment)
  captureFragment()
  await auth.load(true)
  if (disposed) return
  if (auth.user.value && !token.value) {
    const attempt = revision
    const identity = auth.user.value.id
    try {
      const restored = await handoff.consume('invitation')
      if (current(attempt, identity)) token.value = restored ?? ''
    } catch {
      if (current(attempt, identity)) failed.value = true
    }
  }
  if (disposed) return
  initialized = true
  await loadPreview(false)
})
onBeforeUnmount(() => {
  disposed = true
  resetView()
  token.value = ''
  window.removeEventListener('hashchange', captureFragment)
})
async function signIn() {
  if (busy.value || !loaded.value || !/^[A-Za-z0-9_-]{43}$/.test(token.value)) return
  busy.value = true
  const attempt = revision
  const identity = auth.user.value?.id
  const requestToken = token.value
  try {
    await handoff.save('invitation', requestToken)
    if (!current(attempt, identity)) return
    await navigateTo({
      path: localePath('/auth/login'),
      query: { returnTo: localePath('/recipient/invitations') },
    })
  } catch {
    if (current(attempt, identity)) failed.value = true
  } finally {
    if (current(attempt, identity)) busy.value = false
  }
}
async function claim() {
  if (busy.value || !preview.value || !auth.user.value || !/^[A-Za-z0-9_-]{43}$/.test(token.value))
    return
  busy.value = true
  const attempt = revision
  const identity = auth.user.value.id
  const requestToken = token.value
  try {
    await auth.mutateApplication('/api/issuer/invitations/claim', { token: requestToken })
    if (!current(attempt, identity)) return
    claimed.value = true
    token.value = ''
  } catch {
    if (current(attempt, identity)) failed.value = true
  } finally {
    if (current(attempt, identity)) busy.value = false
  }
}
useSeoMeta({
  title: () => `${t('issuer.claimTitle')} — XCS`,
  robots: 'noindex,nofollow',
  referrer: 'no-referrer',
})
</script>
<template>
  <UContainer class="max-w-2xl py-10">
    <PageHeader :title="$t('issuer.claimTitle')" :lead="$t('issuer.claimHelp')" />
    <p v-if="!loaded">{{ $t('issuer.loading') }}</p>
    <template v-else-if="!auth.user.value">
      <p class="mb-4">{{ $t('issuer.claimLogin') }}</p>
      <StatusBox v-if="failed" tone="error">{{ $t('issuer.claimUnavailable') }}</StatusBox>
      <UButton :loading="busy" :disabled="busy || !usableToken" @click="signIn">{{
        $t('auth.signIn')
      }}</UButton>
    </template>
    <StatusBox v-else-if="failed" tone="error">{{ $t('issuer.claimUnavailable') }}</StatusBox>
    <template v-else-if="claimed">
      <StatusBox tone="success">{{
        $t(hasLinkedWallet ? 'simpleRecipient.invitationReady' : 'issuer.claimedHelp')
      }}</StatusBox>
      <UButton v-if="hasLinkedWallet" class="mt-5" :to="localePath('/recipient')">{{
        $t('roleJourney.continueRecipient')
      }}</UButton>
      <UButton
        v-else
        class="mt-5"
        :to="{ path: localePath('/account'), query: { returnTo: localePath('/recipient') } }"
        >{{ $t('roleJourney.prepareWallet') }}</UButton
      >
      <UButton
        v-if="!hasLinkedWallet"
        class="mt-5 ml-3"
        :to="localePath('/recipient')"
        variant="outline"
        >{{ $t('recipient.title') }}</UButton
      >
    </template>
    <template v-else-if="preview">
      <h2 class="text-xl font-semibold">{{ preview.schemaName }}</h2>
      <p class="mt-2">{{ preview.organizationName }}</p>
      <UButton class="mt-5" :loading="busy" :disabled="busy" @click="claim">{{
        $t('issuer.claim')
      }}</UButton>
    </template>
  </UContainer>
</template>
