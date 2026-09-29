import { randomUUID } from 'node:crypto'
import type { Identity } from '../../server/xcs/auth/oidc'
import type {
  Account,
  AuthRepository,
  LoginTransaction,
  Session,
  SessionInput,
  WalletChallenge,
} from '../../server/xcs/auth/types'

/** Test storage only. Production always uses PostgresAuthRepository. */
export class MemoryAuthRepository implements AuthRepository {
  readonly logins = new Map<string, LoginTransaction>()
  readonly sessions = new Map<string, Session>()
  readonly accounts = new Map<string, Account>()
  readonly challenges = new Map<string, WalletChallenge>()
  readonly walletOwners = new Map<string, string>()
  readonly suspended = new Set<string>()
  constructor(readonly now = () => Date.now()) {}
  async saveLogin(login: LoginTransaction) {
    this.logins.set(login.stateHash, login)
  }
  async consumeLogin(state: string, browser: string) {
    const found = this.logins.get(state)
    if (!found || found.browserHash !== browser || found.expiresAt.getTime() <= this.now())
      return null
    this.logins.delete(state)
    return found
  }
  async createSession(identity: Identity, input: SessionInput, previousTokenHash?: string) {
    const identityKey = JSON.stringify([identity.issuer, identity.subject])
    let account = this.accounts.get(identityKey)
    if (!account) {
      account = {
        id: randomUUID(),
        email: identity.email ?? null,
        displayName: identity.displayName ?? null,
        roles: ['recipient'],
        organizations: [],
        wallets: [],
      }
      this.accounts.set(identityKey, account)
    }
    if (this.suspended.has(account.id)) throw new Error('ACCOUNT_UNAVAILABLE')
    if (previousTokenHash) {
      const previous = this.sessions.get(previousTokenHash)
      if (previous) await this.logout(previous.id)
    }
    this.sessions.set(input.tokenHash, {
      id: randomUUID(),
      userId: account.id,
      tokenHash: input.tokenHash,
      csrfToken: input.csrfToken,
      expiresAt: new Date(this.now() + input.idleSeconds * 1000),
      absoluteExpiresAt: new Date(this.now() + input.absoluteSeconds * 1000),
      account,
    })
  }
  async session(hash: string) {
    const session = this.sessions.get(hash)
    return session &&
      !this.suspended.has(session.userId) &&
      session.expiresAt.getTime() > this.now() &&
      session.absoluteExpiresAt.getTime() > this.now()
      ? session
      : null
  }
  async refresh(hash: string, input: SessionInput) {
    const session = await this.session(hash)
    if (!session || !this.sessions.delete(hash)) return false
    session.tokenHash = input.tokenHash
    session.csrfToken = input.csrfToken
    session.expiresAt = new Date(
      Math.min(session.absoluteExpiresAt.getTime(), this.now() + input.idleSeconds * 1000),
    )
    this.sessions.set(input.tokenHash, session)
    return true
  }
  async logout(sessionId: string) {
    const session = [...this.sessions.values()].find((value) => value.id === sessionId)
    if (session) this.sessions.delete(session.tokenHash)
    if (session)
      for (const [id, challenge] of this.challenges)
        if (challenge.sessionId === session.id) this.challenges.delete(id)
  }
  async saveChallenge(hash: string, challenge: WalletChallenge) {
    const session = await this.session(hash)
    if (!session) return false
    this.challenges.set(challenge.id, { ...challenge, sessionId: session.id })
    return true
  }
  async challenge(hash: string, id: string) {
    const session = await this.session(hash),
      challenge = this.challenges.get(id)
    return session &&
      challenge?.sessionId === session.id &&
      challenge.expiresAt.getTime() > this.now()
      ? challenge
      : null
  }
  async linkWallet(hash: string, id: string) {
    const session = await this.session(hash),
      challenge = await this.challenge(hash, id)
    if (!session || !challenge || !this.challenges.delete(id)) return false
    const key = `${challenge.networkId}:${challenge.address}`,
      owner = this.walletOwners.get(key)
    if (owner && owner !== session.userId) return false
    this.walletOwners.set(key, session.userId)
    if (
      !session.account.wallets.some(
        (w) => w.address === challenge.address && w.networkId === challenge.networkId,
      )
    )
      session.account.wallets.push({
        id: randomUUID(),
        address: challenge.address,
        networkId: challenge.networkId,
        verifiedAt: new Date(this.now()).toISOString(),
      })
    return true
  }
  async unlinkWallet(hash: string, id: string) {
    const session = await this.session(hash)
    if (!session) return false
    const i = session.account.wallets.findIndex((w) => w.id === id)
    if (i < 0) return false
    session.account.wallets.splice(i, 1)
    return true
  }
}
