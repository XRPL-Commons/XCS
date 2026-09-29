import type { Identity } from './oidc'

export type PersonalRole = 'admin' | 'recipient'
export type OrganizationRole = 'issuer' | 'verifier'
export type AppRole = PersonalRole | OrganizationRole
export interface Account {
  id: string
  email: string | null
  displayName: string | null
  roles: PersonalRole[]
  organizations: { id: string; name: string; roles: OrganizationRole[] }[]
  wallets: { id: string; address: string; networkId: number; verifiedAt: string }[]
}
export interface Session {
  id: string
  tokenHash: string
  userId: string
  csrfToken: string
  expiresAt: Date
  absoluteExpiresAt: Date
  account: Account
}
export interface LoginTransaction {
  stateHash: string
  browserHash: string
  nonce: string
  codeVerifier: string
  returnTo: string
  expiresAt: Date
}
export interface WalletChallenge {
  id: string
  sessionId: string
  networkId: number
  address: string
  message: string
  expiresAt: Date
}
export interface SessionInput {
  tokenHash: string
  csrfToken: string
  idleSeconds: number
  absoluteSeconds: number
}
export interface AuthRepository {
  saveLogin(login: LoginTransaction): Promise<void>
  consumeLogin(stateHash: string, browserHash: string): Promise<LoginTransaction | null>
  createSession(identity: Identity, input: SessionInput, previousTokenHash?: string): Promise<void>
  session(tokenHash: string): Promise<Session | null>
  refresh(tokenHash: string, input: SessionInput): Promise<boolean>
  logout(sessionId: string): Promise<void>
  saveChallenge(tokenHash: string, challenge: WalletChallenge): Promise<boolean>
  challenge(tokenHash: string, id: string): Promise<WalletChallenge | null>
  linkWallet(tokenHash: string, id: string): Promise<boolean>
  unlinkWallet(tokenHash: string, walletId: string): Promise<boolean>
}

export function hasRole(account: Account, role: AppRole, organizationId?: string): boolean {
  if (role === 'admin' || role === 'recipient') return account.roles.includes(role)
  return account.organizations.some(
    (org) => (!organizationId || org.id === organizationId) && org.roles.includes(role),
  )
}
