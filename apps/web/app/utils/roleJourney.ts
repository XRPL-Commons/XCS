import { walletReturnPath } from './portalRoutes'

/** Backward-compatible name for the recipient wallet onboarding return. */
export function walletLinkReturnPath(value: unknown, locale: string): string {
  return walletReturnPath(value, locale)
}

/** Keep the guided picker aligned with the existing supported ownership proof schemes. */
export function supportsWalletLinkProof(walletId: string): boolean {
  return ['gemwallet', 'metamask-snap', 'otsu'].includes(walletId)
}
