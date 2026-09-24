import { randomBytes, randomUUID } from 'node:crypto'
import { Wallet, unixTimeToRippleTime } from 'xrpl'
import { sign } from 'ripple-keypairs'
import type { RecipientRepository } from '../../server/xcs/recipient/repository'
import type {
  PresentationChallengeInput,
  CreatePresentationInput,
} from '../../server/xcs/recipient/types'
import {
  canonicalJson,
  computeSchemaUid,
  createHttpsPayloadUri,
  encodeHexUtf8,
  payloadDigest,
} from '#xcs/core/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../../server/lib/db/bootstrap.js'
import {
  createAppToken,
  createDatabaseClient,
  type DatabaseClient,
} from '../../server/lib/db/index.js'
import { PostgresAuthRepository } from '../../server/xcs/auth/repository'
import type { Session } from '../../server/xcs/auth/types'

/** Synthetic rows exercise the production authorization and canonical-evidence code under restricted grants. */
export async function createRecipientDatabase(url: string) {
  const operator = createDatabaseClient(url, { onNotice: () => undefined })
  const name = 'xcs_recipient_test_' + randomUUID().replaceAll('-', '')
  const parsed = new URL(url)
  let db: DatabaseClient | undefined,
    portal: DatabaseClient | undefined,
    authClient: DatabaseClient | undefined
  const close = async () => {
    await Promise.all([portal?.close(), authClient?.close(), db?.close()])
    if (/^xcs_recipient_test_[a-f0-9]{32}$/.test(name))
      await operator.sql`DROP DATABASE IF EXISTS ${operator.sql(name)} WITH (FORCE)`
    await operator.close()
  }
  try {
    await operator.sql`CREATE DATABASE ${operator.sql(name)} TEMPLATE template0`
    parsed.pathname = '/' + name
    db = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    const passwords = {
      clusterScope: 'dedicated' as const,
      administratorPassword: databasePasswordFromUrl(url),
      indexerPassword: randomBytes(32).toString('hex'),
      apiPassword: randomBytes(32).toString('hex'),
      payloadWriterPassword: randomBytes(32).toString('hex'),
      monitorPassword: randomBytes(32).toString('hex'),
      applicationPassword: randomBytes(32).toString('hex'),
      issuerPassword: randomBytes(32).toString('hex'),
    }
    await bootstrapDatabase(db, passwords)
    parsed.username = 'xcs_app'
    parsed.password = passwords.applicationPassword
    authClient = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    parsed.username = 'xcs_issuer'
    parsed.password = passwords.issuerPassword
    portal = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    const auth = new PostgresAuthRepository(authClient)
    const sessions = {} as Record<'issuer' | 'recipient' | 'verifier' | 'other' | 'admin', Session>
    for (const actor of ['issuer', 'recipient', 'verifier', 'other', 'admin'] as const) {
      const token = {
        ...createAppToken(),
        csrfToken: createAppToken().token,
        idleSeconds: 1800,
        absoluteSeconds: 28800,
      }
      await auth.createSession(
        {
          issuer: 'https://identity.test',
          subject: actor,
          emailVerified: true,
          email: `${actor}@example.test`,
        },
        token,
      )
      sessions[actor] = (await auth.session(token.tokenHash))!
    }
    await db.sql`INSERT INTO app_user_roles(user_id,role) VALUES (${sessions.admin.userId},'admin')`
    const issuerOrg = randomUUID(),
      verifierOrg = randomUUID(),
      otherOrg = randomUUID(),
      inviteId = randomUUID(),
      payloadId = randomUUID()
    for (const [id, user, role, title] of [
      [issuerOrg, sessions.issuer.userId, 'issuer', 'Issuer'],
      [verifierOrg, sessions.verifier.userId, 'verifier', 'Verifier'],
      [otherOrg, sessions.other.userId, 'verifier', 'Other verifier'],
    ]) {
      await db.sql`INSERT INTO app_organizations(id,responsible_user_id,name) VALUES (${id},${user},${title})`
      await db.sql`INSERT INTO app_organization_applications(organization_id,role,status,reviewed_by,reviewed_at) VALUES (${id},${role},'approved',${sessions.admin.userId},statement_timestamp())`
    }
    const profileId = 'recipient-testnet',
      generationId = 'c'.repeat(64),
      registrationHash = 'b'.repeat(64),
      ledgerHash = 'd'.repeat(64),
      acceptedHash = 'e'.repeat(64)
    const issuerAddress = Wallet.generate().address,
      subjectWallet = Wallet.generate(),
      subjectAddress = subjectWallet.address
    const definition = {
      xcsVersion: '0.1' as const,
      name: 'Synthetic recipient credential',
      description: 'Canonical evidence fixture',
      fields: { course: { type: 'string' as const }, secret: { type: 'string' as const } },
    }
    const schemaUid = computeSchemaUid({
      schema: definition,
      networkId: 1,
      publisher: issuerAddress,
      ledgerIndex: 1,
      ledgerHash,
      transactionIndex: 0,
    })
    const canonical = canonicalJson({
      xcsVersion: '0.1',
      issuer: issuerAddress,
      subject: subjectAddress,
      schema: schemaUid,
      claims: { course: 'Public course', secret: 'Private synthetic claim' },
    })
    const digest = payloadDigest(canonical)
    const uri = createHttpsPayloadUri('https://xcs.test/q/' + 'a'.repeat(18), canonical)
    await db.sql`INSERT INTO network_profiles(profile_id,xcs_version,network_id,required_amendment,registry_address,registration_amount_drops,activation_ledger_index,activation_ledger_hash) VALUES (${profileId},'0.1',1,${ledgerHash},${issuerAddress},1,1,${ledgerHash})`
    await db.sql`INSERT INTO schema_events(profile_id,transaction_hash,ledger_index,ledger_hash,transaction_index,publisher,status,schema_uid,memo_json) VALUES (${profileId},${registrationHash},1,${ledgerHash},0,${issuerAddress},'accepted',${schemaUid},${JSON.stringify(definition)}::jsonb)`
    await db.sql`INSERT INTO schemas(profile_id,schema_uid,publisher,name,description,definition,resolved_definition,registration_transaction_hash,ledger_index,transaction_index) VALUES (${profileId},${schemaUid},${issuerAddress},${definition.name},${definition.description},${JSON.stringify(definition)}::jsonb,${JSON.stringify({ definition, fields: definition.fields, lineage: [] })}::jsonb,${registrationHash},1,0)`
    await db.sql`INSERT INTO app_schema_metadata(profile_id,schema_uid,organization_id,registration_transaction_hash) VALUES (${profileId},${schemaUid},${issuerOrg},${registrationHash})`
    await db.sql`INSERT INTO app_invites(id,organization_id,profile_id,schema_uid,token_hash,created_by,expires_at,claimed_by,claimed_at) VALUES (${inviteId},${issuerOrg},${profileId},${schemaUid},${'f'.repeat(64)},${sessions.issuer.userId},statement_timestamp()+interval '7 days',${sessions.recipient.userId},statement_timestamp())`
    await db.sql`INSERT INTO app_issuer_payloads(id,locator,invite_id,created_by,subject_address,canonical_payload,payload_digest,credential_uri,visibility,public_fields) VALUES (${payloadId},${'a'.repeat(18)},${inviteId},${sessions.issuer.userId},${subjectAddress},${canonical},${digest},${uri},'private','["/course"]'::jsonb)`
    await db.sql`INSERT INTO app_credential_metadata(profile_id,generation_id,schema_uid,issuer_organization_id,recipient_user_id,invite_id,issuer_address,subject_address,visibility,public_fields,payload_storage_key,payload_digest,creation_transaction_hash,creation_ledger_index) VALUES (${profileId},${generationId},${schemaUid},${issuerOrg},${sessions.recipient.userId},${inviteId},${issuerAddress},${subjectAddress},'private','["/course"]'::jsonb,${payloadId},${digest},${generationId},2)`
    await db.sql`INSERT INTO app_wallets(user_id,network_id,address,verified_at) VALUES (${sessions.recipient.userId},1,${subjectAddress},statement_timestamp())`
    await db.sql`INSERT INTO credential_generations(profile_id,generation_id,ledger_object_id,issuer,subject,schema_uid,uri_hex,accepted,created_ledger_index,created_transaction_index,last_ledger_index) VALUES (${profileId},${generationId},${'1'.repeat(64)},${issuerAddress},${subjectAddress},${schemaUid},${encodeHexUtf8(uri)},true,2,0,3)`
    for (const [transactionHash, eventType, ledgerIndex, accepted] of [
      [generationId, 'created', 2, false],
      [acceptedHash, 'accepted', 3, true],
    ] as const) {
      await db.sql`INSERT INTO credential_events(profile_id,transaction_hash,node_index,generation_id,ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,schema_uid,uri_hex,accepted,snapshot) VALUES (${profileId},${transactionHash},0,${generationId},${'1'.repeat(64)},${ledgerIndex},${ledgerHash},0,${eventType},${issuerAddress},${subjectAddress},${schemaUid},${encodeHexUtf8(uri)},${accepted},'{}'::jsonb)`
    }
    await db.sql`INSERT INTO ledger_checkpoints(profile_id,ledger_index,ledger_hash,parent_hash,close_time,transaction_count,transaction_root) VALUES (${profileId},4,${ledgerHash},${'0'.repeat(64)},${unixTimeToRippleTime(Date.now())},0,${'2'.repeat(64)})`
    await db.sql`INSERT INTO indexer_status(profile_id,state,primary_source_tip,secondary_source_tip,last_agreed_ledger_index,last_agreed_ledger_hash,writer_id,writer_epoch,lease_expires_at) VALUES (${profileId},'ready',4,4,4,${ledgerHash},'recipient-test-writer',1,statement_timestamp()+interval '4 minutes')`
    return {
      db,
      portal,
      authClient,
      auth,
      sessions,
      profileId,
      generationId,
      schemaUid,
      issuerOrg,
      verifierOrg,
      otherOrg,
      inviteId,
      payloadId,
      acceptedHash,
      canonical,
      issuerAddress,
      subjectAddress,
      subjectWallet,
      ledgerHash,
      uri,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

/** Test-only synthetic wallet signer; never logs or persists the private key. */
export async function signPresentationInput(
  repository: RecipientRepository,
  session: Session,
  input: PresentationChallengeInput,
  wallet: Wallet,
): Promise<CreatePresentationInput> {
  const challenge = await repository.presentationChallenge(session, input)
  return {
    ...input,
    proof: {
      challengeId: challenge.id,
      publicKey: wallet.publicKey,
      scheme: 'ripple',
      signature: sign(Buffer.from(challenge.message).toString('hex'), wallet.privateKey),
    },
  }
}
