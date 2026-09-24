export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:response', (response) => {
    // A cached SSR document would reuse its public CSP nonce across clients.
    // Static /_nuxt assets bypass this render hook and keep immutable caching, as
    // do the read API's server routes: `render:response` fires for the page
    // renderer only, so a `/v1` reply keeps whatever `cache-control` its handler
    // set.
    response.headers['cache-control'] = 'private, no-store'
  })
})
