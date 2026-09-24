import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createDatabaseClient } from '../server/lib/db/index.js'
import { adminSecret } from '../server/xcs/admin/config.js'

async function main() {
  const url = new URL(adminSecret(process.env, 'XCS_ADMIN_FIXTURE_DATABASE_URL'))
  const directory = process.env.XCS_ADMIN_DOCUMENT_DIRECTORY ?? ''
  if (
    process.env.NODE_ENV === 'production' ||
    !['127.0.0.1', 'localhost', 'postgres'].includes(url.hostname) ||
    !/^\/xcs_admin_demo[a-z0-9_]*$/.test(url.pathname) ||
    !isAbsolute(directory)
  )
    throw new Error('FIXTURE_LOCAL_DEMO_DATABASE_REQUIRED')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=',
    'base64',
  )
  const client = createDatabaseClient(url.toString(), { onNotice: () => undefined })
  try {
    for (const role of ['issuer', 'verifier'] as const) {
      const key = `synthetic-${randomUUID()}.png`
      await writeFile(join(directory, key), bytes, { mode: 0o600, flag: 'wx' })
      await client.sql.begin(async (sql) => {
        const [user] =
          await sql`INSERT INTO app_users(identity_issuer,identity_subject,email,email_verified_at,display_name)
          VALUES ('https://synthetic.invalid',${randomUUID()},'synthetic@example.test',statement_timestamp(),'Synthetic review contact') RETURNING id`
        const [org] =
          await sql`INSERT INTO app_organizations(responsible_user_id,name) VALUES (${user!.id},${'Synthetic ' + role + ' organization'}) RETURNING id`
        await sql`INSERT INTO app_organization_applications(organization_id,role,website,jurisdiction,description,purpose)
          VALUES (${org!.id},${role},'https://example.test','Synthetic jurisdiction','Local validation fixture, not a real organization.','Validate administrator decisions.')`
        await sql`INSERT INTO app_documents(organization_id,application_role,storage_key,mime_type,byte_length,sha256,uploaded_by)
          VALUES (${org!.id},${role},${key},'image/png',${bytes.length},${createHash('sha256').update(bytes).digest('hex')},${user!.id})`
      })
    }
    console.log(
      'Created two synthetic applications and private PNG documents. No account can sign in through the synthetic issuer.',
    )
  } finally {
    await client.close()
  }
}
main().catch(() => {
  console.error(
    'admin-fixtures: failed; require migrated local xcs_admin_demo database and private writable directory',
  )
  process.exitCode = 1
})
