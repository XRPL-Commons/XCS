<script setup lang="ts">
import type {
  RecipientCredentialDetail,
  RecipientPayload,
} from '../../../../../server/xcs/recipient/types'
import { recipientCredentialPath } from '~/utils/presentationView'
import { singleRouteQueryValue } from '~/utils/operationLinks'

definePageMeta({ middleware: ['auth'] })
const route = useRoute()
const localePath = useLocalePath()
const { t } = useI18n()
const request = useRequestFetch()
const auth = useAuth()
const generationId = computed(() => String(route.params.generationId))
const profileId = computed(() => singleRouteQueryValue(route.query.profile))
const {
  data: detail,
  error,
  status,
  refresh,
} = useAsyncData(
  () => `recipient-credential:${profileId.value}:${generationId.value}`,
  () =>
    request<RecipientCredentialDetail>(
      recipientCredentialPath(profileId.value, generationId.value),
    ),
)
const shareLink = computed(() => ({
  path: localePath(`/recipient/credentials/${generationId.value}/present`),
  query: { profile: profileId.value },
}))
const content = shallowRef<RecipientPayload | null>(null)
const contentBusy = ref(false)
const contentError = ref(false)
let contentRevision = 0
let disposed = false
function clearContent() {
  contentRevision += 1
  content.value = null
}
function hideContent() {
  if (document.visibilityState === 'hidden') clearContent()
}
watch([profileId, generationId, () => auth.user.value?.id], clearContent)
onMounted(() => document.addEventListener('visibilitychange', hideContent))
onBeforeUnmount(() => {
  disposed = true
  clearContent()
  document.removeEventListener('visibilitychange', hideContent)
})
async function readContent() {
  if (contentBusy.value) return
  contentBusy.value = true
  contentError.value = false
  clearContent()
  const revision = contentRevision
  const identity = auth.user.value?.id
  try {
    const payload = await request<RecipientPayload>(
      `${recipientCredentialPath(profileId.value, generationId.value)}/payload`,
    )
    if (
      !disposed &&
      revision === contentRevision &&
      identity === auth.user.value?.id &&
      document.visibilityState === 'visible'
    )
      content.value = payload
  } catch {
    contentError.value = true
  } finally {
    contentBusy.value = false
  }
}
useSeoMeta({
  title: () => `${detail.value?.schemaName ?? t('recipient.credential')} — XCS`,
  robots: 'noindex,nofollow',
})
</script>
<template>
  <div>
    <UContainer class="max-w-5xl py-8">
      <UButton :to="localePath('/recipient')" color="neutral" variant="outline">{{
        $t('recipient.back')
      }}</UButton>
      <StatusBox v-if="error" class="mt-5" tone="error" role="alert">{{
        $t('recipient.error')
      }}</StatusBox>
      <p v-else-if="status === 'pending'" class="mt-5">{{ $t('issuer.loading') }}</p>
      <template v-else-if="detail">
        <PageHeader
          class="mt-5"
          :title="detail.schemaName ?? $t('recipient.credential')"
          :lead="detail.organizationName"
        />
        <AttestationStatus :value="detail.status.state" />
        <p class="mt-3 text-muted">{{ $t(`recipient.visibility.${detail.visibility}`) }}</p>
        <section
          v-if="detail.visibility === 'private'"
          class="mt-4"
          :aria-label="$t('presentation.publicFields')"
        >
          <h2 class="font-semibold">{{ $t('presentation.publicFields') }}</h2>
          <ul v-if="detail.disclosure.publicFields.length" class="mt-2 list-inside list-disc">
            <li v-for="field in detail.disclosure.publicFields" :key="field">{{ field }}</li>
          </ul>
          <p v-else class="mt-2 text-sm text-muted">{{ $t('presentation.noFields') }}</p>
        </section>
        <p v-if="detail.status.state === 'pending'" class="mt-3">
          {{ $t('recipient.reviewHelp') }}
        </p>
        <UButton v-if="detail.status.state === 'active'" :to="shareLink" class="mt-5">{{
          $t('recipient.present')
        }}</UButton>
        <p v-else-if="detail.status.state !== 'pending'" class="mt-4 text-muted">
          {{ $t('recipient.inactiveHelp') }}
        </p>
        <details class="mt-5 rounded border border-default p-4">
          <summary class="cursor-pointer font-semibold">{{ $t('recipient.evidence') }}</summary>
          <MetadataList class="mt-3">
            <dt>{{ $t('recipient.issuerWallet') }}</dt>
            <dd class="break-all font-mono">{{ detail.issuerAddress }}</dd>
            <dt>{{ $t('recipient.subjectWallet') }}</dt>
            <dd class="break-all font-mono">{{ detail.subjectAddress }}</dd>
            <dt>{{ $t('recipient.generation') }}</dt>
            <dd class="break-all font-mono">{{ detail.generationId }}</dd>
            <dt>{{ $t('auth.network') }}</dt>
            <dd>{{ detail.profileId }}</dd>
          </MetadataList>
        </details>
        <section v-if="detail.status.accepted" class="mt-5">
          <p class="text-sm text-muted">{{ $t('recipient.readHelp') }}</p>
          <UButton
            class="mt-3"
            :disabled="contentBusy"
            :loading="contentBusy"
            @click="readContent"
            >{{ $t('recipient.readContent') }}</UButton
          >
          <StatusBox v-if="contentError" tone="error" class="mt-4">{{
            $t('recipient.readError')
          }}</StatusBox>
          <template v-if="content">
            <AttestationFields class="mt-5" :claims="content.claims" />
            <details class="mt-5 rounded border border-default p-4">
              <summary class="cursor-pointer font-semibold">
                {{ $t('simpleRecipient.verificationDetails') }}
              </summary>
              <VerificationGrid class="mt-3" :report="content.verification" />
            </details>
          </template>
        </section>
      </template>
    </UContainer>
    <CredentialSubjectAction
      v-if="
        detail &&
        !error &&
        (detail.status.accepted
          ? ['active', 'expired'].includes(detail.status.state)
          : ['pending', 'expired'].includes(detail.status.state))
      "
      :fixed-credential="detail"
      :initial-action="
        detail.status.accepted ? 'remove' : detail.status.state === 'expired' ? 'reject' : 'accept'
      "
      @reconciled="refresh()"
    />
  </div>
</template>
