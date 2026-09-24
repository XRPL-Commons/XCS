<script setup lang="ts">
import type { AdminApplication, AdminPage } from '~/composables/useAdminApi'
const props = defineProps<{ verifiers?: boolean }>()
const route = useRoute()
const localePath = useLocalePath()
const api = useAdminApi()
const page = computed(() => Math.max(1, Math.floor(Number(route.query.page) || 1)))
const role = computed(() =>
  ['issuer', 'verifier'].includes(String(route.query.role)) ? String(route.query.role) : '',
)
const query = computed(() => ({ page: page.value, ...(role.value ? { role: role.value } : {}) }))
const { data, status, error, refresh } = await useAsyncData(
  props.verifiers ? 'admin-verifiers' : 'admin-queue',
  () =>
    api.get<AdminPage<AdminApplication>>(
      props.verifiers ? 'verifiers' : 'applications',
      query.value,
    ),
  { watch: [query] },
)
const busy = computed(() => status.value === 'pending')

async function changePage(value: number) {
  await navigateTo({ path: route.path, query: { ...route.query, page: value } })
}
async function changeRole(value: string) {
  await navigateTo({ path: route.path, query: { page: 1, ...(value ? { role: value } : {}) } })
}
</script>

<template>
  <div>
    <StatusBox v-if="route.query.decided === '1'" tone="success" role="status">{{
      $t('admin.decisionRecorded')
    }}</StatusBox>
    <div v-if="!verifiers" class="mb-6 flex flex-wrap items-center gap-3">
      <span class="font-medium">{{ $t('admin.filterRole') }}</span>
      <UButton
        v-for="value in ['', 'issuer', 'verifier']"
        :key="value"
        color="neutral"
        :variant="role === value ? 'solid' : 'outline'"
        :aria-pressed="role === value"
        :disabled="busy"
        @click="changeRole(value)"
      >
        {{ value ? $t(`auth.roles.${value}`) : $t('admin.allRoles') }}
        <span v-if="data?.counts"
          >({{
            value === 'issuer'
              ? data.counts.issuer
              : value === 'verifier'
                ? data.counts.verifier
                : data.counts.issuer + data.counts.verifier
          }})</span
        >
      </UButton>
    </div>
    <AdminError :error="error" @retry="refresh()" />
    <EmptyState v-if="busy" loading />
    <template v-else-if="!error && data">
      <EmptyState v-if="!data.items.length">
        <p>{{ $t(verifiers ? 'admin.emptyVerifiers' : 'admin.emptyQueue') }}</p>
        <UButton class="mt-4" :to="localePath('/admin/audit')" color="neutral" variant="outline">{{
          $t('admin.audit')
        }}</UButton>
      </EmptyState>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-left text-sm" data-testid="admin-applications">
          <caption class="sr-only">
            {{
              $t(verifiers ? 'admin.verifiers' : 'admin.queue')
            }}
          </caption>
          <thead>
            <tr class="border-b border-default">
              <th scope="col" class="p-3">{{ $t('admin.organization') }}</th>
              <th scope="col" class="p-3">{{ $t('admin.role') }}</th>
              <th scope="col" class="p-3">{{ $t('admin.currentStatus') }}</th>
              <th scope="col" class="p-3">{{ $t('admin.submitted') }}</th>
              <th scope="col" class="p-3">{{ $t('auth.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in data.items"
              :key="`${item.organization_id}:${item.role}`"
              class="border-b border-default"
            >
              <td class="p-3 font-medium">{{ item.name }}</td>
              <td class="p-3">{{ $t(`auth.roles.${item.role}`) }}</td>
              <td class="p-3">
                <UBadge color="neutral" variant="subtle">{{
                  $t(`admin.status.${item.status}`)
                }}</UBadge>
              </td>
              <td class="p-3">{{ api.date(item.submitted_at) }}</td>
              <td class="p-3">
                <UButton
                  color="neutral"
                  variant="outline"
                  size="sm"
                  :to="{
                    path: localePath(`/admin/applications/${item.organization_id}/${item.role}`),
                    query: {
                      page,
                      ...(role ? { role } : {}),
                      ...(verifiers ? { from: 'verifiers' } : {}),
                    },
                  }"
                  :aria-label="$t('admin.reviewNamed', { name: item.name })"
                  >{{ $t(verifiers ? 'admin.manage' : 'admin.review') }}</UButton
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <AdminPager
        :page="page"
        :page-size="data.pageSize"
        :total="data.total"
        :busy="busy"
        @change="changePage"
      />
    </template>
  </div>
</template>
