import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { computeSchemaUid, encodeCredentialPayload, payloadDigest } from '#xcs/core/index.js'
import { createDatabaseClient, type DatabaseClient } from '../../server/lib/db/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../../server/lib/db/bootstrap.js'
import { buildCredentialCreate } from '#xcs/sdk/index.js'
import { describe, expect, it } from 'vitest'
import { Wallet } from 'xrpl'

// Opt in separately from unit/SQL suites: runtime roles are cluster-wide, so these
// integration suites must run sequentially on a disposable PostgreSQL 18 cluster.
const enabled = process.env.XCS_REQUIRE_RUNTIME_TESTS === '1'
const adminUrl = process.env.XCS_TEST_DATABASE_URL
if (enabled && !adminUrl) throw new Error('XCS_TEST_DATABASE_URL is required by runtime tests')

const outputEntry = fileURLToPath(new URL('../../.output/server/index.mjs', import.meta.url))
const profileId = 'runtime-testnet'
const hash = 'a'.repeat(64)
const publicPayloadOrigin = 'https://payload.test'
const fixturePasswords = {
  indexerPassword: 'indexer-runtime-integration-password-01',
  apiPassword: 'reader-runtime-integration-password-01',
  payloadWriterPassword: 'payload-runtime-integration-password-01',
  monitorPassword: 'monitor-runtime-integration-password-01',
}

function roleUrl(url: string, role: string, password: string) {
  const parsed = new URL(url)
  parsed.username = role
  parsed.password = password
  return parsed.toString()
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  if (!address || typeof address === 'string') throw new Error('No test port allocated')
  return address.port
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()))
  server.kill('SIGTERM')
  const forceKill = setTimeout(() => server.kill('SIGKILL'), 5_000)
  try {
    await exited
  } finally {
    clearTimeout(forceKill)
  }
}

async function seedProjection(database: DatabaseClient) {
  const issuer = Wallet.generate()
  const subject = Wallet.generate().address
  const definition = {
    xcsVersion: '0.1' as const,
    name: 'Runtime integration course',
    description: 'Synthetic PostgreSQL fixture, not a live ledger credential.',
    fields: { course: { type: 'string' as const } },
  }
  const schemaUid = computeSchemaUid({
    schema: definition,
    networkId: 1,
    ledgerHash: hash,
    ledgerIndex: 1,
    transactionIndex: 0,
    publisher: issuer.address,
  })
  const payload = encodeCredentialPayload(
    { course: 'Synthetic course' },
    {
      issuer: issuer.address,
      subject,
      schemaUid,
      fields: definition.fields,
    },
  )
  const digest = payloadDigest(payload.bytes)
  const locator = digest.slice(0, 18)
  const uri = `${publicPayloadOrigin}/p/${locator}#xcs-sha256=${digest}`
  const transaction = buildCredentialCreate({ issuer: issuer.address, subject, schemaUid, uri })
  const signed = issuer.sign({ ...transaction, Fee: '12', Sequence: 1, LastLedgerSequence: 20 })
  const closeTime = Math.floor(Date.now() / 1_000) - 946684800
  await database.sql`
    INSERT INTO network_profiles (profile_id,xcs_version,network_id,required_amendment,
      registry_address,registration_amount_drops,activation_ledger_index,activation_ledger_hash)
    VALUES (${profileId},'0.1',1,${'b'.repeat(64)},${issuer.address},1,1,${hash})
  `
  await database.sql`
    INSERT INTO ledger_checkpoints (profile_id,ledger_index,ledger_hash,parent_hash,
      close_time,transaction_count,transaction_root)
    VALUES (${profileId},10,${hash},${'b'.repeat(64)},${closeTime},2,${'c'.repeat(64)})
  `
  await database.sql`
    INSERT INTO indexer_status (profile_id,state,primary_source_tip,secondary_source_tip,
      last_agreed_ledger_index,last_agreed_ledger_hash,writer_id,writer_epoch,lease_expires_at)
    VALUES (${profileId},'ready',10,10,10,${hash},'runtime-test-writer',1,now()+interval '5 minutes')
  `
  await database.sql`
    INSERT INTO schema_events (profile_id,transaction_hash,ledger_index,ledger_hash,
      transaction_index,publisher,status,schema_uid,memo_json)
    VALUES (${profileId},${'d'.repeat(64)},1,${hash},0,${issuer.address},'accepted',
      ${schemaUid},${JSON.stringify(definition)}::jsonb)
  `
  await database.sql`
    INSERT INTO schemas (profile_id,schema_uid,publisher,name,description,definition,
      resolved_definition,registration_transaction_hash,ledger_index,transaction_index)
    VALUES (${profileId},${schemaUid},${issuer.address},${definition.name},${definition.description},
      ${JSON.stringify(definition)}::jsonb,
      ${JSON.stringify({ definition, fields: definition.fields, lineage: [] })}::jsonb,
      ${'d'.repeat(64)},1,0)
  `
  await database.sql`
    INSERT INTO credential_generations (profile_id,generation_id,ledger_object_id,issuer,
      subject,schema_uid,uri_hex,accepted,created_ledger_index,created_transaction_index,last_ledger_index)
    VALUES (${profileId},${signed.hash.toLowerCase()},${'e'.repeat(64)},${issuer.address},
      ${subject},${schemaUid},${transaction.URI!},false,2,0,2)
  `
  await database.sql`
    INSERT INTO credential_events (profile_id,transaction_hash,node_index,generation_id,
      ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,
      schema_uid,uri_hex,accepted,snapshot)
    VALUES (${profileId},${signed.hash.toLowerCase()},0,${signed.hash.toLowerCase()},
      ${'e'.repeat(64)},2,${hash},0,'created',${issuer.address},${subject},${schemaUid},
      ${transaction.URI!},false,'{}'::jsonb)
  `
  return { schemaUid, payload, locator, uri, digest, signed }
}

