#!/usr/bin/env node
// Configuration-only checks: no images are built and no containers are started.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Never inherit an operator's .env or application secrets into a rendered fixture.
const fixture = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(XCS_|NUXT_|COMPOSE_)/.test(key)),
)
Object.assign(fixture, {
  COMPOSE_PROJECT_NAME: 'xcs-config-validation',
  XCS_AUTH_ORIGIN: 'https://xcs.invalid',
  XCS_IDENTITY_CLIENT_ID: 'compose-fixture-client',
  XCS_IDENTITY_CLIENT_SECRET: 'compose-fixture-identity-secret',
  XCS_ADMIN_DOCUMENT_KEY: 'compose-fixture-document-signing-key-00001',
  XCS_PUBLIC_PAYLOAD_BASE_URL: 'https://xcs.invalid',
  XCS_PAYLOAD_STORAGE_IP_HASH_SECRET: 'compose-fixture-payload-hashing-key-00001',
  XCS_HOSTED_PAYLOAD_NETWORKS: 'xrpl-testnet-xcs-v0.1',
  XCS_GRAFANA_ADMIN_PASSWORD: 'compose-fixture-grafana-password',
})
fixture.XCS_POSTGRES_ADMIN_PASSWORD = 'compose-fixture-admin-password-00001'

function check(condition, label) {
  assert.ok(condition, label)
}
function role(environment, variable, expected) {
  const url = new URL(environment[variable])
  check(
    url.protocol === 'postgres:' &&
      url.hostname === 'postgres' &&
      url.port === '5432' &&
      url.pathname === '/xcs' &&
      url.username === expected &&
      Boolean(url.password),
    `${variable} must use the dedicated ${expected} pool`,
  )
}

for (const app of ['web', 'indexer']) {
  const manifest = JSON.parse(readFileSync(`apps/${app}/package.json`, 'utf8'))
  for (const dependencies of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
  ]) {
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      check(
        !name.startsWith('@xcs-protocol/') && !/^(workspace:|link:|file:)/.test(version),
        `${app} must resolve its dependencies independently`,
      )
    }
  }
}

// The notifier and bootstrap are deliberately thin runtime images compiled from
// the web and indexer applications. They have their own Dockerfiles and contracts,
// but no duplicate package manifest that could drift from the owning application.
for (const app of ['web', 'indexer', 'notifier', 'db-bootstrap']) {
  const dockerfile = readFileSync(`apps/${app}/Dockerfile`, 'utf8')
  check(
    !/^COPY\s+(?:--\S+\s+)*(?:\.\s|packages\b|pnpm-workspace\.yaml\b|package\.json\b|pnpm-lock\.yaml\b)/m.test(
      dockerfile,
    ),
    `${app} must not copy the root workspace into its image`,
  )
  check(/^USER node$/m.test(dockerfile), `${app} must run as node`)
}

