import type { AppRole } from '../../server/xcs/auth/types'

export default defineNuxtRouteMiddleware(async (to) => {
  const role = to.meta.requiredRole
  if (!role) return
  const localePath = useLocalePath()
  if (!['admin', 'recipient', 'issuer', 'verifier'].includes(String(role))) {
    return navigateTo(localePath('/auth/not-authorized'))
  }
  const auth = useAuth()
  await auth.load()
  if (!auth.user.value) return navigateTo(localePath('/auth/login'))
  try {
    await auth.checkRole(role as AppRole)
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    if (status === 401) return navigateTo(localePath('/auth/login'))
    return navigateTo({
      path: localePath('/auth/not-authorized'),
      ...(status === 403 ? {} : { query: { reason: 'unavailable' } }),
    })
  }
})
