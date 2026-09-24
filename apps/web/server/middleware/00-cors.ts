import { isApiPath } from '../utils/apiPaths'
import type { XcsApiContext } from '../xcs/context'

export default defineEventHandler((event) => {
  if (!isApiPath(event.path)) return
  const { config } = event.context.xcs as XcsApiContext
  // `handleCors` answers a preflight itself and returns true; for a simple
  // request it only appends the allow headers for an explicitly listed origin.
  handleCors(event, {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: false,
    preflight: { statusCode: 204 },
  })
})
