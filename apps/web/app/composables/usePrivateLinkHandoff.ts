export type PrivateLinkKind = 'invitation' | 'presentation'

/** Hold a link through OIDC in a short-lived HttpOnly cookie, never browser storage. */
export function usePrivateLinkHandoff() {
  const auth = useAuth()
  async function save(kind: PrivateLinkKind, token: string): Promise<void> {
    if (import.meta.server) throw new Error('AUTH_BROWSER_REQUIRED')
    await $fetch('/api/auth/link-handoff', { method: 'POST', body: { kind, token } })
  }
  async function consume(kind: PrivateLinkKind): Promise<string | null> {
    if (!auth.user.value) return null
    const result = await auth.mutateApplication<{ token: string | null }>(
      '/api/auth/link-handoff/consume',
      { kind },
    )
    return result.token
  }
  return { save, consume }
}
