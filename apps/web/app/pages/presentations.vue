<script setup lang="ts">
import type { ResolvedPresentation } from '../../server/xcs/recipient/types'
import { purgePrivateLinkFragment } from '~/utils/privateLinkHistory'
import { presentationTokenFromLink } from '~/utils/presentationView'

const auth = useAuth()
const handoff = usePrivateLinkHandoff()
const localePath = useLocalePath()
const route = useRoute()
const { t } = useI18n()
const token = ref('')
const ready = ref(false)
const busy = ref(false)
const failed = ref<'unusable' | 'unavailable' | null>(null)
const result = shallowRef<ResolvedPresentation | null>(null)
const receivedLink = ref('')
const invalidLink = ref(false)
let revision = 0
let activeRequest = 0
let disposed = false
function clearResult() {
  revision += 1
  result.value = null
}
function hideResult() {
  if (document.visibilityState === 'hidden') clearResult()
}
function captureFragment() {
  const fragment = window.location.hash
  if (!fragment) return
  purgePrivateLinkFragment()
  activeRequest += 1
  busy.value = false
  clearResult()
  token.value = fragment.slice(1)
  failed.value = /^[A-Za-z0-9_-]{43}$/.test(token.value) ? null : 'unusable'
}
// Native fragment navigation and Vue Router navigation can reuse this component.
// Read the current URL so both listeners cannot consume the same fragment twice.
watch(
  () => route.hash,
  () => {
    if (import.meta.client) captureFragment()
  },
)
onMounted(async () => {
  window.addEventListener('hashchange', captureFragment)
  document.addEventListener('visibilitychange', hideResult)
  captureFragment()
  await auth.load(true)
  if (disposed) return
  if (!token.value && auth.user.value) {
    const handoffRevision = revision
    try {
      const restoredToken = await handoff.consume('presentation')
      if (disposed) return
      if (handoffRevision === revision) token.value = restoredToken ?? ''
    } catch {
      if (handoffRevision === revision) failed.value = 'unavailable'
    }
  }
  if (token.value && !failed.value && !/^[A-Za-z0-9_-]{43}$/.test(token.value))
    failed.value = 'unusable'
  ready.value = true
})
onBeforeUnmount(() => {
  disposed = true
  activeRequest += 1
  token.value = ''
  receivedLink.value = ''
  clearResult()
  document.removeEventListener('visibilitychange', hideResult)
  window.removeEventListener('hashchange', captureFragment)
})
watch(() => auth.user.value?.id, clearResult)
async function openReceivedLink() {
  if (busy.value || !ready.value) return
  invalidLink.value = false
  try {
    token.value = presentationTokenFromLink(window.location.origin, receivedLink.value)
  } catch {
    invalidLink.value = true
    return
  } finally {
    receivedLink.value = ''
  }
  await open()
}
async function open() {
  if (busy.value || !ready.value || !/^[A-Za-z0-9_-]{43}$/.test(token.value)) return
  busy.value = true
  failed.value = null
  clearResult()
  const requestId = ++activeRequest
  const attempt = revision
  const requestToken = token.value
  let identity = auth.user.value?.id
  try {
    await auth.load(true)
    if (disposed || attempt !== revision || requestId !== activeRequest) return
    identity = auth.user.value?.id
    const resolved = await $fetch<ResolvedPresentation>('/api/presentations/resolve', {
      method: 'POST',
      body: { token: requestToken },
      ...(auth.csrfToken.value ? { headers: { 'x-xcs-csrf': auth.csrfToken.value } } : {}),
    })
    if (
      !disposed &&
      requestId === activeRequest &&
      attempt === revision &&
      identity === auth.user.value?.id &&
      document.visibilityState === 'visible'
    )
      result.value = resolved
  } catch (cause) {
    if (
      !disposed &&
      attempt === revision &&
      requestId === activeRequest &&
      identity === auth.user.value?.id
    )
      failed.value =
        (cause as { statusCode?: number }).statusCode === 404 ? 'unusable' : 'unavailable'
  } finally {
    if (requestId === activeRequest) busy.value = false
  }
}
async function signIn() {
  if (busy.value || !token.value) return
  busy.value = true
  const requestId = ++activeRequest
  try {
    await handoff.save('presentation', token.value)
    if (disposed || requestId !== activeRequest) return
    await navigateTo({
      path: localePath('/auth/login'),
      query: { returnTo: localePath('/presentations') },
    })
  } catch {
    if (!disposed && requestId === activeRequest) failed.value = 'unavailable'
  } finally {
    if (requestId === activeRequest) busy.value = false
  }
}
useSeoMeta({
  title: () => `${t('presentation.title')} — XCS`,
  robots: 'noindex,nofollow',
  referrer: 'no-referrer',
})
</script>
<template>
  <UContainer class="max-w-4xl py-8">
    <p v-if="!ready">{{ $t('issuer.loading') }}</p>
    <template v-else>
      <PresentationResult v-if="result" :result="result" />
      <template v-else>
        <h1 class="text-2xl font-bold">
          {{ failed ? $t(`presentation.headlines.${failed}`) : $t('presentation.title') }}
        </h1>
        <p class="mt-3 text-muted">
          {{ $t(failed === 'unusable' ? 'presentation.unusableHelp' : 'presentation.openHelp') }}
        </p>
      </template>
      <StatusBox v-if="failed === 'unavailable'" class="mt-5" tone="error">{{
        $t('presentation.unavailableHelp')
      }}</StatusBox>
      <form
        v-if="!token || failed === 'unusable'"
        class="mt-5 grid gap-4"
        @submit.prevent="openReceivedLink"
      >
        <label for="received-presentation-link" class="font-semibold">{{
          $t('simpleUi.receivedLink')
        }}</label>
        <input
          id="received-presentation-link"
          v-model="receivedLink"
          type="text"
          inputmode="url"
          autocomplete="off"
          autocapitalize="none"
          :spellcheck="false"
          :disabled="busy"
          required
          class="w-full min-w-0 rounded border border-default bg-default p-3"
          aria-describedby="received-link-help"
        />
        <p id="received-link-help" class="text-sm text-muted">
          {{ $t('simpleUi.receivedLinkHelp') }}
        </p>
        <StatusBox v-if="invalidLink" tone="error" role="alert">{{
          $t('simpleUi.invalidLink')
        }}</StatusBox>
        <UButton type="submit" :loading="busy" :disabled="busy">{{
          $t('simpleUi.verifyLink')
        }}</UButton>
      </form>
      <div v-if="token && failed !== 'unusable'" class="mt-5 flex flex-wrap gap-3">
        <UButton :loading="busy" :disabled="busy" @click="open">{{
          $t(result ? 'presentation.checkAgain' : 'presentation.open')
        }}</UButton>
        <UButton
          v-if="!auth.user.value"
          :disabled="busy"
          color="neutral"
          variant="outline"
          @click="signIn"
          >{{ $t('auth.signIn') }}</UButton
        >
        <UButton v-else :to="localePath('/verifier')" color="neutral" variant="outline">{{
          $t('verifier.title')
        }}</UButton>
      </div>
    </template>
  </UContainer>
</template>
