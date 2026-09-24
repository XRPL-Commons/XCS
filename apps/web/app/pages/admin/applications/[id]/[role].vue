<script setup lang="ts">
import type {
  AdminAction,
  AdminApplication,
  AdminDecisionRequest,
  AdminDetail,
} from '~/composables/useAdminApi'

definePageMeta({ middleware: ['auth', 'role'], requiredRole: 'admin', key: (route) => route.path })
const route = useRoute()
const localePath = useLocalePath()
const { t } = useI18n()
const api = useAdminApi()
const path = `applications/${encodeURIComponent(String(route.params.id))}/${encodeURIComponent(String(route.params.role))}`
const { data, status, error, refresh } = await useAsyncData(`admin-${path}`, () =>
  api.get<AdminDetail>(path),
)
const action = ref<AdminAction | null>(null)
const reason = ref('')
const validation = ref(false)
const busy = ref(false)
const actionError = ref<unknown>(null)
const conflict = ref<Pick<
  AdminApplication,
  'status' | 'revision' | 'review_reason' | 'reviewed_at'
> | null>(null)
// Keep the exact request across navigation/retries when the HTTP outcome is unknown.
const pending = useState<AdminDecisionRequest | null>(`admin-pending-${path}`, () => null)
const documentError = ref<unknown>(null)
const documentBusy = ref<string | null>(null)
const failedDocument = ref<string | null>(null)
const documentLinks = ref<Record<string, { url: string; expiresAt: string }>>({})
const requiredReason = computed(() => action.value === 'reject' || action.value === 'suspend')
const actions = computed<AdminAction[]>(() => {
  const application = data.value?.application
  if (!application || conflict.value) return []
  if (application.status === 'pending') return ['approve', 'reject']
  if (application.role === 'verifier' && application.status === 'approved') return ['suspend']
  if (application.role === 'verifier' && application.status === 'suspended') return ['restore']
  return []
})
const back = computed(() => ({
  path: localePath(route.query.from === 'verifiers' ? '/admin/verifiers' : '/admin'),
  query: {
    page: String(route.query.page ?? '1'),
    ...(['issuer', 'verifier'].includes(String(route.query.role))
      ? { role: String(route.query.role) }
      : {}),
  },
}))

function choose(value: AdminAction) {
  action.value = value
  validation.value = false
  actionError.value = null
}

async function decide() {
  if (busy.value || conflict.value) return
  if (!pending.value) {
    if (!data.value || !action.value) return
    if (requiredReason.value && !reason.value.trim()) {
      validation.value = true
      return
    }
    pending.value = {
      action: action.value,
      revision: data.value.application.revision,
      reason: reason.value.trim(),
      idempotencyKey: crypto.randomUUID(),
    }
  }
  busy.value = true
  actionError.value = null
  try {
    await api.post(`${path}/decisions`, { ...pending.value })
    pending.value = null
    await navigateTo({ ...back.value, query: { ...back.value.query, decided: '1' } })
  } catch (cause) {
    const failure = cause as {
      statusCode?: number
      status?: number
      data?: { current?: typeof conflict.value; data?: { current?: typeof conflict.value } }
    }
    const code = failure.statusCode ?? failure.status
    actionError.value = cause
    if (code === 409) {
      conflict.value =
        failure.data?.current ?? failure.data?.data?.current ?? data.value?.application ?? null
      pending.value = null
      action.value = null
    } else if (code && code >= 400 && code < 500 && code !== 408 && code !== 429) {
      pending.value = null
    }
    if (code === 401 || code === 403) clear()
  } finally {
    busy.value = false
  }
}

function clear() {
  data.value = undefined
  documentLinks.value = {}
}

async function reviewCurrent() {
  await refresh()
  if (!error.value) {
    conflict.value = null
    action.value = null
    reason.value = ''
    actionError.value = null
  }
}

async function prepareDocument(id: string) {
  if (documentBusy.value) return
  documentBusy.value = id
  failedDocument.value = id
  documentError.value = null
  try {
    const link = await api.post<{ url: string; expiresAt: string }>(
      `documents/${encodeURIComponent(id)}/link`,
    )
    const url = new URL(link.url, window.location.origin)
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/admin/documents/'))
      throw new Error('INVALID_DOCUMENT_LINK')
    documentLinks.value[id] = link
    failedDocument.value = null
  } catch (cause) {
    documentError.value = cause
    const code = (cause as { statusCode?: number }).statusCode
    if (code === 401 || code === 403) clear()
  } finally {
    documentBusy.value = null
  }
}

