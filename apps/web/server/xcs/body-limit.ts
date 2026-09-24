/**
 * Raised when a request body passes its route's limit. The numeric 4xx
 * `statusCode` is what `mapError`'s request-error branch shapes into the
 * response envelope.
 */
export class BodyTooLargeError extends Error {
  readonly statusCode = 413

  constructor() {
    super('Request body is too large')
    this.name = 'BodyTooLargeError'
  }
}

export interface BoundedBodySource extends AsyncIterable<Buffer | string> {
  destroy?: (error?: Error) => unknown
}

/**
 * Reads a request body while counting bytes, and stops as soon as the limit is
 * passed instead of buffering the whole request first. A chunked body, or one
 * whose `content-length` understates it, is therefore bounded by `limit` too:
 * reading stops at the first chunk that crosses it, so nothing beyond the limit
 * is ever held. The caller destroys the request once the 413 is on the wire,
 * which is what lets the client see the status instead of a reset connection.
 */
export async function readBoundedBody(
  source: BoundedBodySource,
  limit: number,
): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of source) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    total += buffer.length
    if (total > limit) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  return Buffer.concat(chunks).toString('utf8')
}

/** The cheap fast path: refuse a body whose declared length already exceeds the limit. */
export function assertDeclaredLength(contentLength: string | undefined, limit: number): void {
  const declared = Number(contentLength ?? '0')
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError()
}
