<script setup lang="ts">
import {
  assertIssuanceContextUnchanged,
  type IssuerIssuanceContext,
  type IssuerIssueEngineContext,
} from '~/utils/issuerEngine'

definePageMeta({ layout: 'issuer', middleware: ['auth', 'role'], requiredRole: 'issuer' })
const route = useRoute()
const localePath = useLocalePath()
const { locale, t } = useI18n()
const api = useIssuerEngineApi()
const { user } = useAuth()
const inviteId = String(route.params.inviteId)
const issuance = shallowRef<IssuerIssuanceContext | null>(null)
const subjectAddress = ref('')
const error = ref('')
const engineBusy = ref(false)
const savedLink = ref('')
try {
  issuance.value = await api.issuance(inviteId)
  if (issuance.value.existingCredential) {
    const existing = issuance.value.existingCredential
    savedLink.value = `/issuer/credentials/${existing.generationId}?profile=${encodeURIComponent(existing.profileId)}`
  }
  subjectAddress.value =
    issuance.value.recipient.wallets.find((wallet) => wallet.networkId === 1)?.address ?? ''
} catch (cause) {
  error.value = cause instanceof Error ? cause.message : String(cause)
}
const wallets = computed(
  () => issuance.value?.recipient.wallets.filter((wallet) => wallet.networkId === 1) ?? [],
)
const selectedWallet = computed(() =>
  wallets.value.find((wallet) => wallet.address === subjectAddress.value),
)
const date = (value: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
const context = computed<IssuerIssueEngineContext | undefined>(() => {
  const initial = issuance.value
  const subject = subjectAddress.value
  if (!initial || !wallets.value.some((wallet) => wallet.address === subject)) return undefined
  return {
    key: `issue:${user.value?.id}:${inviteId}`,
    inviteId,
    existingCredential: initial.existingCredential ?? null,
    profileId: initial.invite.profileId,
    schemaUid: initial.schema.schemaUid,
    schemaName: initial.schema.name,
    subjectAddress: subject,
    recipientLabel: initial.recipient.displayName ?? t('simpleIssuer.recipientFallback'),
    async beforeSign(publisher) {
      assertIssuanceContextUnchanged(initial, await api.issuance(inviteId), subject, publisher)
    },
    preparePayload: (canonicalPayload, setting) =>
      api.preparePayload(inviteId, subject, canonicalPayload, setting),
    async record(receipt) {
      const saved = await api.recordCredential(inviteId, receipt)
      savedLink.value = `/issuer/credentials/${saved.generationId}?profile=${encodeURIComponent(saved.profileId)}`
    },
  }
})
useSeoMeta({ robots: 'noindex,nofollow' })
</script>

<template>
  <div>
    <UContainer class="pt-8">
      <UButton :to="localePath('/issuer')" color="neutral" variant="outline">{{
        $t('issuer.engine.back')
      }}</UButton>
      <StatusBox v-if="error" tone="error"
        ><p>{{ $t('simpleIssuer.error') }}</p>
        <details>
          <summary>{{ $t('simpleIssuer.technical') }}</summary>
          <code>{{ error }}</code>
        </details></StatusBox
      >
      <StatusBox v-else-if="!wallets.length" tone="warning">{{
        $t('issuer.engine.walletRequired')
      }}</StatusBox>
      <UCard v-if="issuance" class="mt-4">
        <p>
          <strong>{{ $t('simpleIssuer.contactEmail') }} :</strong>
          {{ issuance.invite.deliveryEmail ?? '—' }}
        </p>
        <p class="mt-2 text-sm text-muted">{{ $t('simpleIssuer.contactHelp') }}</p>
        <p v-if="selectedWallet?.verifiedAt" class="mt-3">
          {{ $t('roleJourney.walletVerifiedAt', { date: date(selectedWallet.verifiedAt) }) }}
        </p>
      </UCard>
      <UFormField v-if="wallets.length > 1" class="mt-4" :label="$t('issuer.engine.chooseWallet')">
        <USelect
          v-model="subjectAddress"
          :disabled="engineBusy"
          :items="
            wallets.map((wallet) => ({
              label: `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`,
              value: wallet.address,
            }))
          "
        />
      </UFormField>
      <UButton v-if="savedLink" class="mt-4" :to="localePath(savedLink)">{{
        $t('issuer.engine.openCredential')
      }}</UButton>
    </UContainer>
    <CredentialIssueForm
      v-if="context"
      :key="`${context.key}:${context.subjectAddress}`"
      :issuer-context="context"
      @busy="engineBusy = $event"
    />
  </div>
</template>
