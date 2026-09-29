import type { DatabaseClient } from '../../lib/db/index.js'
import type { Identity } from './oidc'
import type {
  Account,
  AuthRepository,
  LoginTransaction,
  Session,
  SessionInput,
  WalletChallenge,
} from './types'

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly client: DatabaseClient) {}

  async saveLogin(login: LoginTransaction): Promise<void> {
    const sql = this.client.sql
    await sql`DELETE FROM app_auth_transactions WHERE expires_at <= statement_timestamp()`
    await sql`INSERT INTO app_auth_transactions (state_hash, browser_hash, nonce, code_verifier, return_to, expires_at)
      VALUES (${login.stateHash}, ${login.browserHash}, ${login.nonce}, ${login.codeVerifier}, ${login.returnTo}, ${login.expiresAt.toISOString()})`
  }

  async consumeLogin(stateHash: string, browserHash: string): Promise<LoginTransaction | null> {
    const rows = await this.client.sql`DELETE FROM app_auth_transactions
      WHERE state_hash = ${stateHash} AND browser_hash = ${browserHash} AND expires_at > statement_timestamp()
      RETURNING state_hash, browser_hash, nonce, code_verifier, return_to, expires_at`
    const row = rows[0]
    return row
      ? {
          stateHash: row.state_hash,
          browserHash: row.browser_hash,
          nonce: row.nonce,
          codeVerifier: row.code_verifier,
          returnTo: row.return_to,
          expiresAt: new Date(row.expires_at),
        }
      : null
  }

  async createSession(
    identity: Identity,
    input: SessionInput,
    previousTokenHash?: string,
  ): Promise<void> {
    await this.client.sql.begin(async (sql) => {
      // Identity equality never relies on an email address or a provider role claim.
      const [user] =
        await sql`INSERT INTO app_users (identity_issuer, identity_subject, email, email_verified_at, display_name)
        VALUES (${identity.issuer}, ${identity.subject}, ${identity.email ?? null}, ${identity.email && identity.emailVerified ? new Date().toISOString() : null}, ${identity.displayName ?? null})
        ON CONFLICT (identity_issuer, identity_subject) DO UPDATE SET email = EXCLUDED.email,
          email_verified_at = EXCLUDED.email_verified_at, display_name = EXCLUDED.display_name
        WHERE app_users.status = 'active' RETURNING id`
      if (!user) throw new Error('AUTH_ACCOUNT_UNAVAILABLE')
      // The database grants INSERT(user_id) only; its default can grant recipient, never admin.
      await sql`INSERT INTO app_user_roles (user_id) VALUES (${user.id}) ON CONFLICT DO NOTHING`
      if (previousTokenHash)
        await sql`DELETE FROM app_sessions WHERE token_hash = ${previousTokenHash}`
      await sql`DELETE FROM app_sessions WHERE expires_at <= statement_timestamp() OR absolute_expires_at <= statement_timestamp()`
      await sql`INSERT INTO app_sessions (user_id, token_hash, csrf_token, expires_at, absolute_expires_at)
        VALUES (${user.id}, ${input.tokenHash}, ${input.csrfToken}, statement_timestamp() + ${input.idleSeconds} * interval '1 second', statement_timestamp() + ${input.absoluteSeconds} * interval '1 second')`
    })
  }

  async session(tokenHash: string): Promise<Session | null> {
    const sql = this.client.sql
    const [row] =
      await sql`SELECT s.id, s.token_hash, s.user_id, s.csrf_token, s.expires_at, s.absolute_expires_at, u.email, u.display_name
      FROM app_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash} AND s.expires_at > statement_timestamp()
        AND s.absolute_expires_at > statement_timestamp() AND u.status = 'active'`
    if (!row) return null
    const roles =
      await sql`SELECT role FROM app_user_roles WHERE user_id = ${row.user_id} AND revoked_at IS NULL`
    const orgs = await sql`SELECT o.id, o.name, a.role FROM app_organizations o
      JOIN app_organization_applications a ON a.organization_id = o.id
      WHERE o.responsible_user_id = ${row.user_id} AND o.status = 'active' AND a.status = 'approved'`
    const wallets =
      await sql`SELECT id, address, network_id, verified_at FROM app_wallets WHERE user_id = ${row.user_id} AND revoked_at IS NULL ORDER BY verified_at, id`
    const organizations: Account['organizations'] = []
    for (const org of orgs) {
      let found = organizations.find((item) => item.id === org.id)
      if (!found) {
        found = { id: org.id, name: org.name, roles: [] }
        organizations.push(found)
      }
      found.roles.push(org.role)
    }
    return {
      id: row.id,
      tokenHash: row.token_hash,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      expiresAt: new Date(row.expires_at),
      absoluteExpiresAt: new Date(row.absolute_expires_at),
      account: {
        id: row.user_id,
        email: row.email,
        displayName: row.display_name,
        roles: roles.map((r) => r.role),
        organizations,
        wallets: wallets.map((w) => ({
          id: w.id,
          address: w.address,
          networkId: Number(w.network_id),
          verifiedAt: new Date(w.verified_at).toISOString(),
        })),
      },
    }
  }

  async refresh(tokenHash: string, input: SessionInput): Promise<boolean> {
    const rows = await this.client
      .sql`UPDATE app_sessions s SET token_hash = ${input.tokenHash}, csrf_token = ${input.csrfToken},
      expires_at = LEAST(s.absolute_expires_at, statement_timestamp() + ${input.idleSeconds} * interval '1 second')
      FROM app_users u WHERE s.token_hash = ${tokenHash} AND u.id = s.user_id AND u.status = 'active'
      AND s.expires_at > statement_timestamp() AND s.absolute_expires_at > statement_timestamp() RETURNING s.id`
    return rows.length === 1
  }

  async logout(sessionId: string): Promise<void> {
    await this.client.sql`DELETE FROM app_sessions WHERE id = ${sessionId}`
  }

  async saveChallenge(tokenHash: string, challenge: WalletChallenge): Promise<boolean> {
    const rows = await this.client
      .sql`INSERT INTO app_wallet_challenges (id, session_id, network_id, address, message, expires_at)
      SELECT ${challenge.id}, s.id, ${challenge.networkId}, ${challenge.address}, ${challenge.message}, ${challenge.expiresAt.toISOString()}
      FROM app_sessions s JOIN app_users u ON u.id = s.user_id WHERE s.token_hash = ${tokenHash}
      AND u.status = 'active' AND s.expires_at > statement_timestamp() AND s.absolute_expires_at > statement_timestamp()
      RETURNING id`
    return rows.length === 1
  }

  async challenge(tokenHash: string, id: string): Promise<WalletChallenge | null> {
    const [row] = await this.client.sql`SELECT c.* FROM app_wallet_challenges c
      JOIN app_sessions s ON c.session_id = s.id JOIN app_users u ON u.id = s.user_id
      WHERE c.id = ${id} AND s.token_hash = ${tokenHash} AND u.status = 'active'
      AND c.expires_at > statement_timestamp() AND s.expires_at > statement_timestamp()
      AND s.absolute_expires_at > statement_timestamp()`
    return row
      ? {
          id: row.id,
          sessionId: row.session_id,
          networkId: Number(row.network_id),
          address: row.address,
          message: row.message,
          expiresAt: new Date(row.expires_at),
        }
      : null
  }

  async linkWallet(tokenHash: string, id: string): Promise<boolean> {
    return this.client.sql.begin(async (sql) => {
      // DELETE RETURNING makes a concurrent or replayed proof unable to link twice.
      const [challenge] =
        await sql`DELETE FROM app_wallet_challenges c USING app_sessions s, app_users u
        WHERE c.id = ${id} AND c.session_id = s.id AND s.token_hash = ${tokenHash}
        AND u.id = s.user_id AND u.status = 'active' AND c.expires_at > statement_timestamp()
        AND s.expires_at > statement_timestamp() AND s.absolute_expires_at > statement_timestamp()
        RETURNING c.address, c.network_id, s.user_id`
      if (!challenge) return false
      const rows = await sql`INSERT INTO app_wallets (user_id, network_id, address, verified_at)
        VALUES (${challenge.user_id}, ${challenge.network_id}, ${challenge.address}, statement_timestamp())
        ON CONFLICT (network_id, address) DO UPDATE SET verified_at = EXCLUDED.verified_at, revoked_at = NULL
        WHERE app_wallets.user_id = EXCLUDED.user_id RETURNING id`
      return rows.length === 1
    })
  }

  async unlinkWallet(tokenHash: string, walletId: string): Promise<boolean> {
    const rows = await this.client.sql`UPDATE app_wallets w SET revoked_at = statement_timestamp()
      FROM app_sessions s, app_users u WHERE s.token_hash = ${tokenHash} AND u.id = s.user_id
      AND u.status = 'active' AND s.expires_at > statement_timestamp() AND s.absolute_expires_at > statement_timestamp()
      AND w.id = ${walletId} AND w.user_id = s.user_id AND w.revoked_at IS NULL RETURNING w.id`
    return rows.length === 1
  }
}
