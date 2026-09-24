<script setup lang="ts">
import type {
  CreatedPresentation,
  Presentation,
  RecipientCredentialDetail,
} from '../../../../../server/xcs/recipient/types'
import { presentationLink, recipientCredentialPath } from '~/utils/presentationView'
import { singleRouteQueryValue } from '~/utils/operationLinks'
import { useWallet as useXrplConnectWallet } from '@xrpl-commons/xrpl-connect-vue'
import { signWalletLinkChallenge } from '~/utils/walletLinkProof'
import { supportsWalletLinkProof } from '~/utils/roleJourney'

definePageMeta({ middleware: ['auth'] })
const route = useRoute()
const auth = useAuth()
const { t, locale } = useI18n()
const localePath = useLocalePath()
const request = useRequestFetch()
const wallet = import.meta.client ? useXrplConnectWallet() : undefined
const { account } = useWallet()
const generationId = computed(() => String(route.params.generationId))
const profileId = computed(() => singleRouteQueryValue(route.query.profile))
const scope = ref<'public' | 'full'>('public')
const verifierOrganizationId = ref('')
const busy = ref(false)
const mutationError = ref<'limit' | 'failed' | 'proof' | null>(null)
const created = shallowRef<{ id: string; url: string } | null>(null)
const { data, error, status, refresh } = useAsyncData(
  () => `recipient-sharing:${profileId.value}:${generationId.value}`,
  async () => {
    const [credential, verifiers, presentations] = await Promise.all([
      request<RecipientCredentialDetail>(
        recipientCredentialPath(profileId.value, generationId.value),
      ),
      request<{ verifiers: { id: string; name: string }[] }>('/api/recipient/verifiers'),
      request<{ presentations: Presentation[] }>('/api/recipient/presentations', {
        query: { profileId: profileId.value, generationId: generationId.value },
      }),
    ])
    return {
      credential,
      verifiers: verifiers.verifiers,
      presentations: presentations.presentations,
    }
  },
)
const selectedVerifier = computed(() =>
  data.value?.verifiers.find((item) => item.id === verifierOrganizationId.value),
)
const fields = computed(() =>
  scope.value === 'full'
    ? (data.value?.credential.disclosure.fields ?? [])
    : (data.value?.credential.disclosure.publicFields ?? []),
)
const canCreate = computed(
  () =>
    data.value?.credential.status.state === 'active' &&
    (scope.value === 'public' || Boolean(selectedVerifier.value)),
)
const walletReady = computed(() => {
  const current = account.value
  return (
    current?.address === data.value?.credential.subjectAddress &&
    current?.network.id === 'testnet' &&
    wallet?.manager.connected === true &&
    supportsWalletLinkProof(wallet.manager.wallet?.id ?? '') &&
    wallet.manager.supports('signMessage')
  )
})
let formRevision = 0
watch([profileId, generationId, scope, verifierOrganizationId, () => auth.user.value?.id], () => {
  formRevision += 1
  created.value = null
})
onBeforeUnmount(() => {
  formRevision += 1
  created.value = null
})
const date = (value: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
watch([profileId, generationId], () => {
  created.value = null
  scope.value = 'public'
  verifierOrganizationId.value = ''
})
async function create() {
  if (busy.value || !canCreate.value || !walletReady.value || !wallet) return
  busy.value = true
  mutationError.value = null
  created.value = null
  const attempt = formRevision
  const input = {
    profileId: profileId.value,
    generationId: generationId.value,
    scope: scope.value,
    ...(scope.value === 'full' ? { verifierOrganizationId: verifierOrganizationId.value } : {}),
  }
  try {
    const challenge = await auth.mutateApplication<{
      id: string
      address: string
      networkId: number
      message: string
      expiresAt: string
    }>('/api/recipient/presentation-challenges', input)
    if (
      attempt !== formRevision ||
      challenge.address !== data.value?.credential.subjectAddress ||
      challenge.networkId !== 1 ||
      !walletReady.value
    )
      throw new Error('PRESENTATION_PROOF_CONTEXT_CHANGED')
    const proof = await signWalletLinkChallenge(
      wallet.manager,
      { address: challenge.address, networkId: 'testnet' },
      challenge.message,
    )
    if (attempt !== formRevision) throw new Error('PRESENTATION_PROOF_CONTEXT_CHANGED')
    const result = await auth.mutateApplication<CreatedPresentation>(
      '/api/recipient/presentations',
      {
        ...input,
        proof: { challengeId: challenge.id, ...proof },
      },
    )
    if (attempt !== formRevision) return
    created.value = {
      id: result.id,
      url: presentationLink(window.location.origin, localePath('/presentations'), result.token),
    }
    await refresh()
  } catch (cause) {
    if (attempt !== formRevision) return
    const code = (cause as { data?: { error?: string } }).data?.error
    mutationError.value =
      code === 'RECIPIENT_PRESENTATION_LIMIT'
        ? 'limit'
        : code?.startsWith('RECIPIENT_PROOF_') ||
            (cause instanceof Error && cause.message.startsWith('WALLET_'))
          ? 'proof'
          : 'failed'
  } finally {
    busy.value = false
  }
}
async function revoke(id: string) {
  if (busy.value) return
  busy.value = true
  mutationError.value = null
  try {
    await auth.mutateApplication(
      `/api/recipient/presentations/${encodeURIComponent(id)}/revoke`,
      {},
    )
    if (created.value?.id === id) created.value = null
    await refresh()
  } catch {
    mutationError.value = 'failed'
  } finally {
    busy.value = false
  }
}
useSeoMeta({
  title: () => `${t('presentation.createTitle')} — XCS`,
  robots: 'noindex,nofollow',
  referrer: 'no-referrer',
})
</script>
<template>
  <UContainer class="max-w-4xl py-10">
    <UButton
      :to="{
        path: localePath(`/recipient/credentials/${generationId}`),
        query: { profile: profileId },
      }"
      color="neutral"
      variant="outline"
      class="mb-5"
      >{{ $t('recipient.open') }}</UButton
    >
    <PageHeader :title="$t('presentation.createTitle')" :lead="$t('presentation.createHelp')" />
    <StatusBox v-if="error || mutationError" tone="error" role="alert" class="mb-5">{{
      $t(
        mutationError === 'limit'
          ? 'presentation.limit'
          : mutationError === 'proof'
            ? 'roleJourney.proofFailed'
            : 'presentation.actionError',
      )
    }}</StatusBox>
    <p v-if="status === 'pending'">{{ $t('issuer.loading') }}</p>
    <template v-else-if="data && !error">
      <h2 class="mb-4 text-xl font-semibold">
        {{ data.credential.schemaName ?? $t('recipient.credential') }}
      </h2>
      <StatusBox v-if="data.credential.status.state !== 'active'" tone="warning">{{
        $t('recipient.inactiveHelp')
      }}</StatusBox>
      <form v-else class="grid gap-5" @submit.prevent="create">
        <fieldset class="grid gap-3">
          <legend class="mb-3 font-semibold">{{ $t('presentation.scope') }}</legend>
          <label class="flex gap-3"
            ><input v-model="scope" type="radio" value="public" :disabled="busy" />{{
              $t('presentation.public')
            }}</label
          >
          <label class="flex gap-3"
            ><input v-model="scope" type="radio" value="full" :disabled="busy" />{{
              $t('presentation.full')
            }}</label
          >
        </fieldset>
        <label v-if="scope === 'full'" class="font-semibold">
          {{ $t('presentation.verifier') }}
          <select
            v-model="verifierOrganizationId"
            required
            :disabled="busy"
            class="mt-2 block w-full rounded border border-default bg-default p-3"
          >
            <option value="">{{ $t('presentation.chooseVerifier') }}</option>
            <option v-for="verifier in data.verifiers" :key="verifier.id" :value="verifier.id">
              {{ verifier.name }}
            </option>
          </select>
          <span v-if="!data.verifiers.length" class="mt-2 block text-sm font-normal text-muted">{{
            $t('presentation.noVerifiers')
          }}</span>
        </label>
        <section class="rounded border border-default p-4" :aria-label="$t('presentation.preview')">
          <h3 class="font-semibold">{{ $t('presentation.preview') }}</h3>
          <p class="mt-2">
            {{
              scope === 'full'
                ? $t('presentation.fullAudience', {
                    verifier: selectedVerifier?.name ?? $t('presentation.chooseVerifier'),
                  })
                : $t('presentation.publicAudience')
            }}
          </p>
          <p v-if="scope === 'full'" class="mt-2 text-sm text-muted">
            {{ $t('presentation.publicStillVisible') }}
          </p>
          <p class="mt-3 text-sm font-semibold">{{ $t('presentation.fields') }}</p>
          <ul v-if="fields.length" class="mt-2 list-inside list-disc">
            <li v-for="field in fields" :key="field">{{ field }}</li>
          </ul>
          <p v-else class="mt-2 text-sm text-muted">{{ $t('presentation.noFields') }}</p>
        </section>
        <p class="text-sm text-muted">{{ $t('presentation.duration') }}</p>
        <section
          class="rounded border border-default p-4"
          :aria-label="$t('roleJourney.shareProofTitle')"
        >
          <h3 class="font-semibold">{{ $t('roleJourney.shareProofTitle') }}</h3>
          <p class="mt-2 text-sm text-muted">{{ $t('roleJourney.shareProofHelp') }}</p>
          <details class="mt-3 text-sm">
            <summary class="cursor-pointer">{{ $t('simpleRecipient.walletDetails') }}</summary>
            <p class="mt-2 break-all font-mono">{{ data.credential.subjectAddress }}</p>
          </details>
          <ClientOnly
            ><div class="mt-3"><WalletButton proof-only test-id-prefix="presentation-wallet" /></div
          ></ClientOnly>
          <p v-if="!walletReady" class="mt-3 text-sm text-muted">
            {{ $t('roleJourney.shareConnectWallet') }}
          </p>
        </section>

        <UButton type="submit" :disabled="busy || !canCreate || !walletReady" :loading="busy">{{
          $t('presentation.create')
        }}</UButton>
      </form>
      <PresentationLink v-if="created" :url="created.url" />
      <section class="mt-10" aria-labelledby="recipient-presentations">
        <h2 id="recipient-presentations" class="text-xl font-semibold">
          {{ $t('presentation.existing') }}
        </h2>
        <p class="mt-2 text-sm text-muted">{{ $t('presentation.revokeHelp') }}</p>
        <p v-if="!data.presentations.length" class="mt-4 text-muted">
          {{ $t('presentation.none') }}
        </p>
        <ul v-else class="mt-4 grid gap-3">
          <li
            v-for="item in data.presentations"
            :key="item.id"
            class="rounded border border-default p-4"
          >
            <p class="font-semibold">
              {{ $t(`presentation.${item.scope}`)
              }}<span v-if="item.verifierOrganizationName">
                · {{ item.verifierOrganizationName }}</span
              >
            </p>
            <p class="mt-2 text-sm text-muted">{{ date(item.createdAt) }}</p>
            <p v-if="item.revokedAt" class="mt-2">{{ $t('presentation.revoked') }}</p>
            <UButton
              v-else
              :disabled="busy"
              class="mt-3"
              color="neutral"
              variant="outline"
              @click="revoke(item.id)"
              >{{ $t('presentation.revoke') }}</UButton
            >
          </li>
        </ul>
      </section>
    </template>
  </UContainer>
</template>
