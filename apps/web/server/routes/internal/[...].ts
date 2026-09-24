import { apiRouteNotFound } from '../../utils/dispatch'

// The read API owns this prefix: a path under it that no adapter registers
// answers with the API's JSON 404 envelope rather than a rendered page.
export default defineEventHandler((event) => apiRouteNotFound(event))
