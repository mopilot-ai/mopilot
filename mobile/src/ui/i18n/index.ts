// The phone UI's words: English and Simplified Chinese catalogs behind one keyed `t`, a language choice kept on the phone, and a hook that re-renders at once when the language changes.
import { useMemo, useSyncExternalStore } from 'react';
import type { TOptions } from 'i18next';
import { createMobileI18n } from '../../../vendor/orca/i18n/mobileI18n';
import en from './locales/en';

export type Locale = 'en' | 'zh-Hans';
/** What the Language row offers: follow the phone, or one language. */
export type Language = 'system' | Locale;
export const LANGUAGES: readonly Language[] = ['system', 'en', 'zh-Hans'];

/** Anything unreadable is System, so a bad store never forces a language. */
export const parseLanguage = (raw: string | null): Language => LANGUAGES.find((l) => l === raw) ?? 'system';

/** The language a phone's preferred-language tags ask for, first match wins: Simplified Chinese, else English (Traditional Chinese has no catalog, and English is not read as Simplified). */
export function resolveLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const [language, ...rest] = tag.toLowerCase().split(/[-_]/);
    if (language !== 'zh') {
      if (language === 'en') return 'en';
      continue;
    }
    const traditional = rest.includes('hant') || rest.some((part) => ['tw', 'hk', 'mo'].includes(part));
    return traditional ? 'en' : 'zh-Hans';
  }
  return 'en';
}

/** Keys the shown language lacked, in order, for development to read. */
export const missingKeys: string[] = [];

const core = createMobileI18n<Locale>({
  defaultLocale: 'en',
  defaultCatalog: en,
  importCatalog: () => import('./locales/zh-Hans').then((module) => module.default),
  onMissingKey: (key, locale) => {
    missingKeys.push(`${locale}:${key}`);
    if ((globalThis as { __DEV__?: boolean }).__DEV__ === true) console.warn(`[i18n] missing ${locale}:${key}`);
  },
});

/** The text of a key in the shown language, `{{name}}` filled from `options` (a `count` picks the plural form). */
export const t = (key: string, options?: TOptions): string => core.translate(key, options);

/** Show a language now: the catalog is read once, and every component using `useTranslation` draws again. */
export const showLocale = (locale: Locale): Promise<void> => core.activate(locale);
export const currentLocale = (): Locale => core.locale();
export const subscribeLanguage = core.subscribe;
export const setPseudoLocalization = core.setPseudoLocalization;
export const instance = core.instance;

/** Call in every component that draws text: it draws again when the language changes, and `t` changes identity with it. */
export function useTranslation(): { t: (key: string, options?: TOptions) => string; locale: Locale } {
  const revision = useSyncExternalStore(core.subscribe, core.revision);
  const locale = useSyncExternalStore(core.subscribe, core.locale);
  return useMemo(() => {
    // `t` is a new function with each language, so a memo or callback that lists it recomputes
    void revision;
    return { t: (key: string, options?: TOptions) => t(key, options), locale };
  }, [revision, locale]);
}

export interface LanguageControl {
  read(): Promise<Language>;
  /** Show and keep the choice; rejects when it could not be kept. */
  set(value: Language): Promise<void>;
}

/** The control over a string store and the phone's language tags (System follows them). */
export function createLanguage(o: {
  store: { read(): Promise<string | null>; write(value: string): Promise<void> };
  deviceTags(): readonly string[];
  show?(locale: Locale): Promise<void>;
}): LanguageControl {
  const show = (value: Language) => (o.show ?? showLocale)(value === 'system' ? resolveLocale(o.deviceTags()) : value);
  return {
    async read() {
      const value = parseLanguage(await o.store.read().catch(() => null));
      await show(value);
      return value;
    },
    async set(value) {
      await o.store.write(value);
      await show(value);
    },
  };
}
