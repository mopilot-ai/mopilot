import i18next, { type i18n, type TOptions } from 'i18next'
import { pseudoLocalizeString } from './pseudoLocalization'
import { resolvePluralFamilyKey } from './pluralFamily'

export type Translate = (key: string, options?: TOptions) => string
export type CatalogSource = Readonly<Record<string, unknown>>

export type MobileI18nConfig<Locale extends string> = {
  defaultLocale: Locale
  /** The default language's catalog, bundled: the first frame never waits for a language. */
  defaultCatalog: CatalogSource
  /** Another language's catalog, read when that language is first chosen. */
  importCatalog: (locale: Locale) => Promise<CatalogSource>
  /** A key the shown language lacks (it is shown in the default language, or as the key itself when that lacks it too). */
  onMissingKey?: (key: string, locale: string) => void
}

// One i18next instance per app. Text is keyed: the catalog is the only place a word lives, so a call has no inline fallback.
export function createMobileI18n<Locale extends string>(config: MobileI18nConfig<Locale>) {
  const { defaultLocale } = config
  const instance: i18n = i18next.createInstance()

  void instance.init({
    lng: defaultLocale,
    fallbackLng: defaultLocale,
    initAsync: false,
    resources: { [defaultLocale]: { translation: config.defaultCatalog } },
    partialBundledLanguages: true,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    saveMissing: true,
    missingKeyHandler: (lngs, _namespace, key) => config.onMissingKey?.(key, lngs[0])
  })

  let activeLocale: Locale = defaultLocale
  let pseudoLocalization = false
  let revision = 0
  const listeners = new Set<() => void>()

  // Bounded: re-rendered chrome resolves the same option-free strings repeatedly between language changes.
  const PLAIN_TRANSLATION_CACHE_LIMIT = 4000
  const plainTranslations = new Map<string, string>()

  function publish(): void {
    revision += 1
    plainTranslations.clear()
    for (const listener of listeners) {
      listener()
    }
  }

  function translateUncached(key: string, options?: TOptions): string {
    const resolved = resolvePluralFamilyKey(key, options)
    // a language that lacks the key shows the default language's text, and the gap is reported
    if (activeLocale !== defaultLocale && !instance.exists(resolved, { ...options, lng: activeLocale, fallbackLng: false })) {
      config.onMissingKey?.(key, activeLocale)
    }
    const value = instance.t(resolved, {
      ...options,
      // Catalog text never nests keys; interpolated values must not either.
      nest: false
    })
    return pseudoLocalization ? pseudoLocalizeString(value, { expand: true }) : value
  }

  const translate: Translate = (key, options) => {
    if (options !== undefined) {
      return translateUncached(key, options)
    }
    const cached = plainTranslations.get(key)
    if (cached !== undefined) {
      return cached
    }
    const value = translateUncached(key)
    if (plainTranslations.size >= PLAIN_TRANSLATION_CACHE_LIMIT) {
      plainTranslations.clear()
    }
    plainTranslations.set(key, value)
    return value
  }

  let activationRequest = 0

  // Latest request wins: an older catalog import that settles later must not replace a newer choice.
  async function activate(locale: Locale): Promise<void> {
    const request = ++activationRequest
    try {
      if (locale !== defaultLocale && !instance.hasResourceBundle(locale, 'translation')) {
        const catalog = await config.importCatalog(locale)
        if (!instance.hasResourceBundle(locale, 'translation')) {
          instance.addResourceBundle(locale, 'translation', catalog, false, true, { skipCopy: true })
        }
      }
      if (request !== activationRequest) {
        return
      }
      await instance.changeLanguage(locale)
      if (request !== activationRequest) {
        return
      }
      activeLocale = locale
    } catch (error) {
      if (request !== activationRequest) {
        return
      }
      console.warn('[i18n] Falling back to the default language', error)
      await instance.changeLanguage(defaultLocale)
      activeLocale = defaultLocale
    }
    publish()
  }

  return {
    instance,
    translate,
    activate,
    locale: (): Locale => activeLocale,
    revision: (): number => revision,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    // Development-only layout check: accents and pads every string so clipping shows on device.
    setPseudoLocalization(enabled: boolean): void {
      if (pseudoLocalization !== enabled) {
        pseudoLocalization = enabled
        publish()
      }
    },
    isPseudoLocalization: (): boolean => pseudoLocalization
  }
}
