import type { H3Event } from 'h3'

/**
 * True when the event was produced by Nitro's in-process `localFetch` rather
 * than by a socket. Server rendering calls the read API through `$fetch`, which
 * Nitro serves in process; such a call crosses no network and is already
 * accounted for by the page request that spawned it.
 *
 * The signal is structural, never client-controlled. Nitro builds the synthetic
 * request with `node-mock-http`, whose objects carry an own `__unenv__` property
 * that a real `node:http.IncomingMessage` never has; request headers land in
 * `req.headers` and cannot add a property to the request object itself. A
 * missing request or socket is treated the same way, for a runtime that has no
 * Node request at all.
 */
export function isInProcessRequest(event: Pick<H3Event, 'node'>): boolean {
  const request = event.node?.req as (typeof event.node)['req'] | undefined
  if (request === undefined || request.socket === undefined) return true
  return Object.prototype.hasOwnProperty.call(request, '__unenv__')
}
