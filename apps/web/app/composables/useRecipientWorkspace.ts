import type { RecipientWorkspace } from '../../server/xcs/recipient/types'

export function useRecipientWorkspace() {
  const request = useRequestFetch()
  return useAsyncData('recipient-workspace', () =>
    request<RecipientWorkspace>('/api/recipient/workspace'),
  )
}
