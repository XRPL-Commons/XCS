import type { IssuerWorkspaceView } from '~/types/portal'

export function useIssuerWorkspace() {
  const route = useRoute()
  const request = useRequestFetch()
  const auth = useAuth()
  const organizationId = computed(() =>
    typeof route.query.organizationId === 'string' ? route.query.organizationId : undefined,
  )
  const state = useAsyncData(
    'issuer-workspace',
    () =>
      request<IssuerWorkspaceView>('/api/issuer/workspace', {
        query: organizationId.value ? { organizationId: organizationId.value } : {},
      }),
    { watch: [organizationId] },
  )
  return { ...state, organizationId, mutate: auth.mutateApplication }
}
