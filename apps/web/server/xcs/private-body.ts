// Private account APIs retain bounded JSON parsing for Node and Nitro in-process bodies.
import { getHeader, type H3Event } from 'h3'
class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export async function readJsonBody(event: H3Event, maxBytes: number): Promise<unknown> {
  const contentType = getHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new RequestError(415, 'Unsupported Media Type')
  }
  const declaredLength = Number(getHeader(event, 'content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestError(413, 'Request body is too large')
  }
  // Nitro localFetch supplies req.body directly; the Web adapter supplies a Web stream.
  // Neither emits Node request stream events, unlike an external HTTP request.
  const requestWithBody = event.node.req as typeof event.node.req & {
    body?: unknown
    rawBody?: unknown
    [key: symbol]: unknown
  }
  const suppliedBody: unknown = await (event._requestBody ??
    event.web?.request?.body ??
    requestWithBody[Symbol.for('h3RawBody')] ??
    requestWithBody.rawBody ??
    requestWithBody.body)
  const bytes =
    suppliedBody !== undefined && suppliedBody !== null
      ? await readSuppliedBody(suppliedBody, maxBytes)
      : await new Promise<Buffer>((resolve, reject) => {
          const request = event.node.req
          if (request.readableEnded) {
            reject(new RequestError(400, 'Invalid JSON body'))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          const cleanup = () => {
            request.off('data', onData)
            request.off('end', onEnd)
            request.off('error', onError)
            request.off('aborted', onAborted)
          }
          const onError = (error: Error) => {
            cleanup()
            reject(error)
          }
          const onAborted = () => onError(new RequestError(400, 'Request body was interrupted'))
          const onEnd = () => {
            cleanup()
            resolve(Buffer.concat(chunks, size))
          }
          const onData = (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += buffer.length
            if (size > maxBytes) {
              cleanup()
              // Drain without retaining bytes; destroying the socket would hide the 413 response.
              request.resume()
              reject(new RequestError(413, 'Request body is too large'))
              return
            }
            chunks.push(buffer)
          }
          request.on('data', onData)
          request.once('end', onEnd)
          request.once('error', onError)
          request.once('aborted', onAborted)
        })
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new RequestError(400, 'Invalid JSON body')
  }
}

async function readSuppliedBody(body: unknown, maxBytes: number): Promise<Buffer> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        size += chunk.length
        if (size > maxBytes) {
          await reader.cancel()
          throw new RequestError(413, 'Request body is too large')
        }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks, size)
    } finally {
      reader.releaseLock()
    }
  }
  const bytes =
    typeof body === 'string' || body instanceof Uint8Array
      ? Buffer.from(body)
      : Buffer.from(JSON.stringify(body))
  if (bytes.length > maxBytes) throw new RequestError(413, 'Request body is too large')
  return bytes
}
