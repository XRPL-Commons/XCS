import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRecipientDatabase } from './helpers/recipientDatabase'
import { IssuerRepository } from '../server/xcs/issuer/repository'
import { issuerAdmission } from '../server/xcs/presentations/admission'

const url = process.env.XCS_TEST_DATABASE_URL?.trim()
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !url)
  throw new Error('XCS_TEST_DATABASE_URL is required')

describe.skipIf(!url)(
  'issuer admission and recipient readiness through restricted PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createRecipientDatabase>>
    let issuer: IssuerRepository
    beforeAll(async () => {
      fixture = await createRecipientDatabase(url!)
      issuer = new IssuerRepository(fixture.portal, {
        origin: 'https://xcs.test',
        inviteDays: 7,
        documents: {
          write: async () => {
            throw new Error('UNEXPECTED_DOCUMENT_WRITE')
          },
          remove: async () => {},
        },
        notify: async () => {
          throw new Error('UNEXPECTED_DELIVERY')
        },
      })
    }, 30000)
    afterAll(async () => {
      await fixture?.close()
    })

    it('reports current issuer admission separately from verifier approval and historical claims', async () => {
      const approved = await issuerAdmission(fixture.portal.db, fixture.issuerOrg)
      expect(approved.status).toBe('approved')
      expect(Date.parse(approved.checkedAt)).toBeGreaterThan(0)
      expect(approved.reviewedAt).not.toBeNull()
      expect(await issuerAdmission(fixture.portal.db, fixture.verifierOrg)).toMatchObject({
        status: 'unknown',
      })
      await fixture.db
        .sql`UPDATE app_organization_applications SET status='suspended',review_reason='Synthetic pause' WHERE organization_id=${fixture.issuerOrg} AND role='issuer'`
      expect(await issuerAdmission(fixture.portal.db, fixture.issuerOrg)).toMatchObject({
        status: 'suspended',
      })
      await fixture.db
        .sql`UPDATE app_organization_applications SET status='approved',review_reason=NULL WHERE organization_id=${fixture.issuerOrg} AND role='issuer'`
      await fixture.db
        .sql`UPDATE app_organizations SET status='closed' WHERE id=${fixture.issuerOrg}`
      expect(await issuerAdmission(fixture.portal.db, fixture.issuerOrg)).toMatchObject({
        status: 'not_approved',
      })
      await fixture.db
        .sql`UPDATE app_organizations SET status='active' WHERE id=${fixture.issuerOrg}`
    })

    it('distinguishes invitation, claimed without wallet, ready, and unavailable states without private claims', async () => {
      const id = randomUUID()
      await fixture.db
        .sql`INSERT INTO app_invites(id,organization_id,profile_id,schema_uid,token_hash,created_by,expires_at,delivery_email)
      VALUES (${id},${fixture.issuerOrg},${fixture.profileId},${fixture.schemaUid},${randomBytes(32).toString('hex')},${fixture.sessions.issuer.userId},statement_timestamp()+interval '7 days','delivery@example.invalid')`
      const current = async () =>
        (await issuer.workspace(fixture.sessions.issuer)).invites.find((row) => row.id === id)!
      expect(await current()).toMatchObject({
        recipientStatus: 'invited',
        recipientWalletVerifiedAt: null,
      })
      await fixture.db
        .sql`UPDATE app_invites SET claimed_by=${fixture.sessions.recipient.userId},claimed_at=statement_timestamp() WHERE id=${id}`
      await fixture.db
        .sql`UPDATE app_wallets SET revoked_at=statement_timestamp() WHERE user_id=${fixture.sessions.recipient.userId}`
      expect(await current()).toMatchObject({
        recipientStatus: 'wallet_required',
        recipientWalletVerifiedAt: null,
      })
      await fixture.db
        .sql`UPDATE app_wallets SET revoked_at=NULL WHERE user_id=${fixture.sessions.recipient.userId}`
      const ready = await current()
      expect(ready.recipientStatus).toBe('ready')
      expect(Date.parse(ready.recipientWalletVerifiedAt!)).toBeGreaterThan(0)
      const context = await issuer.issuance(fixture.sessions.issuer, id)
      expect(context.invite.deliveryEmail).toBe('delivery@example.invalid')
      expect(context.recipient.wallets).toContainEqual(
        expect.objectContaining({
          address: fixture.subjectAddress,
          networkId: 1,
          verifiedAt: expect.any(String),
        }),
      )
      await fixture.db.sql`UPDATE app_invites SET revoked_at=statement_timestamp() WHERE id=${id}`
      expect((await current()).recipientStatus).toBe('unavailable')
      expect(JSON.stringify(await current())).not.toContain('canonical_payload')
      await expect(
        issuer.workspace(fixture.sessions.other, fixture.issuerOrg),
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('identifies already issued invitations instead of offering another issuance', async () => {
      const row = (await issuer.workspace(fixture.sessions.issuer)).invites.find(
        (row) => row.id === fixture.inviteId,
      )
      expect(row?.recipientStatus).toBe('issued')
    })
  },
)
