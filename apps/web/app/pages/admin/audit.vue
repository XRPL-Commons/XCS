<script setup lang="ts">
import type { AdminAudit, AdminPage } from '~/composables/useAdminApi'
definePageMeta({ middleware: ['auth', 'role'], requiredRole: 'admin' })
const { t } = useI18n()
const route = useRoute()
const api = useAdminApi()
const page = computed(() => Math.max(1, Math.floor(Number(route.query.page) || 1)))
const { data, status, error, refresh } = await useAsyncData(
  'admin-audit',
  () => api.get<AdminPage<AdminAudit>>('audit', { page: page.value }),
  { watch: [page] },
)
useSeoMeta({ title: () => `${t('admin.audit')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="py-10 sm:py-14">
    <PageHeader :title="$t('admin.audit')" :lead="$t('admin.auditIntro')" />
    <AdminNav />
    <AdminError :error="error" @retry="refresh()" />
    <EmptyState v-if="status === 'pending' && !data" loading />
    <template v-else-if="!error && data">
      <AdminHistory :items="data.items" @retried="refresh()" />
      <AdminPager
        :page="page"
        :page-size="data.pageSize"
        :total="data.total"
        @change="navigateTo({ path: route.path, query: { page: $event } })"
      />
    </template>
  </UContainer>
</template>
