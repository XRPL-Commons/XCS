/** Preserve router indices and unrelated state while removing bearer route fragments. */
export function privateLinkHistoryState(state: unknown): unknown {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return state
  const sanitized = { ...(state as Record<string, unknown>) }
  for (const key of ['current', 'back', 'forward']) {
    const value = sanitized[key]
    if (typeof value !== 'string') continue
    const hash = value.indexOf('#')
    if (hash === -1) continue
    const destination = value.slice(0, hash)
    const pathname = destination.split('?')[0] ?? ''
    if (/^\/(?:fr\/)?(?:presentations|recipient\/invitations)\/?$/.test(pathname))
      sanitized[key] = destination
  }
  return sanitized
}

export function purgePrivateLinkFragment(): void {
  window.history.replaceState(
    privateLinkHistoryState(window.history.state),
    '',
    window.location.pathname + window.location.search,
  )
}
