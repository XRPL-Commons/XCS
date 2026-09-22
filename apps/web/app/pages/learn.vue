<template>
  <UContainer as="article" class="py-10 sm:py-14">
    <PageHeader eyebrow="XCS 0.1" :title="$t('learn.title')" :lead="$t('learn.intro')" />

    <h2 class="mb-4 text-2xl">{{ $t('learn.actorsTitle') }}</h2>
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <UCard
        v-for="actor in [
          { name: 'Publisher', copy: $t('learn.publisher') },
          { name: 'Issuer', copy: $t('learn.issuer') },
          { name: 'Subject', copy: $t('learn.subject') },
          { name: 'Verifier', copy: $t('learn.verifier') },
          { name: 'Indexer', copy: $t('learn.indexer') },
          { name: 'Registry', copy: $t('learn.registry') },
        ]"
        :key="actor.name"
      >
        <h3 class="text-lg font-semibold">{{ actor.name }}</h3>
        <p class="mt-2 text-sm text-toned">{{ actor.copy }}</p>
      </UCard>
    </div>

    <h2 class="mt-12 mb-4 text-2xl">{{ $t('learn.verificationTitle') }}</h2>
    <p class="mb-4 text-toned">{{ $t('learn.verification') }}</p>
    <div class="flex flex-wrap gap-2">
      <StatusPill value="active" />
      <StatusPill value="valid" />
      <StatusPill value="unknown" />
    </div>
  </UContainer>
</template>