let rendered = 0
for (const application of [false, true]) {
  for (const hosted of [false, true]) {
    for (const development of [false, true]) {
      for (const profiles of [
        [],
        ['monitoring'],
        ['demo-pinning'],
        ['monitoring', 'demo-pinning'],
      ]) {
        const args = ['compose', '--env-file', '/dev/null', '-f', 'docker-compose.yml']
        if (application) args.push('-f', 'docker-compose.application.yml')
        if (hosted) args.push('-f', 'docker-compose.hosted-payloads.yml')
        if (development) args.push('-f', 'docker-compose.dev.yml')
        for (const profile of profiles) args.push('--profile', profile)
        const config = JSON.parse(
          execFileSync('docker', [...args, 'config', '--format', 'json'], {
            env: fixture,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        )
        const services = config.services
        const expected = ['db-bootstrap', 'indexer', 'postgres', 'web']
        if (application) expected.push('admin-notifier', 'mailpit')
        if (profiles.includes('monitoring'))
          expected.push('prometheus', 'grafana', 'postgres-exporter', 'node-exporter')
        if (profiles.includes('demo-pinning')) expected.push('ipfs')
        assert.deepEqual(Object.keys(services).sort(), expected.sort())
        check(config.networks.database.internal === true, 'database network must be internal')
        check(config.networks.monitoring.internal === true, 'monitoring network must be internal')
        role(services.web.environment, 'XCS_DATABASE_URL', 'xcs_api')
        if (hosted) role(services.web.environment, 'XCS_PAYLOAD_DATABASE_URL', 'xcs_payload_writer')
        role(services.indexer.environment, 'XCS_INDEXER_DATABASE_URL', 'xcs_indexer')
        role(services['db-bootstrap'].environment, 'XCS_BOOTSTRAP_DATABASE_URL', 'xcs_admin')
        for (const name of ['web', 'indexer']) {
          check(
            services[name].build.context === resolve('.'),
            `${name} build context must be the repository root`,
          )
          check(
            services[name].build.dockerfile === `apps/${name}/Dockerfile`,
            `${name} must build its own Dockerfile`,
          )
          check(services[name].read_only === true, `${name} must retain read-only root filesystem`)
        }
        check(
          services['db-bootstrap'].image === services.indexer.image,
          'bootstrap must reuse the indexer image',
        )
        for (const [name, service] of Object.entries(services)) {
          check(!service.image.endsWith(':latest'), `${name} image must be pinned`)
          for (const port of service.ports ?? []) {
            check(port.host_ip === '127.0.0.1', `${name} published ports must be loopback only`)
            check(
              name === 'web' ||
                (application && name === 'mailpit') ||
                (development && ['postgres', 'prometheus', 'grafana', 'ipfs'].includes(name)),
              `${name} must not expose a port in this overlay`,
            )
          }
          if (name !== 'web')
            check(
              !(service.volumes ?? []).some((volume) => volume.source === 'xcs-review-documents'),
              `${name} must not mount private issuer documents`,
            )
          if (name !== 'web')
            check(
              !service.environment?.NUXT_ISSUER_DATABASE_URL,
              `${name} must not receive the issuer pool`,
            )
        }
        if (application) {
          const environment = services.web.environment
          check(
            environment.XCS_AUTH_ORIGIN === fixture.XCS_AUTH_ORIGIN &&
              environment.XCS_IDENTITY_CLIENT_ID === fixture.XCS_IDENTITY_CLIENT_ID &&
              Boolean(environment.XCS_IDENTITY_CLIENT_SECRET),
            'application overlay must supply the complete authentication contract',
          )
          role(environment, 'NUXT_APP_DATABASE_URL', 'xcs_app')
          role(environment, 'NUXT_ADMIN_DATABASE_URL', 'xcs_admin_app')
          role(environment, 'NUXT_ISSUER_DATABASE_URL', 'xcs_issuer')
          role(services['admin-notifier'].environment, 'XCS_NOTIFIER_DATABASE_URL', 'xcs_notifier')
          check(
            config.networks['application-mail'].internal === true,
            'SMTP network must be internal',
          )
          check(
            !services.mailpit.networks.database && !services.mailpit.networks.edge,
            'Mailpit must not join database or edge',
          )
          check(!services['admin-notifier'].networks.edge, 'notifier must not join edge')
          check(
            services['admin-notifier'].build.dockerfile === 'apps/notifier/Dockerfile',
            'notifier must use its standalone image',
          )
          check(
            services['admin-notifier'].user === 'node' &&
              services['admin-notifier'].read_only === true,
            'notifier must retain node user and read-only filesystem',
          )
          check(
            environment.XCS_DOCUMENT_STORAGE_DRIVER === 'filesystem' &&
              environment.XCS_DOCUMENT_FILESYSTEM_DIRECTORY === '/var/lib/xcs-review' &&
              environment.XCS_DOCUMENT_FILESYSTEM_LOCAL === '1',
            'reviewers and issuers must share the private document directory',
          )
          const documents = services.web.volumes.find(
            (volume) => volume.target === '/var/lib/xcs-review',
          )
          check(
            documents?.type === 'volume' &&
              documents.source === 'xcs-review-documents' &&
              !documents.read_only,
            'private documents must use the durable writable named volume',
          )
        } else {
          check(
            !services.web.environment.NUXT_APP_DATABASE_URL &&
              !services.web.environment.NUXT_ADMIN_DATABASE_URL &&
              !services.web.environment.NUXT_ISSUER_DATABASE_URL,
            'base stack must not enable private application pools',
          )
        }
        if (hosted) {
          check(
            services.web.environment.XCS_PUBLIC_PAYLOAD_BASE_URL ===
              fixture.XCS_PUBLIC_PAYLOAD_BASE_URL,
            'hosted payload origin must be explicit',
          )
          check(
            services.web.environment.XCS_PAYLOAD_STORAGE_IP_HASH_SECRET ===
              fixture.XCS_PAYLOAD_STORAGE_IP_HASH_SECRET &&
              services.web.environment.XCS_HOSTED_PAYLOAD_NETWORKS ===
                fixture.XCS_HOSTED_PAYLOAD_NETWORKS,
            'public payload quota secret and network allowlist must be explicit',
          )
        } else {
          check(
            !services.web.environment.XCS_PUBLIC_PAYLOAD_BASE_URL,
            'base stack must keep hosted publishing disabled',
          )
          check(
            !services.web.environment.XCS_PAYLOAD_DATABASE_URL,
            'base stack must not receive the payload writer pool',
          )
        }
        rendered += 1
      }
    }
  }
}
console.log(
  `Compose overlays validated: ${rendered} configurations; standalone images, private pools, networks and volumes.`,
)
