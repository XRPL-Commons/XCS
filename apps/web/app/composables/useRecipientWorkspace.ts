import type { RecipientWorkspaceView } from '~/types/portal'

export function useRecipientWorkspace() {
  const request = useRequestFetch()
  return useAsyncData('recipient-workspace', () =>
    request<RecipientWorkspaceView>('/api/recipient/workspace'),
  )
}
