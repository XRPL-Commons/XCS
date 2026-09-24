import { apiRouteNotFound } from '../utils/dispatch'

// The bare prefix carries no route of its own; `isApiPath` still claims it, so
// it answers with the API's JSON 404 envelope rather than a rendered page.
export default defineEventHandler((event) => apiRouteNotFound(event))
