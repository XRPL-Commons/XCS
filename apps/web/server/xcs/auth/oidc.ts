import * as oidc from 'openid-client'

export interface OidcSettings {
  issuerUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  allowLoopbackHttp?: boolean
}

export interface Identity {
  issuer: string
  subject: string
  email?: string
  emailVerified: boolean
  displayName?: string
}

interface AuthorizationInput {
  state: string
  nonce: string
  codeVerifier: string
}

export interface AuthIdentityProvider {
  authorizationUrl(input: AuthorizationInput): Promise<string>
  exchange(input: AuthorizationInput & { callbackUrl: URL }): Promise<Identity>
}

/** The HTTP exception is for an explicitly configured local test provider only. */
function checkedUrl(value: string, allowLoopbackHttp: boolean): URL {
  if (value.length > 2048) throw new Error('OIDC_URL_INVALID')
  const url = new URL(value)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:'))
  ) {
    throw new Error('OIDC_URL_INVALID')
  }
  return url
}

function checkAuthorizationInput(input: AuthorizationInput): void {
  if (!input.state || !input.nonce || !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier)) {
    throw new Error('OIDC_AUTHORIZATION_CONTEXT_INVALID')
  }
}

export class OidcProvider implements AuthIdentityProvider {
  private readonly settings: OidcSettings
  private readonly allowLoopbackHttp: boolean
  private configuration?: Promise<oidc.Configuration>

  constructor(settings: OidcSettings) {
    this.settings = { ...settings }
    this.allowLoopbackHttp =
      settings.allowLoopbackHttp === true && process.env.NODE_ENV !== 'production'
    if (settings.allowLoopbackHttp === true && !this.allowLoopbackHttp) {
      throw new Error('OIDC_HTTP_TEST_ONLY')
    }
    const issuer = checkedUrl(settings.issuerUrl, this.allowLoopbackHttp)
    const redirect = checkedUrl(settings.redirectUri, this.allowLoopbackHttp)
    if (
      issuer.search ||
      issuer.pathname.includes('/.well-known/') ||
      redirect.search ||
      !settings.clientId.trim() ||
      !settings.clientSecret.trim()
    ) {
      throw new Error('OIDC_SETTINGS_INVALID')
    }
  }

  private async discover(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      this.configuration = oidc
        .discovery(
          new URL(this.settings.issuerUrl),
          this.settings.clientId,
          undefined,
          oidc.ClientSecretBasic(this.settings.clientSecret),
          {
            timeout: 10,
            execute: [
              oidc.enableNonRepudiationChecks,
              ...(this.allowLoopbackHttp ? [oidc.allowInsecureRequests] : []),
            ],
            [oidc.customFetch]: (url, options) => {
              checkedUrl(String(url), this.allowLoopbackHttp)
              const { body, ...fetchOptions } = options
              // Never follow a provider redirect carrying client authentication or a code.
              return fetch(url, {
                ...fetchOptions,
                ...(body === undefined
                  ? {}
                  : { body: body instanceof Uint8Array ? new Uint8Array(body).buffer : body }),
                redirect: 'error',
              })
            },
          },
        )
        .then((configuration) => {
          const metadata = configuration.serverMetadata()
          if (metadata.issuer !== this.settings.issuerUrl) throw new Error('OIDC_ISSUER_MISMATCH')
          for (const endpoint of [
            metadata.authorization_endpoint,
            metadata.token_endpoint,
            metadata.jwks_uri,
          ]) {
            if (!endpoint) throw new Error('OIDC_METADATA_INCOMPLETE')
            checkedUrl(endpoint, this.allowLoopbackHttp)
          }
          return configuration
        })
        .catch((error: unknown) => {
          // A temporary discovery outage must not poison this provider until restart.
          this.configuration = undefined
          throw error
        })
    }
    return this.configuration
  }

  async authorizationUrl(input: AuthorizationInput): Promise<string> {
    checkAuthorizationInput(input)
    const configuration = await this.discover()
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.settings.redirectUri,
      scope: 'openid profile email',
      response_type: 'code',
      state: input.state,
      nonce: input.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(input.codeVerifier),
      code_challenge_method: 'S256',
    }).href
  }

  async exchange(input: AuthorizationInput & { callbackUrl: URL }): Promise<Identity> {
    checkAuthorizationInput(input)
    const callback = new URL(input.callbackUrl)
    callback.search = ''
    if (callback.href !== new URL(this.settings.redirectUri).href) {
      throw new Error('OIDC_CALLBACK_MISMATCH')
    }
    const configuration = await this.discover()
    const tokens = await oidc.authorizationCodeGrant(configuration, input.callbackUrl, {
      expectedState: input.state,
      expectedNonce: input.nonce,
      pkceCodeVerifier: input.codeVerifier,
      idTokenExpected: true,
    })
    const claims = tokens.claims()
    if (
      !claims ||
      !claims.sub.trim() ||
      claims.sub.length > 2048 ||
      claims.iss.length > 2048 ||
      (typeof claims.email === 'string' && claims.email.length > 320) ||
      (typeof claims.name === 'string' && claims.name.length > 512)
    ) {
      throw new Error('OIDC_IDENTITY_INVALID')
    }
    // Provider roles and bearer tokens deliberately do not cross this boundary.
    return {
      issuer: claims.iss,
      subject: claims.sub,
      ...(typeof claims.email === 'string' && claims.email.length > 0
        ? { email: claims.email }
        : {}),
      emailVerified:
        claims.email_verified === true &&
        typeof claims.email === 'string' &&
        claims.email.length > 0,
      ...(typeof claims.name === 'string' && claims.name.length > 0
        ? { displayName: claims.name }
        : {}),
    }
  }
}
