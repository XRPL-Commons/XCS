/** The account wallet step may return only to the recipient workspace. */
export function walletLinkReturnPath(value: unknown, locale: string): string {
  if (value === '/recipient' || value === '/fr/recipient') return value
  return locale === 'fr' ? '/fr/recipient' : '/recipient'
}

/** Keep the guided picker aligned with the existing supported ownership proof schemes. */
export function supportsWalletLinkProof(walletId: string): boolean {
  return ['gemwallet', 'metamask-snap', 'otsu'].includes(walletId)
}
