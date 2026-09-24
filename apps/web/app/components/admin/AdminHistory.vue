<script setup lang="ts">
import type { AdminAudit } from '~/composables/useAdminApi'
defineProps<{ items: AdminAudit[] }>()
const emit = defineEmits<{ retried: [] }>()
const api = useAdminApi()
const busy = ref<string | null>(null)
const error = ref<unknown>(null)
const failedId = ref<string | null>(null)
const notice = ref(false)

async function retry(id: string) {
  if (busy.value) return
  busy.value = id
  failedId.value = id
  error.value = null
  notice.value = false
  try {
    await api.post(`notifications/${encodeURIComponent(id)}/retry`)
    notice.value = true
    failedId.value = null
    emit('retried')
  } catch (cause) {
    error.value = cause
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div>
    <AdminError :error="error" @retry="failedId && retry(failedId)" />
    <StatusBox v-if="notice" tone="success" role="status">{{
      $t('admin.notificationQueued')
    }}</StatusBox>
    <EmptyState v-if="!items.length">{{ $t('admin.emptyHistory') }}</EmptyState>
    <ol v-else class="space-y-4">
      <li v-for="item in items" :key="item.id" class="rounded-lg border border-default p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="font-semibold">
              {{ item.organization_name ?? $t('admin.operatorAction') }}
            </h3>
            <p class="mt-1 text-sm text-muted">
              {{ item.actor_name ?? item.actor_id }} · {{ api.date(item.created_at) }}
            </p>
          </div>
          <UBadge v-if="item.role" color="neutral" variant="subtle">{{
            $t(`auth.roles.${item.role}`)
          }}</UBadge>
        </div>
        <p class="mt-3 text-sm">
          {{ item.before_status ? $t(`admin.status.${item.before_status}`) : '—' }}
          →
          {{
            item.after_status ? $t(`admin.status.${item.after_status}`) : $t('admin.operatorAction')
          }}
        </p>
        <p v-if="item.reason" class="mt-2 whitespace-pre-wrap text-sm">{{ item.reason }}</p>
        <div v-if="item.notification_status" class="mt-3 border-t border-default pt-3 text-sm">
          <p>
            {{ $t('admin.notification') }}:
            {{ $t(`admin.notifications.${item.notification_status}`) }}
          </p>
          <p v-if="item.notification_status === 'blocked'" class="mt-1 text-muted">
            {{ $t('admin.blockedHelp') }}
          </p>
          <p v-if="item.notification_status === 'uncertain'" class="mt-1 text-muted">
            {{ $t('admin.uncertainHelp') }}
          </p>
          <UButton
            v-if="item.notification_id && ['failed', 'blocked'].includes(item.notification_status)"
            class="mt-2"
            size="sm"
            color="neutral"
            variant="outline"
            :loading="busy === item.notification_id"
            :disabled="busy !== null"
            @click="retry(item.notification_id)"
            >{{ $t('admin.retryNotification') }}</UButton
          >
        </div>
      </li>
    </ol>
  </div>
</template>
