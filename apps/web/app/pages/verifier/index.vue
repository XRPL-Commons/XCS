<script setup lang="ts">
import type { VerifierWorkspace } from '../../../server/xcs/verifier/types'
import type { ResolvedPresentation } from '../../../server/xcs/recipient/types'
import { presentationHeadline } from '~/utils/presentationView'

definePageMeta({ middleware: ['auth'] })
const route = useRoute()
const localePath = useLocalePath()
const { locale, t } = useI18n()
const request = useRequestFetch()
const auth = useAuth()
const organizationId = computed(() =>
  typeof route.query.organizationId === 'string' ? route.query.organizationId : undefined,
)
const { data, error, status, refresh } = useAsyncData(
  'verifier-workspace',
  () =>
    request<VerifierWorkspace>('/api/verifier/workspace', {
      query: organizationId.value ? { organizationId: organizationId.value } : {},
    }),
  { watch: [organizationId] },
)
const selected = computed(() =>
  data.value?.organizations.find((item) => item.id === data.value?.selectedOrganizationId),
)
const approved = computed(
  () => selected.value?.applicationStatus === 'approved' && selected.value.status === 'active',
)
const csvUrl = computed(() =>
  data.value?.selectedOrganizationId
    ? `/api/verifier/history.csv?${new URLSearchParams({ organizationId: data.value.selectedOrganizationId })}`
    : '',
)
const busy = ref(false)
const openError = ref(false)
const result = shallowRef<ResolvedPresentation | null>(null)
let revision = 0
let disposed = false
function clearResult() {
  revision += 1
  result.value = null
}
function hideResult() {
  if (document.visibilityState === 'hidden') clearResult()
}
watch([organizationId, () => auth.user.value?.id], clearResult)
onMounted(() => document.addEventListener('visibilitychange', hideResult))
onBeforeUnmount(() => {
  disposed = true
  clearResult()
  document.removeEventListener('visibilitychange', hideResult)
})
const date = (value: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
async function chooseOrganization(event: Event) {
  clearResult()
  await navigateTo({
    path: localePath('/verifier'),
    query: { organizationId: (event.target as HTMLSelectElement).value },
  })
}
async function reopen(id: string) {
  if (busy.value) return
  busy.value = true
  openError.value = false
  clearResult()
  const attempt = revision
  const identity = auth.user.value?.id
  try {
    await auth.load(true)
    const current = await auth.mutateApplication<ResolvedPresentation>(
      `/api/verifier/history/${encodeURIComponent(id)}/presentation`,
      {},
    )
    if (
      !disposed &&
      attempt === revision &&
      identity === auth.user.value?.id &&
      document.visibilityState === 'visible'
    )
      result.value = current
  } catch {
    openError.value = true
  } finally {
    busy.value = false
  }
}
useSeoMeta({ title: () => `${t('verifier.title')} — XCS`, robots: 'noindex,nofollow' })
</script>
<template>
  <UContainer class="max-w-5xl py-10">
    <PageHeader :title="$t('verifier.title')" :lead="$t('verifier.intro')">
      <template #actions
        ><UButton :to="localePath('/verifier/apply')">{{ $t('verifier.apply') }}</UButton
        ><UButton
          color="neutral"
          variant="outline"
          :loading="status === 'pending'"
          @click="refresh()"
          >{{ $t('recipient.refresh') }}</UButton
        ></template
      >
    </PageHeader>
    <StatusBox v-if="error" tone="error" role="alert">{{ $t('verifier.error') }}</StatusBox>
    <p v-else-if="status === 'pending'">{{ $t('issuer.loading') }}</p>
    <template v-else-if="data">
      <p class="mb-5 text-muted">{{ $t('verifier.approvalMeaning') }}</p>
      <p v-if="!data.organizations.length">{{ $t('verifier.noApplications') }}</p>
      <label v-else class="block font-semibold"
        >{{ $t('issuer.organization') }}
        <select
          :value="data.selectedOrganizationId"
          class="mt-2 w-full rounded border border-default bg-default p-3"
          @change="chooseOrganization"
        >
          <option v-for="org in data.organizations" :key="org.id" :value="org.id">
            {{ org.name }}
          </option>
        </select>
      </label>
      <UCard v-if="selected" class="mt-5">
        <h2 class="text-xl font-semibold">{{ selected.name }}</h2>
        <p class="mt-2">{{ $t(`issuer.states.${selected.applicationStatus}`) }}</p>
        <p v-if="selected.reviewReason" class="mt-2 whitespace-pre-wrap">
          {{ selected.reviewReason }}
        </p>
        <p v-if="selected.applicationStatus === 'pending'" class="mt-3 text-muted">
          {{ $t('verifier.pendingHelp') }}
        </p>
        <p
          v-if="
            selected.applicationStatus === 'rejected' || selected.applicationStatus === 'suspended'
          "
          class="mt-3 text-muted"
        >
          {{ $t('issuer.declinedHelp') }}
        </p>
      </UCard>
      <section v-if="approved" class="mt-8" aria-labelledby="verifier-history">
        <h2 id="verifier-history" class="text-xl font-semibold">{{ $t('verifier.history') }}</h2>
        <p class="mt-2 text-sm text-muted">{{ $t('verifier.historyHelp') }}</p>
        <a
          :href="csvUrl"
          download="xcs-verification-history.csv"
          class="mt-4 inline-block font-semibold underline"
          >{{ $t('verifier.export') }}</a
        >
        <p v-if="!data.history.length" class="mt-5 text-muted">{{ $t('verifier.emptyHistory') }}</p>
        <div v-else class="mt-4 overflow-x-auto">
          <table class="w-full text-left text-sm">
            <caption class="sr-only">
              {{
                $t('verifier.history')
              }}
            </caption>
            <thead>
              <tr class="border-b border-default">
                <th scope="col" class="p-3">{{ $t('verifier.checkedAt') }}</th>
                <th scope="col" class="p-3">{{ $t('verifier.previousResult') }}</th>
                <th scope="col" class="p-3">{{ $t('presentation.scope') }}</th>
                <th scope="col" class="p-3">{{ $t('auth.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in data.history" :key="entry.id" class="border-b border-default">
                <td class="p-3">
                  <time :datetime="entry.checkedAt">{{ date(entry.checkedAt) }}</time>
                </td>
                <td class="p-3">
                  {{
                    $t(
                      `presentation.headlines.${presentationHeadline(entry.verification, { usable: true, fresh: true })}`,
                    )
                  }}
                </td>
                <td class="p-3">{{ $t(`presentation.${entry.scope}`) }}</td>
                <td class="p-3">
                  <UButton :disabled="busy" @click="reopen(entry.id)">{{
                    $t('verifier.reopen')
                  }}</UButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
    <StatusBox v-if="openError" class="mt-5" tone="error">{{
      $t('verifier.reopenError')
    }}</StatusBox>
    <section
      v-if="result"
      class="mt-8 rounded border border-default p-5"
      :aria-label="$t('verifier.currentResult')"
    >
      <PresentationResult :result="result" />
    </section>
  </UContainer>
</template>