describe.skipIf(!enabled)('built Nuxt with real PostgreSQL', () => {
  it('exempts Nitro in-process reads while retaining the external HTTP quota', async () => {
    await access(outputEntry)
    const port = await unusedPort()
    const script = `
      await import(${JSON.stringify(new URL('../../.output/server/index.mjs', import.meta.url).href)})
      const request = () => globalThis.$fetch.raw('/v1/verify', {
        method: 'POST', body: {}, retry: 0, timeout: 2000, ignoreResponseError: true,
      })
      const statuses = []
      for (let index = 0; index < 30; index++) {
        const response = await request()
        statuses.push(response.status)
      }
      const external = []
      for (let index = 0; index < 21; index++) {
        const response = await fetch('http://127.0.0.1:${port}/v1/verify', {
          method: 'POST', body: '{}',
          headers: { 'content-type': 'application/json', '__unenv__': 'true',
            'xcs-client-address': '198.51.100.' + index },
        })
        external.push(response.status)
        await response.arrayBuffer()
      }
      process.send({ statuses, external })
    `
    const server = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^(?:XCS_|NUXT_|NITRO_)/u.test(key)),
        ),
        NODE_ENV: 'production',
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(port),
        // Validation happens before database access: this probe must not read or write fixtures.
        XCS_DATABASE_URL: 'postgres://xcs_api:unused@127.0.0.1:1/xcs_unused',
      },
    })
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Nitro SSR quota probe timed out')),
          10_000,
        )
        server.once('message', (message) => {
          clearTimeout(timeout)
          resolve(message)
        })
        server.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        server.once('exit', () => {
          clearTimeout(timeout)
          reject(new Error('Nitro SSR quota probe exited early'))
        })
      })
      expect(result).toEqual({
        statuses: Array(30).fill(400),
        external: [...Array(20).fill(400), 429],
      })
    } finally {
      await stopServer(server)
    }
  }, 15_000)

  it('serves SSR, readiness, validation and signed payload publication through restricted pools', async () => {
    await access(outputEntry) // Build first; never silently replace this with a dev server.
    const admin = createDatabaseClient(adminUrl!)
    const name = `xcs_runtime_it_${randomUUID().replaceAll('-', '')}`
    const parsed = new URL(adminUrl!)
    parsed.pathname = `/${name}`
    let created = false
    let provisioned = false
    let database: DatabaseClient | undefined
    let server: ChildProcess | undefined
    try {
      const [version] =
        await admin.sql`SELECT current_setting('server_version_num')::integer AS version`
      expect(version?.version).toBeGreaterThanOrEqual(180_000)
      expect(version?.version).toBeLessThan(190_000)
      await admin.sql`CREATE DATABASE ${admin.sql(name)} TEMPLATE template0 ENCODING 'UTF8'`
      created = true
      database = createDatabaseClient(parsed.toString())
      await bootstrapDatabase(database, {
        clusterScope: 'dedicated',
        administratorPassword: databasePasswordFromUrl(adminUrl!),
        ...fixturePasswords,
      })
      provisioned = true
      const fixture = await seedProjection(database)
      const port = await unusedPort()
      const origin = `http://127.0.0.1:${port}`
      server = spawn(process.execPath, [outputEntry], {
        stdio: 'ignore',
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !/^(?:XCS_|NUXT_|NITRO_)/u.test(key)),
          ),
          NODE_ENV: 'production',
          NITRO_HOST: '127.0.0.1',
          NITRO_PORT: String(port),
          XCS_DATABASE_URL: roleUrl(parsed.toString(), 'xcs_api', fixturePasswords.apiPassword),
          XCS_PAYLOAD_DATABASE_URL: roleUrl(
            parsed.toString(),
            'xcs_payload_writer',
            fixturePasswords.payloadWriterPassword,
          ),
          // SSR must ignore this browser-only endpoint, using Nitro's in-process dispatch.
          NUXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:1',
          NUXT_PUBLIC_PROFILE_ID: profileId,
          XCS_ALLOWED_ORIGINS: origin,
          XCS_HOSTED_PAYLOADS_ENABLED: 'true',
          XCS_PUBLIC_PAYLOAD_BASE_URL: publicPayloadOrigin,
          XCS_PAYLOAD_STORAGE_IP_HASH_SECRET: 'runtime-integration-ip-hash-secret-01',
          XCS_HOSTED_PAYLOAD_NETWORKS: profileId,
        },
      })
      const deadline = Date.now() + 30_000
      let started = false
      while (Date.now() < deadline) {
        if (server.exitCode !== null) throw new Error('Built Nuxt exited before startup')
        const response = await fetch(`${origin}/health/live`, {
          signal: AbortSignal.timeout(1_000),
        }).catch(() => undefined)
        if (response?.ok) {
          started = true
          break
        }
        await delay(100)
      }
      expect(started, 'Built Nuxt must start within 30 seconds').toBe(true)
      const request = (path: string, init?: RequestInit) =>
        fetch(`${origin}${path}`, {
          ...init,
          signal: AbortSignal.timeout(10_000),
        })
      expect(await (await request('/health/live')).json()).toEqual({ status: 'ok' })
      const networks = await request('/v1/networks')
      expect(networks.status).toBe(200)
      expect(await networks.json()).toMatchObject({ items: [{ profileId }] })
      const readiness = await request(`/v1/networks/${profileId}/readiness`)
      expect(readiness.status).toBe(200)
      expect(await readiness.json()).toMatchObject({ status: 'ready', profileId })

      const page = await request('/schemas')
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain('data-testid="schema-card"')
      expect(html).toContain('Runtime integration course')
      expect(html).toContain(fixture.schemaUid)
      expect(html).not.toContain('data-testid="explorer-error"')
      const invalid = await request('/v1/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toHaveProperty('error')

      const publicationBody = JSON.stringify({
        network: profileId,
        payloadBase64: Buffer.from(fixture.payload.bytes).toString('base64'),
        signedTransactionBlob: fixture.signed.tx_blob,
      })
      const publish = () =>
        request(`/v1/payloads/${fixture.locator}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: publicationBody,
        })
      const publication = await publish()
      expect(publication.status).toBe(200)
      expect(await publication.json()).toMatchObject({ uri: fixture.uri })
      expect((await publish()).status).toBe(200)
      const payload = await request(`/p/${fixture.locator}`)
      expect(payload.status).toBe(200)
      expect(await payload.text()).toBe(fixture.payload.json)
      expect(payload.headers.get('etag')).toBe(`"${fixture.digest}"`)
      const [stored] =
        await database.sql`SELECT count(*)::integer AS count FROM hosted_payload_publications`
      expect(stored?.count).toBe(1)
    } finally {
      // Stop connection owners before dropping their database, even on a failed assertion.
      try {
        if (server) await stopServer(server)
      } finally {
        try {
          await database?.close()
          if (created) await admin.sql`DROP DATABASE ${admin.sql(name)} WITH (FORCE)`
          if (provisioned)
            await admin.sql`DROP ROLE xcs_indexer, xcs_api, xcs_payload_writer, xcs_monitor`
        } finally {
          await admin.close()
        }
      }
    }
  }, 60_000)
})
