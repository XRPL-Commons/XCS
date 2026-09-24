<script setup lang="ts">
import { assertIssuerWallet, type IssuerSchemaEngineContext } from '~/utils/issuerEngine'

definePageMeta({ layout: 'issuer', middleware: ['auth', 'role'], requiredRole: 'issuer' })
const route = useRoute()
const localePath = useLocalePath()
const auth = useAuth()
const api = useIssuerEngineApi()
const { getActiveNetworkProfile } = useXcsApi()
const organizations = computed(
  () => auth.user.value?.organizations.filter((item) => item.roles.includes('issuer')) ?? [],
)
const organizationId = ref(
  typeof route.query.organizationId === 'string'
    ? route.query.organizationId
    : (organizations.value[0]?.id ?? ''),
)
const profileId = ref('')
const error = ref('')
const engineBusy = ref(false)
try {
  profileId.value = (await getActiveNetworkProfile()).profileId
} catch (cause) {
  error.value = cause instanceof Error ? cause.message : String(cause)
}
const context = computed<IssuerSchemaEngineContext | undefined>(() => {
  if (!profileId.value || !organizations.value.some((item) => item.id === organizationId.value))
    return undefined
  const selectedId = organizationId.value
  const selectedProfile = profileId.value
  return {
    key: `schema:${auth.user.value?.id}:${selectedId}:${selectedProfile}`,
    profileId: selectedProfile,
    async beforeSign(publisher) {
      await auth.load(true)
      await auth.checkRole('issuer', selectedId)
      assertIssuerWallet(auth.user.value?.wallets ?? [], publisher)
    },
    async record(receipt) {
      await api.recordSchema(selectedId, selectedProfile, receipt)
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
      <USelect
        v-if="organizations.length > 1"
        v-model="organizationId"
        :disabled="engineBusy"
        class="mt-4"
        :items="organizations.map((item) => ({ label: item.name, value: item.id }))"
      />
      <StatusBox v-if="error" tone="error"
        ><p>{{ $t('simpleIssuer.error') }}</p>
        <details>
          <summary>{{ $t('simpleIssuer.technical') }}</summary>
          <code>{{ error }}</code>
        </details></StatusBox
      >
    </UContainer>
    <SchemaRegistrationForm
      v-if="context"
      :key="context.key"
      :issuer-context="context"
      @busy="engineBusy = $event"
    />
  </div>
</template>
