<script setup lang="ts">
import {
  createHostedPublicationQueue,
  recoverPublicationSignatures,
  type HostedPublicationJob,
} from '~/utils/hostedPublicationQueue'
import { buildCredentialPermalink } from '~/utils/operationLinks'
import { IndexedDbOperationJournal } from '~/utils/operationJournal'

const props = defineProps<{ excludeId?: string }>()
const { t } = useI18n()
const { publishHostedPayload } = useXcsApi()
const jobs = ref<HostedPublicationJob[]>([])
const busyId = ref('')
const error = ref('')
const errorDetails = ref('')
const publishedLink = ref('')
const invalidKeys = ref<string[]>([])
const visibleJobs = computed(() => jobs.value.filter((job) => job.id !== props.excludeId))

async function refresh() {
  try {
    const snapshot = createHostedPublicationQueue(localStorage).inspect()
    invalidKeys.value = snapshot.invalidKeys
    jobs.value = snapshot.jobs
    if (snapshot.jobs.some((job) => !job.payload.transactionHash)) {
      jobs.value = recoverPublicationSignatures(
        snapshot.jobs,
        await new IndexedDbOperationJournal().list(),
      )
    }
  } catch {
    error.value = t('issue.hosted.recoveryUnavailable')
  }
}

async function publish(job: HostedPublicationJob) {
  if (busyId.value) return
  busyId.value = job.id
  error.value = ''
  errorDetails.value = ''
  try {
    const journal = new IndexedDbOperationJournal()
    await createHostedPublicationQueue(localStorage).publish(
      job.id,
      publishHostedPayload,
      undefined,
      await journal.list(),
    )
    publishedLink.value = buildCredentialPermalink({
      profileId: job.payload.network,
      generationId: job.payload.transactionHash.toLowerCase(),
    })
    refresh()
    try {
      await journal.completePublication(job.id)
    } catch {
      error.value = t('issue.hosted.journalCleanupFailed')
    }
  } catch (cause) {
    error.value = t('issue.hosted.retryFailed')
    errorDetails.value = cause instanceof Error ? cause.message : ''
  } finally {
    busyId.value = ''
  }
}

function discardInvalid(key: string) {
  if (!window.confirm(t('issue.hosted.discardConfirm'))) return
  try {
    createHostedPublicationQueue(localStorage).removeInvalid(key)
    void refresh()
  } catch {
    error.value = t('issue.hosted.recoveryUnavailable')
  }
}

function discard(job: HostedPublicationJob) {
  if (!window.confirm(t('issue.hosted.discardConfirm'))) return
  try {
    createHostedPublicationQueue(localStorage).remove(job.id)
    refresh()
  } catch {
    error.value = t('issue.hosted.recoveryUnavailable')
  }
}

function download(job: HostedPublicationJob) {
  const url = URL.createObjectURL(
    new Blob([job.payload.canonicalPayload], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `xcs-payload-${job.payload.locator}.json`
  link.click()
  URL.revokeObjectURL(url)
}

onMounted(() => {
  refresh()
  window.addEventListener('storage', refresh)
})
onBeforeUnmount(() => window.removeEventListener('storage', refresh))
watch(() => props.excludeId, refresh)
</script>

<template>
  <UCard
    v-if="visibleJobs.length || invalidKeys.length || error || publishedLink"
    class="mb-6"
    data-testid="publication-recovery"
  >
    <h2 class="mb-2 text-xl font-semibold">{{ $t('issue.hosted.recoveryTitle') }}</h2>
    <p class="mb-4 text-sm text-muted">{{ $t('issue.hosted.recoveryDescription') }}</p>
    <StatusBox v-if="error" tone="error">
      <p>{{ error }}</p>
      <details v-if="errorDetails" class="mt-3">
        <summary class="cursor-pointer">{{ $t('simpleUi.technicalDetails') }}</summary>
        <p class="break-words">{{ errorDetails }}</p>
      </details>
    </StatusBox>
    <StatusBox v-for="key in invalidKeys" :key="key" tone="error">
      <p>{{ $t('issue.hosted.corruptRecovery') }}</p>
      <UButton
        color="neutral"
        variant="outline"
        :disabled="Boolean(busyId)"
        @click="discardInvalid(key)"
      >
        {{ $t('issue.hosted.discardRecovery') }}
      </UButton>
    </StatusBox>
    <StatusBox v-if="publishedLink" tone="success">
      <NuxtLinkLocale :to="publishedLink">{{ $t('issue.credentialLink') }}</NuxtLinkLocale>
    </StatusBox>
    <StatusBox v-for="(job, index) in visibleJobs" :key="job.id" tone="notice">
      <p class="font-medium">{{ $t('simpleUi.pendingPublication', { number: index + 1 }) }}</p>
      <p v-if="!job.payload.transactionHash">{{ $t('issue.hosted.signatureMissing') }}</p>
      <p v-else>{{ $t('simpleUi.signedPublicationPending') }}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <UButton
          v-if="job.payload.transactionHash"
          :disabled="Boolean(busyId)"
          @click="publish(job)"
        >
          {{ $t('issue.hosted.retryPublication') }}
        </UButton>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="Boolean(busyId)"
          @click="discard(job)"
        >
          {{ $t('issue.hosted.discardRecovery') }}
        </UButton>
        <UButton color="neutral" variant="outline" @click="download(job)">
          {{ $t('issue.hosted.downloadRecovery') }}
        </UButton>
      </div>
      <details class="mt-3" data-testid="publication-technical-details">
        <summary class="cursor-pointer">{{ $t('simpleUi.technicalDetails') }}</summary>
        <p class="break-all">
          <code>{{ job.payload.credentialUri.split('#')[0] }}</code>
        </p>
        <p v-if="job.payload.transactionHash" class="break-all">
          <code>{{ job.payload.transactionHash }}</code>
        </p>
      </details>
    </StatusBox>
  </UCard>
</template>
