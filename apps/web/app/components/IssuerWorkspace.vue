<script setup lang="ts">
import { issuerCredentialState, issuerInvitationState } from '~/utils/issuerWorkspace'
const props = defineProps<{ section: 'schemas' | 'recipients' | 'credentials' }>()
const { t, locale } = useI18n()
const localePath = useLocalePath()
const route = useRoute()
const { data, error, status, refresh, mutate } = useIssuerWorkspace()
const selected = computed(() => data.value?.selectedOrganizationId)
const selectedOrganization = computed(() =>
  data.value?.organizations.find((org) => org.id === selected.value),
)
const approved = computed(
  () =>
    selectedOrganization.value?.status === 'active' &&
    selectedOrganization.value.applicationStatus === 'approved',
)
const busy = ref(false)
const failure = ref(false)
const notice = ref('')
const noticeTone = ref<'success' | 'notice'>('success')
const email = ref('')
const message = ref('')
const chosenSchema = ref(typeof route.query.model === 'string' ? route.query.model : '')
const confirmation = ref<string | null>(null)
const availableSchemas = computed(() => data.value?.schemas ?? [])
watch(
  availableSchemas,
  (schemas) => {
    if (!data.value) return
    if (schemas.some((schema) => `${schema.profileId}:${schema.schemaUid}` === chosenSchema.value))
      return
    chosenSchema.value =
      schemas.length === 1 ? `${schemas[0]!.profileId}:${schemas[0]!.schemaUid}` : ''
  },
  { immediate: true },
)
const selectedSchema = computed(() =>
  availableSchemas.value.find(
    (schema) => `${schema.profileId}:${schema.schemaUid}` === chosenSchema.value,
  ),
)
const date = (value: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )

async function selectOrganization(event: Event) {
  await navigateTo({
    path: route.path,
    query: { ...route.query, organizationId: (event.target as HTMLSelectElement).value },
  })
}
async function action(
  work: () => Promise<unknown>,
  successKey: string | (() => string) = 'simpleIssuer.recorded',
) {
  if (busy.value) return
  busy.value = true
  failure.value = false
  notice.value = ''
  noticeTone.value = 'success'
  try {
    await work()
    notice.value = t(typeof successKey === 'function' ? successKey() : successKey)
    await refresh()
  } catch {
    failure.value = true
  } finally {
    busy.value = false
  }
}
async function invite() {
  const schema = selectedSchema.value
  if (!schema || !selected.value) return
  let deliveryConfirmed = false
  await action(
    async () => {
      const response = await mutate<{ deliveryStatus: string }>('/api/issuer/invites', {
        organizationId: selected.value,
        profileId: schema.profileId,
        schemaUid: schema.schemaUid,
        email: email.value,
        message: message.value,
      })
      deliveryConfirmed = response.deliveryStatus === 'sent'
      noticeTone.value = deliveryConfirmed ? 'success' : 'notice'
      email.value = ''
      message.value = ''
    },
    () => (deliveryConfirmed ? 'simpleIssuer.invitationSent' : 'simpleIssuer.invitationCreated'),
  )
}
async function confirmInvitationAction(inviteId: string) {
  const operation = confirmation.value?.startsWith('resend:') ? 'resend' : 'revoke'
  await action(() => mutate(`/api/issuer/invites/${inviteId}/${operation}`, {}))
  confirmation.value = null
}
useSeoMeta({
  title: () => `${t(`simpleIssuer.sections.${props.section}`)} — XCS`,
  robots: 'noindex,nofollow',
})
</script>

