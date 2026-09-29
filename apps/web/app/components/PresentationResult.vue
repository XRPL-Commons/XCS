<script setup lang="ts">
import type { ResolvedPresentationView } from '~/types/portal'
import { presentationHeadline } from '~/utils/presentationView'

const props = defineProps<{ result: ResolvedPresentationView }>()
const auth = useAuth()
const { locale } = useI18n()
const date = (value: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
const holderProof = computed(() =>
  props.result.holderProof?.status === 'verified' &&
  props.result.holderProof.address === props.result.credential.subjectAddress &&
  props.result.holderProof.networkId === props.result.credential.networkId
    ? props.result.holderProof
    : null,
)
const admission = computed(() =>
  props.result.issuerAdmission?.organizationId === props.result.credential.organizationId
    ? props.result.issuerAdmission
    : undefined,
)
const headline = computed(() =>
  presentationHeadline(props.result.verification, { usable: true, fresh: true }),
)
</script>
<template>
  <article data-testid="presentation-result">
    <h1 class="text-2xl font-bold">
      {{ result.credential.schemaName ?? $t('recipient.credential') }}
    </h1>
    <p class="mt-2 text-lg">
      {{ $t('simpleUi.issuedBy', { name: result.credential.organizationName }) }}
    </p>
    <h2 class="mt-5 text-xl font-semibold" data-testid="presentation-headline">
      {{ $t(`presentation.headlines.${headline}`) }}
    </h2>
    <p class="mt-2 text-sm text-muted">{{ $t('presentation.limitation') }}</p>
    <p v-if="result.verification.payload === 'not_checked'" class="mt-2 font-semibold">
      {{ $t('presentation.partialHelp') }}
    </p>
    <div class="mt-5 grid gap-4 lg:grid-cols-3">
      <section
        class="rounded border border-default p-4"
        :aria-label="$t('roleJourney.admissionTitle')"
      >
        <h2 class="font-semibold">{{ $t('roleJourney.admissionTitle') }}</h2>
        <p class="mt-2">{{ result.credential.organizationName }}</p>
        <p class="mt-2 font-semibold">
          {{ $t(`roleJourney.admissionStatuses.${admission?.status ?? 'unknown'}`) }}
        </p>
        <p v-if="admission?.reviewedAt" class="mt-2 text-sm">
          {{ $t('roleJourney.admissionReviewedAt', { date: date(admission.reviewedAt) }) }}
        </p>
        <p v-if="admission?.checkedAt" class="mt-2 text-sm">
          {{ $t('roleJourney.checkedAt', { date: date(admission.checkedAt) }) }}
        </p>
        <p class="mt-2 text-sm text-muted">{{ $t('roleJourney.admissionMeaning') }}</p>
      </section>
      <section
        class="rounded border border-default p-4"
        :aria-label="$t('roleJourney.ledgerRecipientTitle')"
      >
        <h2 class="font-semibold">{{ $t('roleJourney.ledgerRecipientTitle') }}</h2>
        <p class="mt-2">{{ $t(`roleJourney.ledgerStatuses.${result.credential.status.state}`) }}</p>
      </section>
      <section
        class="rounded border border-default p-4"
        :aria-label="$t('roleJourney.holderProofTitle')"
      >
        <h2 class="font-semibold">{{ $t('roleJourney.holderProofTitle') }}</h2>
        <p class="mt-3 font-semibold">
          {{
            holderProof
              ? $t('roleJourney.holderVerifiedAt', { date: date(holderProof.verifiedAt) })
              : $t('roleJourney.holderProofMissing')
          }}
        </p>
        <p class="mt-2 text-sm text-muted">{{ $t('roleJourney.holderProofMeaning') }}</p>
        <p v-if="!holderProof" class="mt-2 text-sm text-muted">
          {{ $t('roleJourney.holderProofRecreate') }}
        </p>
      </section>
    </div>

    <p class="mt-4 font-semibold">
      {{ $t(result.scope === 'full' ? 'presentation.fullFields' : 'presentation.publicFields') }}
    </p>
    <p v-if="!Object.keys(result.claims).length" class="mt-3 text-muted">
      {{ $t('presentation.noFields') }}
    </p>
    <AttestationFields v-else class="mt-3" :claims="result.claims" />
    <StatusBox v-if="result.requiresAuthorization" class="mt-5" tone="warning">{{
      $t(auth.user.value ? 'presentation.audienceIncorrect' : 'presentation.authorizationHelp')
    }}</StatusBox>
  </article>
</template>
