<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })
const { t } = useI18n()
const localePath = useLocalePath()
const auth = useAuth()
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
const busy = ref(false)
const error = ref('')
function selectFiles(event: Event) {
  error.value = ''
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
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (files.value.length < 1 || files.value.length > 3) throw new Error('DOCUMENT_INVALID')
    const documents = await Promise.all(files.value.map(encodeFile))
    const result = await auth.mutateApplication<{ organizationId: string }>(
      '/api/issuer/applications',
      { ...form, documents },
    )
    await navigateTo({
      path: localePath('/issuer/application'),
      query: { organizationId: result.organizationId },
    })
  } catch (cause) {
    error.value =
      cause instanceof Error && ['DOCUMENT_INVALID', 'DOCUMENT_UNREADABLE'].includes(cause.message)
        ? t('simpleIssuer.documentError')
        : t('issuer.applicationError')
  } finally {
    busy.value = false
  }
}
useSeoMeta({ title: () => `${t('simpleIssuer.applyTitle')} — XCS`, robots: 'noindex,nofollow' })
</script>

<template>
  <UContainer class="max-w-3xl py-10">
    <PageHeader :title="$t('simpleIssuer.applyTitle')" :lead="$t('simpleIssuer.applyLead')" />
    <StatusBox v-if="error" tone="error" role="alert" class="mb-5">{{ error }}</StatusBox>
    <form class="grid gap-5" @submit.prevent="submit">
      <label v-for="field in fields" :key="field" class="font-semibold"
        >{{ $t(`simpleIssuer.applicationFields.${field}`) }}
        <textarea
          v-if="field === 'description' || field === 'purpose'"
          v-model="form[field]"
          required
          maxlength="2000"
          class="mt-2 block w-full rounded border border-default bg-default p-3 font-normal"
        />
        <input
          v-else
          v-model="form[field]"
          :type="field === 'website' ? 'url' : field === 'contact' ? 'email' : 'text'"
          required
          :maxlength="field === 'website' ? 2048 : 254"
          class="mt-2 block w-full rounded border border-default bg-default p-3 font-normal"
        />
      </label>
      <label class="font-semibold"
        >{{ $t('issuer.documents') }}
        <input
          type="file"
          multiple
          required
          accept="application/pdf,image/png,image/jpeg"
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
        <li v-for="(file, index) in files" :key="index">{{ file.name }}</li>
      </ul>
      <p class="text-sm text-muted">{{ $t('simpleIssuer.applicationPrivacy') }}</p>
      <p class="text-sm text-muted">{{ $t('simpleIssuer.applicationNext') }}</p>
      <UButton type="submit" :loading="busy" :disabled="busy">{{
        $t('simpleIssuer.applySubmit')
      }}</UButton>
    </form>
    <UButton :to="localePath('/issuer/application')" color="neutral" variant="link" class="mt-5">{{
      $t('issuer.application')
    }}</UButton>
  </UContainer>
</template>
