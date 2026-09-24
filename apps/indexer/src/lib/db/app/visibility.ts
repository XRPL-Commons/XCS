// Copied from packages/db/src/app/visibility.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { and, eq, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { XcsDatabase } from '../client.js'
import {
  appCredentialMetadata,
  appOrganizationApplications,
  appOrganizations,
  appPresentations,
  appUsers,
} from '#db/schema/app/index.js'
import { hashAppToken } from './tokens.js'

export interface CredentialAccess {
  scope: 'public' | 'full'
  publicFields: string[]
}

/** All authorization facts are read together, never accepted as request-supplied roles/approvals. */
export async function getCredentialAccess(
  db: XcsDatabase,
  input: {
    profileId: string
    generationId: string
    viewerUserId: string | null
    presentationToken?: string
  },
): Promise<CredentialAccess | null> {
  const issuer = alias(appOrganizations, 'issuer_organization')
  const verifier = alias(appOrganizations, 'verifier_organization')
  const tokenHash =
    input.presentationToken === undefined ? null : hashAppToken(input.presentationToken)

  const [row] = await db
    .select({
      visibility: appCredentialMetadata.visibility,
      publicFields: appCredentialMetadata.publicFields,
      viewerId: appUsers.id,
      recipientUserId: appCredentialMetadata.recipientUserId,
      issuerResponsibleUserId: issuer.responsibleUserId,
      issuerStatus: issuer.status,
      verifierResponsibleUserId: verifier.responsibleUserId,
      verifierStatus: verifier.status,
      verifierApproval: appOrganizationApplications.status,
    })
    .from(appCredentialMetadata)
    .leftJoin(
      appUsers,
      input.viewerUserId === null
        ? sql`FALSE`
        : and(eq(appUsers.id, input.viewerUserId), eq(appUsers.status, 'active')),
    )
    .leftJoin(issuer, eq(issuer.id, appCredentialMetadata.issuerOrganizationId))
    .leftJoin(
      appPresentations,
      tokenHash === null
        ? sql`FALSE`
        : and(
            eq(appPresentations.tokenHash, tokenHash),
            eq(appPresentations.profileId, appCredentialMetadata.profileId),
            eq(appPresentations.generationId, appCredentialMetadata.generationId),
            eq(appPresentations.recipientUserId, appCredentialMetadata.recipientUserId),
            eq(appPresentations.scope, 'full'),
            isNull(appPresentations.revokedAt),
          ),
    )
    .leftJoin(verifier, eq(verifier.id, appPresentations.verifierOrganizationId))
    .leftJoin(
      appOrganizationApplications,
      and(
        eq(appOrganizationApplications.organizationId, verifier.id),
        eq(appOrganizationApplications.role, 'verifier'),
      ),
    )
    .where(
      and(
        eq(appCredentialMetadata.profileId, input.profileId),
        eq(appCredentialMetadata.generationId, input.generationId),
      ),
    )
  if (!row) return null

  const isOwner =
    row.viewerId !== null &&
    (row.viewerId === row.recipientUserId ||
      (row.viewerId === row.issuerResponsibleUserId && row.issuerStatus === 'active'))
  const isAuthorizedVerifier =
    row.viewerId !== null &&
    row.viewerId === row.verifierResponsibleUserId &&
    row.verifierStatus === 'active' &&
    row.verifierApproval === 'approved'
  return {
    scope: row.visibility === 'public' || isOwner || isAuthorizedVerifier ? 'full' : 'public',
    publicFields: row.publicFields,
  }
}

export type ClaimValue =
  null | boolean | number | string | ClaimValue[] | { [key: string]: ClaimValue }
export type Claims = { [key: string]: ClaimValue }

interface Selection {
  whole: boolean
  children: Map<string, Selection>
}

/** RFC 6901 pointers relative to claims. Objects can be narrowed; arrays are atomic fields. */
export function validatePublicFields(paths: readonly string[]): void {
  selection(paths)
}

function selection(paths: readonly string[]): Selection {
  if (!Array.isArray(paths) || paths.length > 256) throw new Error('INVALID_PUBLIC_FIELDS')
  const root: Selection = { whole: false, children: new Map() }
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > 1024 ||
      /~(?![01])/u.test(path)
    ) {
      throw new Error('INVALID_PUBLIC_FIELD_PATH')
    }
    const parts = path
      .slice(1)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    if (
      parts.length > 32 ||
      parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))
    ) {
      throw new Error('INVALID_PUBLIC_FIELD_PATH')
    }
    let node = root
    for (const part of parts) {
      let child = node.children.get(part)
      if (!child) {
        child = { whole: false, children: new Map() }
        node.children.set(part, child)
      }
      node = child
    }
    node.whole = true
  }
  return root
}

function project(source: Claims, node: Selection): Claims {
  const result: Claims = {}
  for (const [key, child] of node.children) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]!
    if (child.whole) {
      result[key] = structuredClone(value)
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = project(value, child)
      if (Object.keys(nested).length > 0) result[key] = nested
    }
  }
  return result
}

/** Return only claims, never spread a private payload envelope into a public response. */
export function filterCredentialClaims(claims: Claims, access: CredentialAccess): Claims {
  if (access.scope === 'full') return structuredClone(claims)
  if (access.scope !== 'public') throw new Error('INVALID_CREDENTIAL_ACCESS')
  return project(claims, selection(access.publicFields))
}
