<script setup lang="ts">
import { rippleTimeToIso } from '#xcs/core/index.js'
import {
  assertIssuerWallet,
  type IssuerCredentialDetail,
  type IssuerRevokeEngineContext,
} from '~/utils/issuerEngine'

definePageMeta({ layout: 'issuer', middleware: ['auth', 'role'], requiredRole: 'issuer' })
const route = useRoute()
const { t } = useI18n()
const localePath = useLocalePath()
const api = useIssuerEngineApi()
const auth = useAuth()
const { busy: walletBusy } = useWallet()
const detail = shallowRef<IssuerCredentialDetail | null>(null)
const error = ref('')
const generationId = String(route.params.generationId)
const profileId = typeof route.query.profile === 'string' ? route.query.profile : ''
const recovery = useIssuerEngineRecovery(() => ({
  key: `revoke:${auth.user.value?.id}:${profileId}:${generationId}`,
  profileId,
  async beforeSign() {},
  async record(receipt) {
    await api.reconcileRevocation(profileId, generationId, receipt.transactionHash)
    await reload()
  },
}))
async function reload() {
  detail.value = await api.credential(profileId, generationId)
}
try {
  await reload()
} catch (cause) {
  error.value = cause instanceof Error ? cause.message : String(cause)
}
const context = computed<IssuerRevokeEngineContext | undefined>(() => {
  const current = detail.value
  if (!current || current.status.accepted === null || current.status.deletedLedgerIndex !== null)
    return undefined
  return {
    profileId: current.profileId,
    generationId: current.generationId,
    schemaUid: current.schemaUid,
    schemaName: current.schema.name,
    issuerAddress: current.issuerAddress,
    subjectAddress: current.subjectAddress,
    recipientLabel: current.recipient?.displayName ?? t('simpleIssuer.recipientFallback'),
    async beforeSign(publisher) {
      await auth.load(true)
      await auth.checkRole('issuer', current.organizationId)
      assertIssuerWallet(auth.user.value?.wallets ?? [], publisher)
      const latest = await api.credential(current.profileId, current.generationId)
      if (
        latest.status.deletedLedgerIndex !== null ||
        latest.issuerAddress !== publisher ||
        latest.subjectAddress !== current.subjectAddress ||
        latest.schemaUid !== current.schemaUid
      )
        throw new Error('ISSUER_CONTEXT_CHANGED')
    },
    onSigned: (transactionHash) => recovery.stash({ transactionHash }),
    afterConfirmed: (result) => recovery.finish(result),
  }
})
const credentialState = computed(() => {
  const status = detail.value?.status
  if (!status || status.accepted === null) return 'unknown'
  if (status.deletedLedgerIndex !== null) return 'deleted'
  if (status.expiration !== null && Date.parse(rippleTimeToIso(status.expiration)) <= Date.now())
    return 'expired'
  return status.accepted ? 'active' : 'pending'
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
      <IssuerEngineRecovery
        :pending="recovery.pending.value"
        :saved="recovery.saved.value"
        :busy="recovery.saving.value || walletBusy"
        :error="recovery.error.value"
        :can-restart="recovery.canRestart.value"
        @restart="recovery.restart"
        @retry="recovery.retry"
      />
      <UCard v-if="detail" class="mt-5">
        <h1 class="text-xl font-semibold">{{ detail.schema.name }}</h1>
        <p class="mt-3">
          {{ $t('simpleIssuer.recipient') }}:
          {{ detail.recipient?.displayName ?? $t('simpleIssuer.recipientFallback') }}
        </p>
        <p>{{ $t('simpleIssuer.visibility') }}: {{ $t(`simpleIssuer.${detail.visibility}`) }}</p>
        <AttestationStatus :value="credentialState" />
      </UCard>
    </UContainer>
    <CredentialRevokeForm
      v-if="context && !recovery.pending.value && !recovery.saved.value"
      :issuer-context="context"
    />
  </div>
</template>
