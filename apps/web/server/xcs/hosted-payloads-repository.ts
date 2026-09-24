import type { DatabaseClient } from '../lib/db/index.js'
import { HostedPayloadError, type HostedPayloadRepository } from './hosted-payloads.js'
import {
  hostedPayloadPublications,
  hostedPayloads,
  runSerializableTransaction,
} from '../lib/db/index.js'
import { and, count, eq, gte, or } from 'drizzle-orm'
export class PostgresHostedPayloadRepository implements HostedPayloadRepository {
  constructor(private readonly db: DatabaseClient['db']) {}
  async get(locator: string) {
    const [row] = await this.db
      .select({
        locator: hostedPayloads.locator,
        digestHex: hostedPayloads.digestHex,
        content: hostedPayloads.content,
      })
      .from(hostedPayloads)
      .where(eq(hostedPayloads.locator, locator))
      .limit(1)
    return row
  }
  async publish(input: Parameters<HostedPayloadRepository['publish']>[0]) {
    return runSerializableTransaction(this.db, async (tx) => {
      const [existingPublication] = await tx
        .select()
        .from(hostedPayloadPublications)
        .where(eq(hostedPayloadPublications.transactionHash, input.transactionHash))
        .limit(1)
      if (existingPublication !== void 0) {
        if (
          existingPublication.locator !== input.locator ||
          existingPublication.profileId !== input.profileId ||
          existingPublication.issuer !== input.issuer ||
          existingPublication.subject !== input.subject ||
          existingPublication.schemaUid !== input.schemaUid
        ) {
          throw new HostedPayloadError('PAYLOAD_PUBLICATION_CONFLICT', 409)
        }
        const [existingPayload] = await tx
          .select({
            locator: hostedPayloads.locator,
            digestHex: hostedPayloads.digestHex,
            content: hostedPayloads.content,
          })
          .from(hostedPayloads)
          .where(eq(hostedPayloads.locator, input.locator))
          .limit(1)
        if (
          existingPayload === void 0 ||
          existingPayload.digestHex !== input.digestHex ||
          existingPayload.content !== input.content
        ) {
          throw new HostedPayloadError('PAYLOAD_STORAGE_INTEGRITY_ERROR', 500)
        }
        return existingPayload
      }
      const since = new Date(input.now.getTime() - 24 * 60 * 60 * 1e3)
      const [quota] = await tx
        .select({ value: count() })
        .from(hostedPayloadPublications)
        .where(
          and(
            gte(hostedPayloadPublications.createdAt, since),
            or(
              eq(hostedPayloadPublications.issuer, input.issuer),
              eq(hostedPayloadPublications.requesterIpHash, input.requesterIpHash),
            ),
          ),
        )
      if ((quota?.value ?? 0) >= input.dailyLimit) {
        throw new HostedPayloadError('PAYLOAD_PUBLICATION_QUOTA_EXCEEDED', 429)
      }
      await tx
        .insert(hostedPayloads)
        .values({
          locator: input.locator,
          digestHex: input.digestHex,
          content: input.content,
          createdAt: input.now,
        })
        .onConflictDoNothing()
      const [payload] = await tx
        .select({
          locator: hostedPayloads.locator,
          digestHex: hostedPayloads.digestHex,
          content: hostedPayloads.content,
        })
        .from(hostedPayloads)
        .where(eq(hostedPayloads.locator, input.locator))
        .limit(1)
      if (payload === void 0) throw new HostedPayloadError('PAYLOAD_STORAGE_UNAVAILABLE', 503)
      if (payload.digestHex !== input.digestHex || payload.content !== input.content) {
        throw new HostedPayloadError('PAYLOAD_LOCATOR_COLLISION', 409)
      }
      await tx.insert(hostedPayloadPublications).values({
        transactionHash: input.transactionHash,
        locator: input.locator,
        profileId: input.profileId,
        issuer: input.issuer,
        subject: input.subject,
        schemaUid: input.schemaUid,
        requesterIpHash: input.requesterIpHash,
        createdAt: input.now,
      })
      return payload
    })
  }
}
