<script setup lang="ts">
import { issuerNextAction } from '~/utils/portalPresenters'

definePageMeta({ middleware: ['auth'] })
const localePath = useLocalePath()
const { t } = useI18n()
const auth = useAuth()
const { data, error, status, refresh } = useIssuerWorkspace()
const nextAction = computed(() =>
  data.value ? issuerNextAction(data.value, auth.user.value) : null,
)
const organization = computed(() =>
  data.value?.organizations.find((item) => item.id === data.value?.selectedOrganizationId),
)
const hasWallet = computed(
  () => auth.user.value?.wallets.some((wallet) => wallet.networkId === 1) === true,
)
const actionTarget = computed(() => {
  const action = nextAction.value
  if (!action || !('to' in action)) return null
  if (action.kind === 'linkWallet') {
    return {
      path: localePath(action.to),
      query: { returnTo: localePath(action.returnTo) },
    }
  }
  if (action.kind === 'createTemplate' || action.kind === 'invite') {
    return {
      path: localePath(action.to),
      query: { organizationId: action.organizationId },
    }
  }
  return localePath(action.to)
})

async function selectOrganization(event: Event) {
  await navigateTo({
    path: localePath('/issuer'),
    query: { organizationId: (event.target as HTMLSelectElement).value },
  })
}

useSeoMeta({ title: () => `${t('portal.issuer.title')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="max-w-5xl py-10">
    <PageHeader :title="$t('portal.issuer.title')" :lead="$t('portal.issuer.lead')" />
    <StatusBox v-if="error" tone="error" role="alert">
      <p>{{ $t('portal.errors.unavailable') }}</p>
      <p class="mt-2 text-sm">{{ $t('portal.errors.unchanged') }}</p>
      <UButton class="mt-3" :loading="status === 'pending'" @click="refresh()">{{
        $t('portal.retry')
      }}</UButton>
    </StatusBox>
    <p v-else-if="status === 'pending'" role="status" aria-live="polite">
      {{ $t('issuer.loading') }}
    </p>
    <template v-else-if="data && nextAction">
      <label v-if="data.organizations.length > 1" class="mb-6 block font-semibold">
        {{ $t('issuer.organization') }}
        <select
          :value="data.selectedOrganizationId"
          class="mt-2 w-full rounded border border-default bg-default p-3"
          @change="selectOrganization"
        >
          <option v-for="item in data.organizations" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </label>

      <UCard data-testid="issuer-next-action" aria-live="polite">
        <p class="text-sm font-semibold text-muted">{{ $t('portal.nextAction') }}</p>
        <h2 class="mt-2 text-2xl font-semibold">
          {{ $t(`portal.actions.${nextAction.kind}.title`) }}
        </h2>
        <p class="mt-3 text-toned">{{ $t(`portal.actions.${nextAction.kind}.help`) }}</p>
        <p v-if="organization" class="mt-3 font-semibold">{{ organization.name }}</p>
        <WalletProgress
          v-if="nextAction.kind === 'linkWallet'"
          class="mt-5"
          :stage="hasWallet ? 'ready' : 'prepare'"
        />
        <UButton v-if="actionTarget" class="mt-5" :to="actionTarget">
          {{ $t(`portal.actions.${nextAction.kind}.cta`) }}
        </UButton>
        <UButton
          v-else-if="nextAction.kind === 'awaitApproval' || nextAction.kind === 'awaitRecipient'"
          class="mt-5"
          @click="refresh()"
        >
          {{ $t('portal.retry') }}
        </UButton>
        <UButton
          v-else-if="nextAction.kind === 'done'"
          class="mt-5"
          :to="{
            path: localePath('/issuer/recipients'),
            query: organization ? { organizationId: organization.id } : {},
          }"
        >
          {{ $t('portal.actions.done.cta') }}
        </UButton>
      </UCard>

      <nav
        v-if="organization?.applicationStatus === 'approved'"
        class="mt-8 grid gap-3 sm:grid-cols-3"
      >
        <UButton
          :to="{ path: localePath('/issuer/schemas'), query: { organizationId: organization.id } }"
          color="neutral"
          variant="outline"
          >{{ $t('simpleIssuer.sections.schemas') }}</UButton
        >
        <UButton
          :to="{
            path: localePath('/issuer/recipients'),
            query: { organizationId: organization.id },
          }"
          color="neutral"
          variant="outline"
          >{{ $t('simpleIssuer.sections.recipients') }}</UButton
        >
        <UButton
          :to="{
            path: localePath('/issuer/credentials'),
            query: { organizationId: organization.id },
          }"
          color="neutral"
          variant="outline"
          >{{ $t('simpleIssuer.sections.credentials') }}</UButton
        >
      </nav>
    </template>
  </UContainer>
</template>
