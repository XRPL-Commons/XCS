<script setup lang="ts">
const props = defineProps<{ role: 'issuer' | 'verifier' }>()
const { t } = useI18n()
const localePath = useLocalePath()
const auth = useAuth()
const { loading, problem, run, reset } = usePortalMutation()
const form = reactive({
  name: '',
  website: '',
  contact: '',
  jurisdiction: '',
  description: '',
  purpose: '',
})
const fields = ['name', 'website', 'contact', 'jurisdiction', 'description', 'purpose'] as const
const files = ref<File[]>([])

const title = computed(() =>
  props.role === 'issuer' ? t('simpleIssuer.applyTitle') : t('verifier.apply'),
)
const lead = computed(() =>
  props.role === 'issuer' ? t('simpleIssuer.applyLead') : t('verifier.applyHelp'),
)
const statusPath = computed(() => (props.role === 'issuer' ? '/issuer/application' : '/verifier'))

function selectFiles(event: Event) {
  reset()
  files.value = Array.from((event.target as HTMLInputElement).files ?? [])
}

function encodeFile(file: File): Promise<{ mimeType: string; base64: string }> {
  return new Promise((resolve, reject) => {
    if (
      file.size > 5 * 1024 * 1024 ||
      !['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)
    )
      return reject(new Error('DOCUMENT_INVALID'))
    const reader = new FileReader()
    reader.onload = () =>
      resolve({ mimeType: file.type, base64: String(reader.result).split(',')[1] ?? '' })
    reader.onerror = () => reject(new Error('DOCUMENT_UNREADABLE'))
    reader.readAsDataURL(file)
  })
}

async function submit() {
  await run(async () => {
    if (files.value.length < 1 || files.value.length > 3) throw new Error('DOCUMENT_INVALID')
    const documents = await Promise.all(files.value.map(encodeFile))
    const result = await auth.mutateApplication<{ organizationId: string }>(
      `/api/${props.role}/applications`,
      { ...form, documents },
    )
    await navigateTo({
      path: localePath(statusPath.value),
      ...(props.role === 'issuer' ? { query: { organizationId: result.organizationId } } : {}),
    })
  })
}
</script>

<template>
  <UContainer class="max-w-3xl py-10">
    <PageHeader :title="title" :lead="lead" />
    <StatusBox v-if="problem" tone="error" role="alert" class="mb-5">
      {{
        $t(
          problem.code.startsWith('DOCUMENT_')
            ? 'simpleIssuer.documentError'
            : 'issuer.applicationError',
        )
      }}
      <p v-if="problem.stateUnchanged" class="mt-2 text-sm">
        {{ $t('portal.errors.unchanged') }}
      </p>
    </StatusBox>
    <form class="grid gap-5" @submit.prevent="submit">
      <label v-for="field in fields" :key="field" class="font-semibold">
        {{ $t(`simpleIssuer.applicationFields.${field}`) }}
        <textarea
          v-if="field === 'description' || field === 'purpose'"
          v-model="form[field]"
          required
          maxlength="2000"
          :disabled="loading"
          class="mt-2 block w-full rounded border border-default bg-default p-3 font-normal"
        />
        <input
          v-else
          v-model="form[field]"
          :type="field === 'website' ? 'url' : field === 'contact' ? 'email' : 'text'"
          required
          :maxlength="field === 'website' ? 2048 : 254"
          :disabled="loading"
          class="mt-2 block w-full rounded border border-default bg-default p-3 font-normal"
        />
      </label>
      <label class="font-semibold">
        {{ $t('issuer.documents') }}
        <input
          type="file"
          multiple
          required
          accept="application/pdf,image/png,image/jpeg"
          :disabled="loading"
          class="mt-2 block w-full"
          @change="selectFiles"
        />
        <span class="mt-2 block text-sm font-normal text-muted">{{
          $t('issuer.documentsHelp')
        }}</span>
      </label>
      <ul
        v-if="files.length"
        class="list-disc pl-5 text-sm"
        :aria-label="$t('simpleIssuer.documentsReady')"
      >
        <li v-for="(file, index) in files" :key="`${file.name}:${index}`">{{ file.name }}</li>
      </ul>
      <p class="text-sm text-muted">{{ $t('simpleIssuer.applicationPrivacy') }}</p>
      <p class="text-sm text-muted">
        {{ $t(role === 'issuer' ? 'simpleIssuer.applicationNext' : 'verifier.approvalMeaning') }}
      </p>
      <UButton type="submit" :loading="loading" :disabled="loading">
        {{ $t(role === 'issuer' ? 'simpleIssuer.applySubmit' : 'issuer.submit') }}
      </UButton>
    </form>
    <UButton :to="localePath(statusPath)" color="neutral" variant="link" class="mt-5">
      {{ $t(role === 'issuer' ? 'issuer.application' : 'verifier.title') }}
    </UButton>
  </UContainer>
</template>
