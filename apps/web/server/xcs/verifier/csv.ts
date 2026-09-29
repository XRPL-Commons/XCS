import type { VerifierHistoryEntry } from './types'

function cell(value: string): string {
  // Spreadsheet applications may ignore leading whitespace before a formula.
  const safe = /^[\s\uFEFF]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

export function historyCsv(history: VerifierHistoryEntry[]): string {
  const columns = [
    'id',
    'organizationId',
    'presentationId',
    'profileId',
    'generationId',
    'scope',
    'checkedAt',
    'onChain',
    'schema',
    'payload',
    'issuerTrust',
  ]
  return [
    columns.map(cell).join(','),
    ...history.map((entry) =>
      [
        entry.id,
        entry.organizationId,
        entry.presentationId,
        entry.profileId,
        entry.generationId,
        entry.scope,
        entry.checkedAt,
        entry.verification.onChain,
        entry.verification.schema,
        entry.verification.payload,
        entry.verification.issuerTrust,
      ]
        .map(cell)
        .join(','),
    ),
    '',
  ].join('\r\n')
}
