import { en, fr } from '@nuxt/ui/locale'

/** Nuxt UI component strings follow the site locale managed by @nuxtjs/i18n. */
export function useUiLocale() {
  const { locale } = useI18n()
  return computed(() => (locale.value === 'en' ? en : fr))
}
