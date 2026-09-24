import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { get } from 'node:https'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

/** Actual production Nitro + PostgreSQL. Only the synthetic session is pre-created.
 * Trust this test certificate's public key in this browser process, never the OS CA store.
 */
export async function startAdminRuntime(
  directory: string,
  databaseUrls: { api: string; auth: string; admin: string },
  issuer?: { issuerDatabaseUrl: string; smtpPort: number },
) {
  const certPath = join(directory, 'tls.crt'),
    keyPath = join(directory, 'tls.key'),
    config = join(directory, 'tls.cnf')
  await writeFile(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n',
    { mode: 0o600 },
  )
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-days',
      '1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-config',
      config,
    ],
    { stdio: 'ignore' },
  )
  const cert = await readFile(certPath, 'utf8'),
    key = await readFile(keyPath, 'utf8')
  const publicKey = execFileSync('openssl', ['x509', '-in', certPath, '-pubkey', '-noout'])
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: publicKey })
  const spki = createHash('sha256').update(der).digest('base64')
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  const origin = `https://127.0.0.1:${port}`
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../.output/server/index.mjs', import.meta.url))],
    {
      stdio: 'ignore',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !/^(XCS_|NUXT_|NITRO_)/.test(name)),
        ),
        NODE_ENV: 'production',
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: String(port),
        NITRO_SSL_CERT: cert,
        NITRO_SSL_KEY: key,
        XCS_DATABASE_URL: databaseUrls.api,
        NUXT_APP_DATABASE_URL: databaseUrls.auth,
        NUXT_ADMIN_DATABASE_URL: databaseUrls.admin,
        XCS_AUTH_ENABLED: '1',
        XCS_AUTH_ORIGIN: origin,
        XCS_IDENTITY_ISSUER: 'https://identity.test',
        XCS_IDENTITY_CLIENT_ID: 'synthetic-runtime',
        XCS_IDENTITY_CLIENT_SECRET: 'synthetic-not-used-for-login',
        XCS_ADMIN_ENABLED: '1',
        XCS_ADMIN_DOCUMENT_DIRECTORY: directory,
        XCS_ADMIN_DOCUMENT_KEY: 'synthetic-runtime-document-key-32-bytes',
        ...(issuer
          ? {
              XCS_ISSUER_ENABLED: '1',
              NUXT_ISSUER_DATABASE_URL: issuer.issuerDatabaseUrl,
              XCS_ISSUER_DOCUMENT_DIRECTORY: directory,
              XCS_SMTP_HOST: '127.0.0.1',
              XCS_SMTP_PORT: String(issuer.smtpPort),
            }
          : {}),
      },
    },
  )
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await done
    clearTimeout(timer)
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('ADMIN_RUNTIME_EXITED')
      ready = await new Promise<boolean>((resolve) => {
        const req = get(origin + '/health/live', { ca: cert, timeout: 500 }, (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        })
        req.on('error', () => resolve(false))
        req.on('timeout', () => {
          req.destroy()
          resolve(false)
        })
      })
      if (ready) break
      await delay(100)
    }
    if (!ready) throw new Error('ADMIN_RUNTIME_NOT_READY')
    const browser = await chromium.launch({
      args: [`--ignore-certificate-errors-spki-list=${spki}`],
    })
    const context = await browser.newContext()
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    )
    return {
      origin,
      context,
      close: async () => {
        await browser.close()
        await stop()
      },
    }
  } catch (error) {
    await stop()
    throw error
  }
}
