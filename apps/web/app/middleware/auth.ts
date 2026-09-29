export default defineNuxtRouteMiddleware(async () => {
  const auth = useAuth()
  await auth.load(true)
  if (!auth.user.value) return navigateTo(useLocalePath()('/auth/login'))
})
