import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Wallet, unixTimeToRippleTime } from 'xrpl'
import { sign } from 'ripple-keypairs'
import { createAppToken } from '../server/lib/db/index.js'
import { createRecipientDatabase, signPresentationInput } from './helpers/recipientDatabase'
import { RecipientRepository } from '../server/xcs/recipient/repository'
import { PresentationRepository } from '../server/xcs/presentations/repository'
import { StaticTrustPolicy } from '../server/xcs/verification'
import type { Session } from '../server/xcs/auth/types'
import type {
  CreatedPresentation,
  PresentationChallengeInput,
  CreatePresentationInput,
} from '../server/xcs/recipient/types'

const url = process.env.XCS_TEST_DATABASE_URL?.trim()
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !url)
  throw new Error('XCS_TEST_DATABASE_URL is required')

describe.skipIf(!url)('recipient and presentation actual PostgreSQL authorization', () => {
  let f: Awaited<ReturnType<typeof createRecipientDatabase>>,
    recipient: RecipientRepository,
    presentations: PresentationRepository
  let full: CreatedPresentation, publicLink: CreatedPresentation
  const createPresentation = async (session: Session, input: PresentationChallengeInput) =>
    recipient.createPresentation(
      session,
      await signPresentationInput(recipient, session, input, f.subjectWallet),
    )
  beforeAll(async () => {
    f = await createRecipientDatabase(url!)
    recipient = new RecipientRepository(f.portal, 'https://xcs.test')
    presentations = new PresentationRepository(f.portal)
    full = await createPresentation(f.sessions.recipient, {
      profileId: f.profileId,
      generationId: f.generationId,
      scope: 'full',
      verifierOrganizationId: f.verifierOrg,
    })
    publicLink = await createPresentation(f.sessions.recipient, {
      profileId: f.profileId,
      generationId: f.generationId,
      scope: 'public',
    })
  }, 30000)
  afterAll(async () => {
    await f?.close()
  })

  it('lists only the recipient records and never includes payloads, delivery emails, or tokens in metadata', async () => {
    const workspace = await recipient.workspace(f.sessions.recipient)
    expect(workspace.credentials).toHaveLength(1)
    expect(workspace.credentials[0]!.status.state).toBe('active')
    expect(workspace.invitations).toHaveLength(1)
    expect(workspace.notifications.map((notice) => notice.kind)).toEqual(['issued'])
    for (const forbidden of [
      'Private synthetic claim',
      'canonicalPayload',
      'tokenHash',
      'deliveryEmail',
    ])
      expect(JSON.stringify(workspace)).not.toContain(forbidden)
    expect((await recipient.workspace(f.sessions.other)).credentials).toEqual([])
    await expect(
      recipient.credential(f.sessions.other, f.profileId, f.generationId),
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      recipient.payload(f.sessions.admin, f.profileId, f.generationId),
    ).rejects.toMatchObject({ statusCode: 404 })
    const detail = await recipient.credential(f.sessions.recipient, f.profileId, f.generationId)
    expect(detail.disclosure).toEqual({ publicFields: ['/course'], fields: ['course', 'secret'] })
    expect(detail.events).toHaveLength(2)
    expect(
      (await recipient.payload(f.sessions.recipient, f.profileId, f.generationId)).claims.secret,
    ).toBe('Private synthetic claim')
  })
  it('stores hashes only and enforces the full audience, public scope and revoked-link boundary', async () => {
    const [stored] = await f.db.sql`SELECT token_hash FROM app_presentations WHERE id=${full.id}`
    expect(stored!.token_hash).not.toBe(full.token)
    expect(stored!.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(full.url).toBe(`https://xcs.test/presentations#${full.token}`)
    const listed = await recipient.presentations(f.sessions.recipient)
    expect(JSON.stringify(listed)).not.toContain(full.token)
    expect(JSON.stringify(listed)).not.toContain('tokenHash')
    const result = await presentations.resolve(f.sessions.verifier, full.token)
    expect(result.scope).toBe('full')
    expect(result.claims.secret).toBe('Private synthetic claim')
    expect(result.verification).toMatchObject({
      onChain: 'active',
      schema: 'valid',
      payload: 'valid',
      issuerTrust: 'unknown',
      generationId: f.generationId,
    })
    for (const session of [
      null,
      f.sessions.other,
      f.sessions.admin,
      f.sessions.recipient,
      f.sessions.issuer,
    ]) {
      const reduced = await presentations.resolve(session, full.token)
      expect(reduced.scope).toBe('public')
      expect(reduced.claims).toEqual({ course: 'Public course' })
      expect(reduced.requiresAuthorization).toBe(true)
      expect(reduced.verification.payload).toBe('not_checked')
    }
    const reduced = await presentations.resolve(f.sessions.recipient, publicLink.token)
    expect(reduced.claims).toEqual({ course: 'Public course' })
    expect(reduced.scope).toBe('public')
    expect(reduced.requiresAuthorization).toBe(false)
    await expect(
      recipient.revokePresentation(f.sessions.other, publicLink.id),
    ).rejects.toMatchObject({ statusCode: 404 })
    const disposable = await createPresentation(f.sessions.recipient, {
      profileId: f.profileId,
      generationId: f.generationId,
      scope: 'public',
    })
    await recipient.revokePresentation(f.sessions.recipient, disposable.id)
    await expect(presentations.resolve(null, disposable.token)).rejects.toMatchObject({
      statusCode: 404,
      code: 'PRESENTATION_UNAVAILABLE',
    })
    await expect(presentations.resolve(f.sessions.verifier, 'x'.repeat(43))).rejects.toMatchObject({
      statusCode: 404,
      code: 'PRESENTATION_UNAVAILABLE',
    })
  })
  it('keeps already-public credential claims public even when the private-field selector is empty', async () => {
    await f.db
      .sql`UPDATE app_credential_metadata SET visibility='public',public_fields='[]'::jsonb WHERE profile_id=${f.profileId}`
    try {
      const alreadyPublic = await createPresentation(f.sessions.recipient, {
        profileId: f.profileId,
        generationId: f.generationId,
        scope: 'public',
      })
      const result = await presentations.resolve(null, alreadyPublic.token)
      await recipient.revokePresentation(f.sessions.recipient, alreadyPublic.id)
      expect(result.scope).toBe('public')
      expect(result.claims).toEqual({ course: 'Public course', secret: 'Private synthetic claim' })
      expect(result).not.toHaveProperty('canonicalPayload')
    } finally {
      await f.db
        .sql`UPDATE app_credential_metadata SET visibility='private',public_fields='["/course"]'::jsonb WHERE profile_id=${f.profileId}`
    }
  })
  it('rechecks current verifier approval and account/session state without an issuer allowlist', async () => {
    await f.db
      .sql`UPDATE app_organization_applications SET status='suspended',review_reason='Synthetic suspension' WHERE organization_id=${f.verifierOrg} AND role='verifier'`
    try {
      const result = await presentations.resolve(f.sessions.verifier, full.token)
      expect(result.scope).toBe('public')
      expect(result.claims).not.toHaveProperty('secret')
      await expect(
        createPresentation(f.sessions.recipient, {
          profileId: f.profileId,
          generationId: f.generationId,
          scope: 'full',
          verifierOrganizationId: f.verifierOrg,
        }),
      ).rejects.toMatchObject({ code: 'RECIPIENT_VERIFIER_UNAVAILABLE' })
    } finally {
      await f.db
        .sql`UPDATE app_organization_applications SET status='approved',review_reason=NULL WHERE organization_id=${f.verifierOrg} AND role='verifier'`
    }
    expect((await presentations.resolve(f.sessions.verifier, full.token)).scope).toBe('full')
    await f.db.sql`UPDATE app_users SET status='suspended' WHERE id=${f.sessions.verifier.userId}`
    try {
      await expect(presentations.resolve(f.sessions.verifier, full.token)).rejects.toMatchObject({
        statusCode: 401,
      })
    } finally {
      await f.db.sql`UPDATE app_users SET status='active' WHERE id=${f.sessions.verifier.userId}`
    }
    await f.db
      .sql`UPDATE app_sessions SET token_hash=${'0'.repeat(64)} WHERE id=${f.sessions.recipient.id}`
    try {
      await expect(recipient.workspace(f.sessions.recipient)).rejects.toMatchObject({
        statusCode: 401,
      })
    } finally {
      await f.db
        .sql`UPDATE app_sessions SET token_hash=${f.sessions.recipient.tokenHash} WHERE id=${f.sessions.recipient.id}`
    }
  })
  it('uses configured trust and ledger freshness, failing closed before private disclosure', async () => {
    const strict = new PresentationRepository(f.portal, undefined, {
      maxLedgerAgeSeconds: 30,
      trustPolicy: new StaticTrustPolicy({ untrusted: [f.issuerAddress] }),
    })
    expect((await strict.resolve(f.sessions.verifier, full.token)).verification.issuerTrust).toBe(
      'untrusted',
    )
    await f.db
      .sql`UPDATE ledger_checkpoints SET close_time=${unixTimeToRippleTime(Date.now() - 60000)} WHERE profile_id=${f.profileId}`
    try {
      await expect(strict.resolve(f.sessions.verifier, full.token)).rejects.toMatchObject({
        code: 'INDEXER_STALE',
      })
      expect(
        (await presentations.resolve(f.sessions.verifier, full.token)).verification.onChain,
      ).toBe('active')
    } finally {
      await f.db
        .sql`UPDATE ledger_checkpoints SET close_time=${unixTimeToRippleTime(Date.now())} WHERE profile_id=${f.profileId}`
    }
    await f.db.sql`UPDATE indexer_status SET state='catching_up' WHERE profile_id=${f.profileId}`
    try {
      await expect(presentations.resolve(f.sessions.verifier, full.token)).rejects.toMatchObject({
        code: 'INDEXER_NOT_READY',
      })
      expect((await recipient.workspace(f.sessions.recipient)).credentials[0]!.status.state).toBe(
        'unknown',
      )
    } finally {
      await f.db.sql`UPDATE indexer_status SET state='ready' WHERE profile_id=${f.profileId}`
    }
  })
  it('reports corrupt canonical payloads without exposing any claims and rejects inconsistent schema evidence', async () => {
    await f.db
      .sql`UPDATE app_issuer_payloads SET canonical_payload='{"claims":{"secret":"tampered"}}' WHERE id=${f.payloadId}`
    try {
      for (const session of [null, f.sessions.verifier]) {
        const result = await presentations.resolve(session, full.token)
        expect(result.verification.payload).toBe('tampered')
        expect(result.claims).toEqual({})
      }
      await expect(
        recipient.payload(f.sessions.recipient, f.profileId, f.generationId),
      ).rejects.toMatchObject({ code: 'RECIPIENT_PAYLOAD_INVALID' })
    } finally {
      await f.db
        .sql`UPDATE app_issuer_payloads SET canonical_payload=${f.canonical} WHERE id=${f.payloadId}`
    }
    await f.db
      .sql`UPDATE schemas SET name='Wrong projected name' WHERE profile_id=${f.profileId} AND schema_uid=${f.schemaUid}`
    try {
      await expect(presentations.resolve(f.sessions.verifier, full.token)).rejects.toMatchObject({
        code: 'SCHEMA_PROJECTION_INVALID',
      })
    } finally {
      await f.db
        .sql`UPDATE schemas SET name='Synthetic recipient credential' WHERE profile_id=${f.profileId} AND schema_uid=${f.schemaUid}`
    }
  })
  it('requires acceptance for a new presentation and reports credential expiry without inventing a grant TTL', async () => {
    const input = { profileId: f.profileId, generationId: f.generationId, scope: 'public' as const }
    await f.db.sql`UPDATE credential_generations SET accepted=false WHERE profile_id=${f.profileId}`
    try {
      await expect(createPresentation(f.sessions.recipient, input)).rejects.toMatchObject({
        code: 'RECIPIENT_CREDENTIAL_NOT_ACTIVE',
      })
      expect((await presentations.resolve(null, publicLink.token)).verification.onChain).toBe(
        'pending',
      )
    } finally {
      await f.db
        .sql`UPDATE credential_generations SET accepted=true WHERE profile_id=${f.profileId}`
    }
    await f.db
      .sql`UPDATE credential_generations SET expiration=${unixTimeToRippleTime(Date.now() - 60000)} WHERE profile_id=${f.profileId}`
    try {
      await expect(createPresentation(f.sessions.recipient, input)).rejects.toMatchObject({
        code: 'RECIPIENT_CREDENTIAL_NOT_ACTIVE',
      })
      expect(
        (await presentations.resolve(f.sessions.verifier, full.token)).verification.onChain,
      ).toBe('expired')
      expect(
        (await recipient.presentations(f.sessions.recipient)).presentations.find(
          (p) => p.id === full.id,
        )!.revokedAt,
      ).toBe(null)
    } finally {
      await f.db
        .sql`UPDATE credential_generations SET expiration=NULL WHERE profile_id=${f.profileId}`
    }
  })
  it('reconciles only the exact indexed subject action with a linked wallet, without reading rejected payload bytes', async () => {
    expect(
      (
        await recipient.reconcile(
          f.sessions.recipient,
          f.profileId,
          f.generationId,
          f.acceptedHash,
          'accept',
        )
      ).status.accepted,
    ).toBe(true)
    await expect(
      recipient.reconcile(
        f.sessions.recipient,
        f.profileId,
        f.generationId,
        f.acceptedHash,
        'reject',
      ),
    ).rejects.toMatchObject({ code: 'RECIPIENT_ACTION_NOT_VALIDATED' })
    const deletionHash = '3'.repeat(64)
    await f.db
      .sql`INSERT INTO credential_events(profile_id,transaction_hash,node_index,generation_id,ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,schema_uid,accepted,deletion_cause,snapshot) VALUES (${f.profileId},${deletionHash},0,${f.generationId},${'1'.repeat(64)},4,${f.ledgerHash},0,'deleted',${f.issuerAddress},${f.subjectAddress},${f.schemaUid},false,'subject_rejected','{}'::jsonb)`
    await f.db
      .sql`UPDATE credential_generations SET accepted=false,last_ledger_index=4,deleted_ledger_index=4,deletion_cause='subject_rejected' WHERE profile_id=${f.profileId}`
    // A payload read here would fail canonical verification. Rejection succeeds on ledger metadata alone.
    await f.db
      .sql`UPDATE app_issuer_payloads SET canonical_payload='not-json' WHERE id=${f.payloadId}`
    try {
      const result = await recipient.reconcile(
        f.sessions.recipient,
        f.profileId,
        f.generationId,
        deletionHash,
        'reject',
      )
      expect(result.status.deletionCause).toBe('subject_rejected')
      expect(result).not.toHaveProperty('claims')
      await expect(
        recipient.reconcile(
          f.sessions.recipient,
          f.profileId,
          f.generationId,
          deletionHash,
          'remove',
        ),
      ).rejects.toMatchObject({ code: 'RECIPIENT_ACTION_NOT_VALIDATED' })
      await f.db
        .sql`UPDATE credential_events SET deletion_cause='subject_removed',accepted=true WHERE transaction_hash=${deletionHash}`
      await f.db
        .sql`UPDATE credential_generations SET deletion_cause='subject_removed',accepted=true WHERE profile_id=${f.profileId}`
      expect(
        (
          await recipient.reconcile(
            f.sessions.recipient,
            f.profileId,
            f.generationId,
            deletionHash,
            'remove',
          )
        ).status.deletionCause,
      ).toBe('subject_removed')
      await f.db
        .sql`UPDATE app_wallets SET revoked_at=statement_timestamp() WHERE user_id=${f.sessions.recipient.userId}`
      await expect(
        recipient.reconcile(
          f.sessions.recipient,
          f.profileId,
          f.generationId,
          deletionHash,
          'reject',
        ),
      ).rejects.toMatchObject({ code: 'RECIPIENT_WALLET_REQUIRED' })
    } finally {
      await f.db
        .sql`UPDATE app_wallets SET revoked_at=NULL WHERE user_id=${f.sessions.recipient.userId}`
      await f.db
        .sql`UPDATE app_issuer_payloads SET canonical_payload=${f.canonical} WHERE id=${f.payloadId}`
      await f.db.sql`DELETE FROM credential_events WHERE transaction_hash=${deletionHash}`
      await f.db
        .sql`UPDATE credential_generations SET accepted=true,last_ledger_index=3,deleted_ledger_index=NULL,deletion_cause=NULL WHERE profile_id=${f.profileId}`
    }
  })
  it('notifies an issuer revocation observed outside the portal from durable ledger events', async () => {
    const transactionHash = '4'.repeat(64)
    await f.db
      .sql`INSERT INTO credential_events(profile_id,transaction_hash,node_index,generation_id,ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,schema_uid,accepted,deletion_cause,snapshot) VALUES (${f.profileId},${transactionHash},0,${f.generationId},${'1'.repeat(64)},4,${f.ledgerHash},0,'deleted',${f.issuerAddress},${f.subjectAddress},${f.schemaUid},true,'issuer_revoked','{}'::jsonb)`
    await f.db
      .sql`UPDATE credential_generations SET last_ledger_index=4,deleted_ledger_index=4,deletion_cause='issuer_revoked' WHERE profile_id=${f.profileId}`
    try {
      const workspace = await recipient.workspace(f.sessions.recipient)
      expect(workspace.notifications.map((n) => n.kind)).toEqual(['revoked', 'issued'])
      expect(workspace.credentials[0]!.status.deletionCause).toBe('issuer_revoked')
      expect(JSON.stringify(workspace.notifications)).not.toContain('Private synthetic claim')
    } finally {
      await f.db.sql`DELETE FROM credential_events WHERE transaction_hash=${transactionHash}`
      await f.db
        .sql`UPDATE credential_generations SET last_ledger_index=3,deleted_ledger_index=NULL,deletion_cause=NULL WHERE profile_id=${f.profileId}`
    }
  })
  it('serializes the 200-active-grant quota and keeps every active grant reachable ahead of revoked history', async () => {
    await f.db
      .sql`INSERT INTO app_presentations(profile_id,generation_id,recipient_user_id,scope,token_hash)
      SELECT ${f.profileId},${f.generationId},${f.sessions.recipient.userId},'public','5'||lpad(n::text,63,'0') FROM generate_series(1,197) AS n`
    try {
      const input = {
        profileId: f.profileId,
        generationId: f.generationId,
        scope: 'public' as const,
      }
      const attempts = await Promise.allSettled([
        createPresentation(f.sessions.recipient, input),
        createPresentation(f.sessions.recipient, input),
      ])
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const failure = attempts.find(
        (result) => result.status === 'rejected',
      ) as PromiseRejectedResult
      expect(failure.reason).toMatchObject({
        statusCode: 409,
        code: 'RECIPIENT_PRESENTATION_LIMIT',
      })
      await f.db
        .sql`INSERT INTO app_presentations(profile_id,generation_id,recipient_user_id,scope,token_hash,revoked_at)
        SELECT ${f.profileId},${f.generationId},${f.sessions.recipient.userId},'public','6'||lpad(n::text,63,'0'),statement_timestamp() FROM generate_series(1,205) AS n`
      const listed = await recipient.presentations(f.sessions.recipient, {
        profileId: f.profileId,
        generationId: f.generationId,
      })
      expect(listed.presentations).toHaveLength(200)
      expect(listed.presentations.every((grant) => grant.revokedAt === null)).toBe(true)
      expect(listed.presentations.some((grant) => grant.id === full.id)).toBe(true)
      const spare = listed.presentations.find(
        (grant) => grant.id !== full.id && grant.id !== publicLink.id,
      )!
      await recipient.revokePresentation(f.sessions.recipient, spare.id)
      expect((await createPresentation(f.sessions.recipient, input)).revokedAt).toBe(null)
    } finally {
      await f.db
        .sql`DELETE FROM app_presentation_proofs WHERE presentation_id NOT IN (${full.id},${publicLink.id})`
      await f.db.sql`DELETE FROM app_presentations WHERE id NOT IN (${full.id},${publicLink.id})`
    }
  })
  it('limits SQL privileges to presentation creation/revocation and history append; no ledger or role writes', async () => {
    await expect(
      f.authClient.sql`SELECT canonical_payload FROM app_issuer_payloads`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(f.authClient.sql`SELECT * FROM app_verifier_history`).rejects.toMatchObject({
      code: '42501',
    })
    await expect(
      f.portal.sql`UPDATE app_presentations SET token_hash=${'9'.repeat(64)} WHERE id=${full.id}`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      f.portal.sql`UPDATE credential_generations SET accepted=false`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      f.portal.sql`UPDATE app_organization_applications SET status='approved'`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(f.portal.sql`DELETE FROM app_verifier_history`).rejects.toMatchObject({
      code: '42501',
    })
    const columns = await f.db
      .sql`SELECT column_name FROM information_schema.columns WHERE table_name='app_presentations'`
    expect(columns.map((row) => row.column_name)).not.toContain('expires_at')
    expect(columns.map((row) => row.column_name)).not.toContain('consumed_at')
  })
  it('requires a fresh signed scope-bound challenge and consumes it atomically only once', async () => {
    const input = { profileId: f.profileId, generationId: f.generationId, scope: 'public' as const }
    const signed = await signPresentationInput(
      recipient,
      f.sessions.recipient,
      input,
      f.subjectWallet,
    )
    const [challenge] = await f.db
      .sql`SELECT * FROM app_presentation_challenges WHERE id=${signed.proof.challengeId}`
    for (const forbidden of [
      f.sessions.recipient.id,
      f.sessions.recipient.userId,
      f.sessions.recipient.tokenHash,
      f.subjectWallet.privateKey,
      'Private synthetic claim',
    ])
      expect(challenge!.message).not.toContain(forbidden)
    expect(challenge!.message).toContain('XCS presentation authorization v1')
    expect(challenge!.message).toContain(f.generationId)
    expect(challenge!.message).toContain('"/course"')
    expect(challenge!.message).toContain('not a transaction, payment, wallet link')
    const results = await Promise.allSettled([
      recipient.createPresentation(f.sessions.recipient, signed),
      recipient.createPresentation(f.sessions.recipient, signed),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'RECIPIENT_PROOF_INVALID' })
    const result = (
      results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<CreatedPresentation>
    ).value
    const resolved = await presentations.resolve(null, result.token)
    expect(resolved.holderProof).toMatchObject({
      status: 'verified',
      address: f.subjectAddress,
      publicKey: f.subjectWallet.publicKey,
      keyAuthority: 'master_key_address_only',
    })
    expect(resolved.issuerAdmission.status).toBe('approved')
    expect(
      await f.db
        .sql`SELECT id FROM app_presentation_challenges WHERE id=${signed.proof.challengeId}`,
    ).toEqual([])
    await expect(
      f.portal.sql`UPDATE app_presentation_proofs SET message='tampered'`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(f.authClient.sql`SELECT * FROM app_presentation_proofs`).rejects.toMatchObject({
      code: '42501',
    })
    await recipient.revokePresentation(f.sessions.recipient, result.id)
  })
  it('rejects scope/audience changes, another wallet, another session, and cross-purpose signatures without consuming the valid challenge', async () => {
    const input = { profileId: f.profileId, generationId: f.generationId, scope: 'public' as const }
    const signed = await signPresentationInput(
      recipient,
      f.sessions.recipient,
      input,
      f.subjectWallet,
    )
    await expect(
      recipient.createPresentation(f.sessions.recipient, {
        ...signed,
        scope: 'full',
        verifierOrganizationId: f.verifierOrg,
      }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_PROOF_INVALID' })
    const other = Wallet.generate()
    await expect(
      recipient.createPresentation(f.sessions.recipient, {
        ...signed,
        proof: { ...signed.proof, publicKey: other.publicKey },
      }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_PROOF_INVALID' })
    await expect(
      recipient.createPresentation(f.sessions.recipient, {
        ...signed,
        proof: {
          ...signed.proof,
          signature: sign(
            Buffer.from('XCS wallet ownership proof').toString('hex'),
            f.subjectWallet.privateKey,
          ),
        },
      }),
    ).rejects.toMatchObject({ code: 'RECIPIENT_PROOF_INVALID' })
    const token = {
      ...createAppToken(),
      csrfToken: createAppToken().token,
      idleSeconds: 1800,
      absoluteSeconds: 28800,
    }
    await f.auth.createSession(
      {
        issuer: 'https://identity.test',
        subject: 'recipient',
        emailVerified: true,
        email: 'recipient@example.test',
      },
      token,
    )
    const secondSession = (await f.auth.session(token.tokenHash))!
    await expect(recipient.createPresentation(secondSession, signed)).rejects.toMatchObject({
      code: 'RECIPIENT_PROOF_INVALID',
    })
    // Auth has no access to this purpose's challenge, even if the holder submits its UUID.
    expect(await f.auth.challenge(f.sessions.recipient.tokenHash, signed.proof.challengeId)).toBe(
      null,
    )
    expect(await f.auth.linkWallet(f.sessions.recipient.tokenHash, signed.proof.challengeId)).toBe(
      false,
    )
    const created = await recipient.createPresentation(f.sessions.recipient, signed)
    await recipient.revokePresentation(f.sessions.recipient, created.id)
  })
  it('rechecks current wallet, acceptance, disclosure and verifier approval between signing and creation', async () => {
    const input = {
      profileId: f.profileId,
      generationId: f.generationId,
      scope: 'full' as const,
      verifierOrganizationId: f.verifierOrg,
    }
    const signed = await signPresentationInput(
      recipient,
      f.sessions.recipient,
      input,
      f.subjectWallet,
    )
    await f.db
      .sql`UPDATE app_wallets SET revoked_at=statement_timestamp() WHERE user_id=${f.sessions.recipient.userId}`
    try {
      await expect(
        recipient.createPresentation(f.sessions.recipient, signed),
      ).rejects.toMatchObject({ code: 'RECIPIENT_WALLET_REQUIRED' })
    } finally {
      await f.db
        .sql`UPDATE app_wallets SET revoked_at=NULL WHERE user_id=${f.sessions.recipient.userId}`
    }
    await f.db.sql`UPDATE credential_generations SET accepted=false WHERE profile_id=${f.profileId}`
    try {
      await expect(
        recipient.createPresentation(f.sessions.recipient, signed),
      ).rejects.toMatchObject({ code: 'RECIPIENT_CREDENTIAL_NOT_ACTIVE' })
    } finally {
      await f.db
        .sql`UPDATE credential_generations SET accepted=true WHERE profile_id=${f.profileId}`
    }
    await f.db
      .sql`UPDATE app_credential_metadata SET public_fields='[]'::jsonb WHERE profile_id=${f.profileId}`
    try {
      await expect(
        recipient.createPresentation(f.sessions.recipient, signed),
      ).rejects.toMatchObject({ code: 'RECIPIENT_PROOF_INVALID' })
    } finally {
      await f.db
        .sql`UPDATE app_credential_metadata SET public_fields='["/course"]'::jsonb WHERE profile_id=${f.profileId}`
    }
    await f.db
      .sql`UPDATE app_organization_applications SET status='suspended',review_reason='Test' WHERE organization_id=${f.verifierOrg} AND role='verifier'`
    try {
      await expect(
        recipient.createPresentation(f.sessions.recipient, signed),
      ).rejects.toMatchObject({ code: 'RECIPIENT_VERIFIER_UNAVAILABLE' })
    } finally {
      await f.db
        .sql`UPDATE app_organization_applications SET status='approved',review_reason=NULL WHERE organization_id=${f.verifierOrg} AND role='verifier'`
    }
    const created = await recipient.createPresentation(f.sessions.recipient, signed)
    await recipient.revokePresentation(f.sessions.recipient, created.id)
  })
  it('expires challenges after five minutes, requires a proof for new links and distinguishes unsigned legacy grants from corrupted proofs', async () => {
    const input = { profileId: f.profileId, generationId: f.generationId, scope: 'public' as const }
    await expect(
      recipient.createPresentation(f.sessions.recipient, input as CreatePresentationInput),
    ).rejects.toMatchObject({ code: 'RECIPIENT_PROOF_REQUIRED' })
    const signed = await signPresentationInput(
      recipient,
      f.sessions.recipient,
      input,
      f.subjectWallet,
    )
    await f.db
      .sql`UPDATE app_presentation_challenges SET created_at=statement_timestamp()-interval '6 minutes',expires_at=statement_timestamp()-interval '1 minute' WHERE id=${signed.proof.challengeId}`
    await expect(recipient.createPresentation(f.sessions.recipient, signed)).rejects.toMatchObject({
      code: 'RECIPIENT_PROOF_EXPIRED',
    })
    const legacy = createAppToken()
    await f.db
      .sql`INSERT INTO app_presentations(profile_id,generation_id,recipient_user_id,scope,token_hash) VALUES (${f.profileId},${f.generationId},${f.sessions.recipient.userId},'public',${legacy.tokenHash})`
    expect((await presentations.resolve(null, legacy.token)).holderProof).toEqual({
      status: 'not_provided',
    })
    const created = await createPresentation(f.sessions.recipient, input)
    await f.db
      .sql`UPDATE app_presentation_proofs SET signature=${'0'.repeat(128)} WHERE presentation_id=${created.id}`
    await expect(presentations.resolve(null, created.token)).rejects.toMatchObject({
      code: 'PRESENTATION_UNAVAILABLE',
    })
  })
})