useSeoMeta({ title: () => `${t('admin.reviewTitle')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader :title="$t('admin.reviewTitle')" :lead="$t('admin.reviewIntro')" />
    <AdminNav />
    <UButton class="mb-6" :to="back" color="neutral" variant="outline">{{
      $t('admin.back')
    }}</UButton>
    <AdminError :error="error" @retry="refresh()" />
    <AdminError
      v-if="!conflict"
      :error="actionError"
      @retry="pending ? decide() : reviewCurrent()"
    />
    <AdminError
      v-if="!data"
      :error="documentError"
      @retry="failedDocument && prepareDocument(failedDocument)"
    />
    <StatusBox v-if="conflict" tone="warning" role="alert">
      <p>{{ $t('admin.errors.conflict') }}</p>
      <p>
        {{ $t('admin.currentStatus') }}: {{ $t(`admin.status.${conflict.status}`) }} ·
        {{ api.date(conflict.reviewed_at) }}
      </p>
      <p v-if="conflict.review_reason" class="whitespace-pre-wrap">{{ conflict.review_reason }}</p>
      <UButton color="neutral" variant="outline" @click="reviewCurrent">{{
        $t('admin.reviewCurrent')
      }}</UButton>
    </StatusBox>
    <StatusBox v-if="pending && !busy" tone="warning">
      <p>{{ $t('admin.ambiguousDecision') }}</p>
      <p>{{ $t(`admin.actions.${pending.action}`) }} · {{ pending.reason }}</p>
      <UButton @click="decide">{{ $t('admin.retryDecision') }}</UButton>
    </StatusBox>
    <EmptyState v-if="status === 'pending' && !data" loading />
    <template v-else-if="!error && data">
      <div class="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div class="space-y-6">
          <UCard>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h2 class="text-2xl font-semibold">{{ data.application.name }}</h2>
              <UBadge color="neutral">{{ $t(`admin.status.${data.application.status}`) }}</UBadge>
            </div>
            <MetadataList class="mt-5">
              <dt>{{ $t('admin.role') }}</dt>
              <dd>{{ $t(`auth.roles.${data.application.role}`) }}</dd>
              <dt>{{ $t('admin.submitted') }}</dt>
              <dd>{{ api.date(data.application.submitted_at) }}</dd>
              <dt>{{ $t('admin.website') }}</dt>
              <dd class="break-all">{{ data.application.website || '—' }}</dd>
              <dt>{{ $t('admin.contact') }}</dt>
              <dd>{{ data.application.contact || '—' }}</dd>
              <dt>{{ $t('admin.jurisdiction') }}</dt>
              <dd>{{ data.application.jurisdiction || '—' }}</dd>
              <dt>{{ $t('admin.responsible') }}</dt>
              <dd>{{ data.application.responsible_name || '—' }}</dd>
              <dt>{{ $t('auth.email') }}</dt>
              <dd>{{ data.application.responsible_email || $t('admin.noEmail') }}</dd>
            </MetadataList>
            <h3 class="mt-5 font-semibold">{{ $t('admin.description') }}</h3>
            <p class="mt-2 whitespace-pre-wrap text-sm">
              {{ data.application.description || '—' }}
            </p>
            <h3 class="mt-5 font-semibold">{{ $t('admin.purpose') }}</h3>
            <p class="mt-2 whitespace-pre-wrap text-sm">{{ data.application.purpose || '—' }}</p>
          </UCard>
          <UCard>
            <h2 class="text-xl font-semibold">{{ $t('admin.documents') }}</h2>
            <p class="mt-2 text-sm text-muted">{{ $t('admin.documentHelp') }}</p>
            <AdminError
              class="mt-3"
              :error="documentError"
              @retry="failedDocument && prepareDocument(failedDocument)"
            />
            <p v-if="documentError" class="text-sm">{{ $t('admin.documentFailure') }}</p>
            <EmptyState v-if="!data.documents.length">{{ $t('admin.noDocuments') }}</EmptyState>
            <ul v-else class="mt-4 space-y-4">
              <li v-for="(document, index) in data.documents" :key="document.id">
                <p class="text-sm">
                  {{ $t('admin.document', { number: index + 1 }) }} · {{ document.mime_type }} ·
                  {{ $t('admin.bytes', { count: document.byte_length }) }}
                </p>
                <div class="mt-2 flex flex-wrap gap-3">
                  <UButton
                    size="sm"
                    variant="outline"
                    color="neutral"
                    :loading="documentBusy === document.id"
                    :disabled="documentBusy !== null"
                    @click="prepareDocument(document.id)"
                    >{{
                      $t(documentLinks[document.id] ? 'admin.renewLink' : 'admin.prepareDocument')
                    }}</UButton
                  >
                  <UButton
                    v-if="documentLinks[document.id]"
                    size="sm"
                    :href="documentLinks[document.id]!.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    >{{ $t('admin.openDocument') }}</UButton
                  >
                </div>
                <p v-if="documentLinks[document.id]" class="mt-2 text-xs text-muted">
                  {{
                    $t('admin.linkExpires', {
                      date: api.date(documentLinks[document.id]!.expiresAt),
                    })
                  }}
                </p>
              </li>
            </ul>
          </UCard>
          <UCard>
            <h2 class="text-xl font-semibold">{{ $t('auth.linkedWallets') }}</h2>
            <p class="mt-2 text-sm text-muted">{{ $t('admin.walletCaveat') }}</p>
            <EmptyState v-if="!data.wallets.length">{{ $t('auth.noWallets') }}</EmptyState>
            <ul v-else class="mt-4 space-y-3">
              <li v-for="wallet in data.wallets" :key="`${wallet.network_id}:${wallet.address}`">
                <p class="break-all font-mono text-sm">{{ wallet.address }}</p>
                <p class="mt-1 text-xs text-muted">
                  {{ $t('auth.network') }} {{ wallet.network_id }} · {{ $t('auth.verifiedAt') }}
                  {{ api.date(wallet.verified_at) }}
                </p>
              </li>
            </ul>
          </UCard>
        </div>
        <div>
          <UCard>
            <h2 class="text-xl font-semibold">{{ $t('admin.decision') }}</h2>
            <p class="mt-3 text-sm">{{ $t('admin.approvalCaveat') }}</p>
            <p class="mt-3 text-sm text-muted">{{ $t('admin.privateClaims') }}</p>
            <div v-if="actions.length" class="mt-5 flex flex-wrap gap-3">
              <UButton
                v-for="value in actions"
                :key="value"
                :color="['reject', 'suspend'].includes(value) ? 'error' : 'primary'"
                :variant="action === value ? 'solid' : 'outline'"
                :disabled="busy || pending !== null"
                @click="choose(value)"
                >{{ $t(`admin.actions.${value}`) }}</UButton
              >
            </div>
            <form v-if="action && !pending" class="mt-5 space-y-4" @submit.prevent="decide">
              <p class="text-sm font-medium">
                {{
                  $t('admin.confirmDecision', {
                    action: $t(`admin.actions.${action}`),
                    role: $t(`auth.roles.${data.application.role}`),
                    name: data.application.name,
                  })
                }}
              </p>
              <UFormField
                :label="$t(requiredReason ? 'admin.reasonRequired' : 'admin.reasonOptional')"
                :required="requiredReason"
                :error="validation ? $t('admin.missingReason') : undefined"
              >
                <UTextarea
                  v-model="reason"
                  class="w-full"
                  :rows="4"
                  :maxlength="2000"
                  :disabled="busy"
                  :aria-invalid="validation"
                  @update:model-value="validation = false"
                />
              </UFormField>
              <UButton
                type="submit"
                :loading="busy"
                :disabled="busy"
                data-testid="admin-confirm-decision"
                >{{ $t('admin.confirm') }}</UButton
              >
            </form>
            <p v-if="!actions.length && !conflict" class="mt-4 text-sm text-muted">
              {{ $t('admin.noDecision') }}
            </p>
          </UCard>
        </div>
      </div>
      <section class="mt-8" aria-labelledby="application-history">
        <h2 id="application-history" class="mb-4 text-2xl font-semibold">
          {{ $t('admin.applicationHistory') }}
        </h2>
        <AdminHistory :items="data.history" @retried="refresh()" />
      </section>
    </template>
  </UContainer>
</template>
