import routerOptions from '#build/router.options.mjs'
import type { RouterOptions } from 'vue-router'
import { privateLinkHistoryState } from '~/utils/privateLinkHistory'

export default defineNuxtPlugin(() => {
  const router = useRouter()
  const generatedOptions = routerOptions as Pick<RouterOptions, 'scrollBehavior'>
  const defaultScrollBehavior = generatedOptions.scrollBehavior
  // Nuxt restores this generated options object after its initial navigation.
  // Updating only router.options is overwritten during hydration.
  generatedOptions.scrollBehavior = (to, from, savedPosition) => {
    // Invitation and presentation fragments are bearer tokens, not DOM selectors. Vue Router's
    // missing-selector warning would otherwise print the token to the console.
    if (/^\/(?:fr\/)?(?:recipient\/invitations|presentations)\/?$/.test(to.path)) {
      return savedPosition ?? { left: 0, top: 0 }
    }
    return defaultScrollBehavior?.(to, from, savedPosition)
  }
  router.options.scrollBehavior = generatedOptions.scrollBehavior
  router.afterEach(() => {
    // Router navigation can reintroduce the previous fragment in back/forward.
    // Preserve the live URL so the destination page can still consume its bearer.
    window.history.replaceState(privateLinkHistoryState(window.history.state), '')
  })
})
