import type { AuthSessionView } from './useAuth'

export type AdminRole = 'issuer' | 'verifier'
export type AdminStatus = 'pending' | 'approved' | 'rejected' | 'suspended'
export type AdminAction = 'approve' | 'reject' | 'suspend' | 'restore'
export interface AdminApplication {
  organization_id: string
  role: AdminRole
  status: AdminStatus
  revision: number
  name: string
  submitted_at: string
  reviewed_at: string | null
  review_reason: string | null
  website?: string | null
  contact?: string | null
  jurisdiction?: string | null
  description?: string | null
  purpose?: string | null
  responsible_name?: string | null
  responsible_email?: string | null
}
export interface AdminAudit {
  id: string
  organization_id: string | null
  role: AdminRole | null
  organization_name: string | null
  actor_name: string | null
  actor_id: string
  action: string
  before_status: AdminStatus | null
  after_status: AdminStatus | null
  reason: string | null
  created_at: string
  notification_id?: string | null
  notification_status?: 'pending' | 'sending' | 'sent' | 'failed' | 'blocked' | 'uncertain' | null
}
export interface AdminPage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  counts?: { issuer: number; verifier: number }
}
export interface AdminDetail {
  application: AdminApplication
  wallets: { address: string; network_id: number; verified_at: string }[]
  documents: { id: string; mime_type: string; byte_length: number }[]
  history: AdminAudit[]
}
export interface AdminDecisionRequest {
  action: AdminAction
  revision: number
  reason: string
  idempotencyKey: string
}

export function useAdminApi() {
  const request = useRequestFetch()
  const session = useState<AuthSessionView | null>('xcs-auth-session', () => null)
  const { locale } = useI18n()
  if (import.meta.server) useResponseHeader('cache-control').value = 'private, no-store'

  function get<T>(path: string, query?: Record<string, string | number>) {
    return request<T>(`/api/admin/${path}`, { query, retry: 0 })
  }

  function post<T>(path: string, body: Record<string, unknown> = {}) {
    if (!session.value?.csrfToken) {
      throw createError({ statusCode: 401, message: 'AUTH_REQUIRED' })
    }
    return request<T>(`/api/admin/${path}`, {
      method: 'POST',
      headers: { 'x-xcs-csrf': session.value.csrfToken },
      body,
      retry: 0,
    })
  }

  function date(value: string | null | undefined): string {
    if (!value) return '—'
    return (
      new Intl.DateTimeFormat(locale.value, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value)) + ' UTC'
    )
  }

  return { get, post, date }
}
