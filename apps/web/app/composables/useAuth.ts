import type { Account, AppRole } from '../../server/xcs/auth/types'

export interface AuthSessionView {
  enabled: boolean
  user: Account | null
  csrfToken?: string
  expiresAt?: string
  absoluteExpiresAt?: string
}

export function useAuth() {
  // Nuxt scopes these values to the SSR request, then hydrates the browser instance.
  const session = useState<AuthSessionView | null>('xcs-auth-session', () => null)
  const loaded = useState('xcs-auth-loaded', () => false)
  const unavailable = useState('xcs-auth-unavailable', () => false)
  const request = useRequestFetch()
  const cacheControl = import.meta.server ? useResponseHeader('cache-control') : undefined

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    try {
      session.value = await request<AuthSessionView>('/api/auth/session')
      unavailable.value = false
      // The SSR payload includes identity and CSRF state when account access is enabled.
      if (session.value.enabled && cacheControl) cacheControl.value = 'private, no-store'
    } catch {
      session.value = null
      unavailable.value = true
    } finally {
      loaded.value = true
    }
  }

  async function mutate<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return mutateApplication<T>(`/api/auth/${path}`, body)
  }

  async function mutateApplication<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const target = new URL(path, 'https://xcs.invalid')
    if (
      target.origin !== 'https://xcs.invalid' ||
      target.pathname !== path ||
      target.search ||
      target.hash ||
      !/^\/api\/(?:auth|issuer|recipient|verifier)\//.test(target.pathname)
    ) {
      throw new Error('AUTH_PATH_INVALID')
    }
    if (import.meta.server) throw new Error('AUTH_BROWSER_REQUIRED')
    if (!session.value?.csrfToken) throw new Error('AUTH_REQUIRED')
    try {
      return await request<T>(path, {
        method: 'POST',
        headers: { 'x-xcs-csrf': session.value.csrfToken },
        ...(body ? { body } : {}),
      })
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 401) {
        session.value = { enabled: true, user: null }
      }
      throw error
    }
  }

  async function updateSession(path: string, body?: Record<string, unknown>): Promise<void> {
    session.value = await mutate<AuthSessionView>(path, body)
  }

  async function logout(): Promise<void> {
    await mutate('logout')
    session.value = { enabled: true, user: null }
  }

  function hasRole(role: AppRole, organizationId?: string): boolean {
    const user = session.value?.user
    if (!user) return false
    if (role === 'admin' || role === 'recipient') return user.roles.includes(role)
    return user.organizations.some(
      (organization) =>
        (!organizationId || organization.id === organizationId) &&
        organization.roles.includes(role),
    )
  }

  return {
    user: computed(() => session.value?.user ?? null),
    enabled: computed(() => session.value?.enabled === true),
    expiresAt: computed(() => session.value?.expiresAt),
    absoluteExpiresAt: computed(() => session.value?.absoluteExpiresAt),
    unavailable: readonly(unavailable),
    csrfToken: computed(() => session.value?.csrfToken),
    load,
    mutateApplication,
    hasRole,
    checkRole: (role: AppRole, organizationId?: string) =>
      request('/api/auth/access', {
        query: { role, ...(organizationId ? { organizationId } : {}) },
      }),
    refresh: () => updateSession('refresh'),
    logout,
    createWalletChallenge: (address: string) =>
      mutate<{ id: string; message: string; expiresAt: string }>('wallet/challenge', {
        address,
        networkId: 1,
      }),
    linkWallet: (
      challengeId: string,
      proof: { signature: string; publicKey: string; scheme: 'ripple' | 'otsu' },
    ) => updateSession('wallet/link', { challengeId, ...proof }),
    unlinkWallet: (walletId: string) => updateSession('wallet/unlink', { walletId }),
  }
}
