import { buildOpenApiDocument } from '../../xcs/openapi'

/** The OpenAPI 3.1 description of the read API, built from the route table. */
export default defineEventHandler((event) => {
  const routes = event.context.xcs.handlers.routes
  setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  return buildOpenApiDocument(routes, useRuntimeConfig(event).apiVersion)
})