<template>
  <PageHeader :title="$t(`simpleIssuer.sections.${section}`)" :lead="$t('issuer.intro')" />
  <StatusBox v-if="error || failure" tone="error" role="alert" class="mb-5"
    >{{ $t('issuer.error') }}
    <UButton class="ml-3" color="neutral" variant="outline" @click="refresh()">{{
      $t('issuer.retry')
    }}</UButton>
  </StatusBox>
  <StatusBox v-if="notice" :tone="noticeTone" role="status" class="mb-5">{{ notice }}</StatusBox>
  <p v-if="status === 'pending'">{{ $t('issuer.loading') }}</p>
  <template v-if="data">
    <label class="mb-2 block font-semibold" for="issuer-organization">{{
      $t('issuer.organization')
    }}</label>
    <select
      id="issuer-organization"
      :value="selected"
      class="mb-6 w-full rounded border border-default bg-default p-3"
      @change="selectOrganization"
    >
      <option v-for="org in data.organizations" :key="org.id" :value="org.id">
        {{ org.name }} — {{ $t(`issuer.states.${org.applicationStatus}`) }}
      </option>
    </select>
    <StatusBox v-if="!approved" tone="notice"
      >{{ $t('issuer.approvalRequired') }}
      <UButton :to="localePath('/issuer/application')" class="ml-3">{{
        $t('issuer.application')
      }}</UButton>
    </StatusBox>
    <template v-else-if="section === 'schemas'">
      <UButton
        :to="{ path: localePath('/issuer/schemas/new'), query: { organizationId: selected } }"
        >{{ $t('simpleIssuer.createModel') }}</UButton
      >
      <p v-if="!data.schemas.length" class="mt-6 text-muted">{{ $t('simpleIssuer.noModels') }}</p>
      <ul class="mt-6 grid gap-4 sm:grid-cols-2">
        <li v-for="schema in data.schemas" :key="`${schema.profileId}:${schema.schemaUid}`">
          <UCard>
            <h2 class="font-semibold">{{ schema.displayName || schema.name }}</h2>
            <p class="text-muted">{{ schema.category }}</p>
            <UButton
              class="mt-3"
              :to="{
                path: localePath('/issuer/recipients'),
                query: {
                  organizationId: selected,
                  model: `${schema.profileId}:${schema.schemaUid}`,
                },
              }"
              >{{ $t('simpleIssuer.invite') }}</UButton
            >
          </UCard>
        </li>
      </ul>
    </template>
    <template v-else-if="section === 'recipients'">
      <StatusBox v-if="!availableSchemas.length" tone="notice" class="mb-5">
        <p>{{ $t('simpleIssuer.createFirst') }}</p>
        <UButton
          class="mt-3"
          :to="{ path: localePath('/issuer/schemas/new'), query: { organizationId: selected } }"
          >{{ $t('simpleIssuer.createModel') }}</UButton
        >
      </StatusBox>
      <UCard v-else>
        <h2 class="text-xl font-semibold">{{ $t('simpleIssuer.invite') }}</h2>
        <p class="mt-2 text-muted">{{ $t('simpleIssuer.inviteHelp') }}</p>
        <form class="mt-4 grid gap-4" @submit.prevent="invite">
          <label
            >{{ $t('simpleIssuer.contactEmail')
            }}<input
              v-model="email"
              type="email"
              maxlength="254"
              required
              class="mt-1 block w-full rounded border border-default bg-default p-3"
          /></label>
          <label
            >{{ $t('simpleIssuer.model')
            }}<select
              v-model="chosenSchema"
              required
              class="mt-1 block w-full rounded border border-default bg-default p-3"
            >
              <option value="" disabled>{{ $t('simpleIssuer.chooseModel') }}</option>
              <option
                v-for="schema in availableSchemas"
                :key="`${schema.profileId}:${schema.schemaUid}`"
                :value="`${schema.profileId}:${schema.schemaUid}`"
              >
                {{ schema.displayName || schema.name }}
              </option>
            </select></label
          >
          <label
            >{{ $t('issuer.message')
            }}<textarea
              v-model="message"
              maxlength="2000"
              class="mt-1 block w-full rounded border border-default bg-default p-3"
            />
          </label>
          <UButton type="submit" :loading="busy" :disabled="busy || !selectedSchema">{{
            $t('issuer.sendInvite')
          }}</UButton>
        </form>
      </UCard>
      <p v-if="!data.invites.length" class="mt-6 text-muted">{{ $t('issuer.noInvites') }}</p>
      <ul class="mt-6 grid gap-4">
        <li v-for="item in data.invites" :key="item.id">
          <UCard>
            <h2 class="font-semibold break-all">{{ item.recipientDisplayName || item.email }}</h2>
            <p v-if="item.recipientDisplayName" class="mt-1 text-sm text-muted">{{ item.email }}</p>
            <p class="mt-2">{{ $t(`issuer.states.${issuerInvitationState(item)}`) }}</p>
            <p v-if="!item.revokedAt" class="mt-2 font-semibold">
              {{ $t(`roleJourney.recipientStates.${item.recipientStatus ?? 'unavailable'}`) }}
            </p>
            <p v-if="item.recipientWalletVerifiedAt" class="mt-2 text-sm text-muted">
              {{
                $t('roleJourney.walletVerifiedAt', { date: date(item.recipientWalletVerifiedAt) })
              }}
            </p>
            <details class="mt-3">
              <summary class="cursor-pointer text-sm text-muted">
                {{ $t('simpleIssuer.deliveryDetails') }}
              </summary>
              <p class="text-sm text-muted">
                {{ $t('issuer.delivery') }}:
                {{ $t(`issuer.deliveryStates.${item.deliveryStatus || 'pending'}`) }}
              </p>
            </details>
            <StatusBox v-if="item.deliveryStatus === 'failed'" tone="error" class="mt-3">
              {{ $t('simpleIssuer.deliveryFailed') }}
            </StatusBox>
            <StatusBox v-else-if="item.deliveryStatus === 'uncertain'" tone="warning" class="mt-3">
              {{ $t('issuer.uncertain') }}
            </StatusBox>
            <div class="mt-4 flex flex-wrap gap-3">
              <UButton
                v-if="item.claimedAt && !item.revokedAt && item.recipientStatus === 'ready'"
                :to="localePath(`/issuer/issue/${item.id}`)"
                >{{ $t('simpleIssuer.readyAction') }}</UButton
              >
              <UButton
                v-if="!item.claimedAt && !item.revokedAt"
                :disabled="busy"
                color="neutral"
                variant="outline"
                @click="confirmation = `resend:${item.id}`"
                >{{ $t('issuer.resend') }}</UButton
              >
              <UButton
                v-if="!item.revokedAt && !item.claimedAt"
                :disabled="busy"
                color="neutral"
                variant="outline"
                @click="confirmation = `revoke:${item.id}`"
                >{{ $t('simpleIssuer.cancelInvitation') }}</UButton
              >
            </div>
            <div
              v-if="confirmation?.endsWith(item.id)"
              class="mt-4 rounded border border-default p-4"
            >
              <p>
                {{
                  confirmation.startsWith('resend:')
                    ? $t('issuer.resendConfirm')
                    : $t('simpleIssuer.cancelInvitationConfirm')
                }}
              </p>
              <UButton class="mt-3" :disabled="busy" @click="confirmInvitationAction(item.id)">{{
                $t('issuer.confirm')
              }}</UButton>
              <UButton
                class="ml-3 mt-3"
                color="neutral"
                variant="outline"
                @click="confirmation = null"
                >{{ $t('issuer.cancel') }}</UButton
              >
            </div>
          </UCard>
        </li>
      </ul>
    </template>
    <template v-else-if="section === 'credentials'">
      <p v-if="!data.credentials.length" class="text-muted">{{ $t('issuer.noCredentials') }}</p>
      <ul class="grid gap-4">
        <li v-for="item in data.credentials" :key="item.generationId">
          <UCard>
            <h2 class="font-semibold">
              {{
                data.schemas.find(
                  (schema) =>
                    schema.schemaUid === item.schemaUid && schema.profileId === item.profileId,
                )?.displayName || $t('issuer.attestation')
              }}
            </h2>
            <p class="mt-2">
              {{
                data.invites.find((invite) => invite.id === item.inviteId)?.recipientDisplayName ||
                $t('simpleIssuer.recipientFallback')
              }}
            </p>
            <p class="text-sm text-muted">{{ $t(`simpleIssuer.${item.visibility}`) }}</p>
            <p>{{ $t(`issuer.states.${issuerCredentialState(item)}`) }}</p>
            <UButton
              class="mt-3"
              :to="{
                path: localePath(`/issuer/credentials/${item.generationId}`),
                query: { profile: item.profileId },
              }"
              >{{ $t('issuer.open') }}</UButton
            >
          </UCard>
        </li>
      </ul>
    </template>
  </template>
</template>
