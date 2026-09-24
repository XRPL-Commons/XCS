// Copied from packages/db/src/app/invitations.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { and, eq, exists, gt, isNull, sql } from 'drizzle-orm'

import type { XcsDatabase } from '../client.js'
import { appInvites, appUsers } from '#db/schema/app'
import { hashAppToken } from './tokens.js'

/** Call only from an authenticated mutation, with userId supplied by the server's session. */
export async function claimInvitation(db: XcsDatabase, input: { token: string; userId: string }) {
  const tokenHash = hashAppToken(input.token)
  if (tokenHash === null) return null

  // One conditional UPDATE is the claim boundary. Statement time, not transaction start,
  // prevents a caller's long-running transaction from extending the invitation's lifetime.
  const [claimed] = await db
    .update(appInvites)
    .set({ claimedBy: input.userId, claimedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(appInvites.tokenHash, tokenHash),
        isNull(appInvites.claimedAt),
        isNull(appInvites.revokedAt),
        gt(appInvites.expiresAt, sql`statement_timestamp()`),
        exists(
          db
            .select({ id: appUsers.id })
            .from(appUsers)
            .where(and(eq(appUsers.id, input.userId), eq(appUsers.status, 'active'))),
        ),
      ),
    )
    .returning({
      id: appInvites.id,
      organizationId: appInvites.organizationId,
      profileId: appInvites.profileId,
      schemaUid: appInvites.schemaUid,
      claimedBy: appInvites.claimedBy,
      claimedAt: appInvites.claimedAt,
    })
  return claimed ?? null
}
