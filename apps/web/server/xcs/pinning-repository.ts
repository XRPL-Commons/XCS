import {
  demoPins,
  pinChallenges,
  runSerializableTransaction,
  type XcsDatabase,
} from '@xcs-protocol/db'
import { and, count, eq, gt, gte, inArray, isNull, lte, ne, notExists } from 'drizzle-orm'

import { PinningError } from './pinning.js'
import type { PinningRepository } from './types.js'

export class PostgresPinningRepository implements PinningRepository {
  constructor(private readonly db: XcsDatabase) {}

  async createChallenge(input: Parameters<PinningRepository['createChallenge']>[0]) {
    const [row] = await this.db.insert(pinChallenges).values(input).returning()
    if (row === undefined) throw new Error('Challenge insert returned no row')
    return row
  }

  async getChallenge(challengeId: string) {
    const [row] = await this.db
      .select()
      .from(pinChallenges)
      .where(eq(pinChallenges.challengeId, challengeId))
      .limit(1)
    return row
  }

  async reservePin(input: Parameters<PinningRepository['reservePin']>[0]) {
    return runSerializableTransaction(this.db, async (tx) => {
      const [challenge] = await tx
        .select()
        .from(pinChallenges)
        .where(eq(pinChallenges.challengeId, input.challengeId))
        .for('update')
        .limit(1)
      if (challenge === undefined) throw new PinningError('CHALLENGE_NOT_FOUND', 404)
      if (challenge.usedAt !== null) throw new PinningError('CHALLENGE_USED', 409)
      if (challenge.expiresAt <= input.now) throw new PinningError('CHALLENGE_EXPIRED', 410)
      if (
        challenge.profileId !== input.profileId ||
        challenge.wallet !== input.wallet ||
        challenge.requesterIpHash !== input.requesterIpHash
      ) {
        throw new PinningError('CHALLENGE_MISMATCH', 403)
      }

      const since = new Date(input.now.getTime() - 24 * 60 * 60 * 1_000)
      const [walletQuota] = await tx
        .select({ value: count() })
        .from(demoPins)
        .where(and(eq(demoPins.wallet, input.wallet), gte(demoPins.createdAt, since)))
      const [ipQuota] = await tx
        .select({ value: count() })
        .from(demoPins)
        .where(
          and(eq(demoPins.requesterIpHash, input.requesterIpHash), gte(demoPins.createdAt, since)),
        )
      if ((walletQuota?.value ?? 0) >= input.dailyLimit) {
        throw new PinningError('WALLET_QUOTA_EXCEEDED', 429)
      }
      if ((ipQuota?.value ?? 0) >= input.dailyLimit) {
        throw new PinningError('IP_QUOTA_EXCEEDED', 429)
      }

      await tx
        .update(pinChallenges)
        .set({ usedAt: input.now })
        .where(and(eq(pinChallenges.challengeId, input.challengeId), isNull(pinChallenges.usedAt)))
      const [pin] = await tx
        .insert(demoPins)
        .values({
          pinId: input.pinId,
          challengeId: input.challengeId,
          profileId: input.profileId,
          wallet: input.wallet,
          requesterIpHash: input.requesterIpHash,
          cid: input.cid,
          byteLength: input.byteLength,
          status: 'pending',
          expiresAt: input.expiresAt,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      if (pin === undefined) throw new Error('Pin reservation returned no row')
      return pin
    })
  }

  async markPinned(pinId: string, now: Date): Promise<void> {
    await this.db
      .update(demoPins)
      .set({ status: 'pinned', updatedAt: now })
      .where(and(eq(demoPins.pinId, pinId), eq(demoPins.status, 'pending')))
  }

  async markFailed(pinId: string, failureCode: string, now: Date): Promise<void> {
    await this.db
      .update(demoPins)
      .set({ status: 'failed', failureCode, updatedAt: now })
      .where(and(eq(demoPins.pinId, pinId), eq(demoPins.status, 'pending')))
  }

  findExpiredPins(now: Date, limit: number) {
    return this.db
      .select()
      .from(demoPins)
      .where(and(inArray(demoPins.status, ['pending', 'pinned']), lte(demoPins.expiresAt, now)))
      .orderBy(demoPins.expiresAt)
      .limit(limit)
  }

  async hasOtherActivePin(cid: string, excludingPinId: string, now: Date): Promise<boolean> {
    const [row] = await this.db
      .select({ pinId: demoPins.pinId })
      .from(demoPins)
      .where(
        and(
          eq(demoPins.cid, cid),
          ne(demoPins.pinId, excludingPinId),
          inArray(demoPins.status, ['pending', 'pinned']),
          gt(demoPins.expiresAt, now),
        ),
      )
      .limit(1)
    return row !== undefined
  }

  async markUnpinned(pinId: string, now: Date): Promise<void> {
    await this.db
      .update(demoPins)
      .set({ status: 'unpinned', unpinnedAt: now, updatedAt: now })
      .where(and(eq(demoPins.pinId, pinId), inArray(demoPins.status, ['pending', 'pinned'])))
  }

  async deleteExpiredUnreferencedChallenges(now: Date, limit: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ challengeId: pinChallenges.challengeId })
        .from(pinChallenges)
        .where(
          and(
            lte(pinChallenges.expiresAt, now),
            notExists(
              tx
                .select({ pinId: demoPins.pinId })
                .from(demoPins)
                .where(eq(demoPins.challengeId, pinChallenges.challengeId)),
            ),
          ),
        )
        .orderBy(pinChallenges.expiresAt)
        .limit(limit)
        .for('update', { skipLocked: true })
      if (candidates.length === 0) return 0

      const deleted = await tx
        .delete(pinChallenges)
        .where(
          and(
            inArray(
              pinChallenges.challengeId,
              candidates.map((entry) => entry.challengeId),
            ),
            notExists(
              tx
                .select({ pinId: demoPins.pinId })
                .from(demoPins)
                .where(eq(demoPins.challengeId, pinChallenges.challengeId)),
            ),
          ),
        )
        .returning({ challengeId: pinChallenges.challengeId })
      return deleted.length
    })
  }
}
