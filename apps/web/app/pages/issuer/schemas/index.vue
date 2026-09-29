<script setup lang="ts">
definePageMeta({ layout: 'issuer', middleware: ['auth', 'role'], requiredRole: 'issuer' })
</script>

<template>
  <IssuerWorkspace section="schemas" />
</template>
