import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestOidcOptions {
  claims?: Record<string, unknown>
  missingIdToken?: boolean
  badSignature?: boolean
  metadata?: Record<string, unknown>
}

/** Real HTTP discovery/token/JWKS fixture; all credentials and claims are fictional. */
export async function startOidcProvider(options: TestOidcOptions = {}) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wrongKey = options.badSignature ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : key
  const publicJwk = {
    ...key.publicKey.export({ format: 'jwk' }),
    kid: 'test-key',
    use: 'sig',
    alg: 'RS256',
  }
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>()
  const requests = { discovery: 0, authorization: 0, token: 0, jwks: 0 }
  const rejections: string[] = []
  const clientId = 'xcs-test-client'
  const clientSecret = 'fictional-test-client-secret'
  let issuer = ''
  const json = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', issuer)
      if (url.pathname === '/.well-known/openid-configuration') {
        requests.discovery++
        json(response, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
          ...options.metadata,
        })
      } else if (url.pathname === '/authorize') {
        requests.authorization++
        if (
          url.searchParams.get('client_id') !== clientId ||
          url.searchParams.get('code_challenge_method') !== 'S256'
        ) {
          json(response, { error: 'invalid_request' }, 400)
          return
        }
        const code = randomBytes(24).toString('base64url')
        const redirectUri = url.searchParams.get('redirect_uri')!
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge')!,
          nonce: url.searchParams.get('nonce')!,
          redirectUri,
        })
        const callback = new URL(redirectUri)
        callback.searchParams.set('code', code)
        callback.searchParams.set('state', url.searchParams.get('state')!)
        response.writeHead(302, { location: callback.href })
        response.end()
      } else if (url.pathname === '/token' && request.method === 'POST') {
        requests.token++
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = new URLSearchParams(Buffer.concat(chunks).toString())
        const code = body.get('code') ?? ''
        const pending = codes.get(code)
        codes.delete(code)
        // HTTP authentication scheme names are case-insensitive; the credentials are not.
        const basic = /^Basic ([A-Za-z0-9+/]+=*)$/iu.exec(request.headers.authorization ?? '')
        const credentials = Buffer.from(basic?.[1] ?? '', 'base64')
          .toString()
          .split(':')
        // OAuth Basic encodes each credential as form data before base64 (including hyphens).
        const authenticated =
          credentials.length === 2 &&
          decodeURIComponent(credentials[0]!.replace(/\+/gu, ' ')) === clientId &&
          decodeURIComponent(credentials[1]!.replace(/\+/gu, ' ')) === clientSecret
        const challenge = createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url')
        if (
          !authenticated ||
          body.get('grant_type') !== 'authorization_code' ||
          !pending ||
          pending.challenge !== challenge ||
          pending.redirectUri !== body.get('redirect_uri')
        ) {
          rejections.push(
            !authenticated
              ? 'client_authentication'
              : body.get('grant_type') !== 'authorization_code'
                ? 'grant_type'
                : !pending
                  ? 'code'
                  : pending.challenge !== challenge
                    ? 'pkce'
                    : 'redirect_uri',
          )
          json(response, { error: 'invalid_grant' }, 400)
          return
        }
        const now = Math.floor(Date.now() / 1000)
        const claims = {
          iss: issuer,
          sub: 'fictional-subject',
          aud: clientId,
          iat: now,
          exp: now + 300,
          nonce: pending.nonce,
          email: 'learner@example.invalid',
          email_verified: true,
          name: 'Example Learner',
          ...options.claims,
        }
        const encoded = [{ alg: 'RS256', kid: 'test-key', typ: 'JWT' }, claims]
          .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
          .join('.')
        const idToken = `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), wrongKey.privateKey).toString('base64url')}`
        json(response, {
          access_token: 'fictional-access-token',
          refresh_token: 'fictional-refresh-token',
          token_type: 'Bearer',
          expires_in: 300,
          ...(options.missingIdToken ? {} : { id_token: idToken }),
        })
      } else if (url.pathname === '/jwks') {
        requests.jwks++
        json(response, { keys: [publicJwk] })
      } else {
        json(response, { error: 'not_found' }, 404)
      }
    } catch {
      json(response, { error: 'test_provider_failure' }, 500)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    issuer,
    clientId,
    clientSecret,
    requests,
    rejections,
    async authorize(authorizationUrl: string): Promise<URL> {
      const response = await fetch(authorizationUrl, { redirect: 'manual' })
      if (response.status !== 302) throw new Error('TEST_AUTHORIZATION_FAILED')
      return new URL(response.headers.get('location')!)
    },
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
