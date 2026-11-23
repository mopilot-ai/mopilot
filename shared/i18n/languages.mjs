// The interface languages: the ones Claude Code documents itself in, and which of them a preference or an OS locale means (docs/i18n.md).

/** What the language preference holds to follow the OS. */
export const SYSTEM_LANGUAGE = 'system';

/** @typedef {{ tag: string, name: string }} InterfaceLanguage */
const TAGS = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de', 'it', 'pt-BR', 'ru', 'id'];

/** What a language calls itself, from the runtime's locale data: Spanish writes its own name in lower case. */
function ownName(tag) {
  const name = /** @type {string} */ (new Intl.DisplayNames([tag], { type: 'language' }).of(tag));
  return name[0].toLocaleUpperCase(tag) + name.slice(1);
}

/** Each in its own language, so someone who can't read the current one still finds theirs. @type {InterfaceLanguage[]} */
export const LANGUAGES = TAGS.map((tag) => ({ tag, name: ownName(tag) }));

/** A hole in a message: `{0}` is the first value it takes. */
export const HOLE = /\{(\d+)\}/g;

/**
 * Put values into a message's holes. A hole with no value stays as written.
 * @param {string} message
 * @param {readonly unknown[]} values
 */
export const fillHoles = (message, values) =>
  message.replace(HOLE, (hole, i) => (Number(i) < values.length ? String(values[Number(i)]) : hole));

const known = (tag) => LANGUAGES.some((language) => language.tag === tag);

/**
 * The interface language closest to one OS locale, or null. Chinese splits by script, then by region; the rest by language.
 * Packaging keeps the Chromium locales this serves (scripts/chromium-locales.mjs).
 * @param {string} locale
 * @returns {string | null}
 */
export function languageOfLocale(locale) {
  const tag = locale.toLowerCase().replaceAll('_', '-');
  const [base] = tag.split('-');
  if (base === 'zh') return !/-hans\b/.test(tag) && /-(hant|tw|hk|mo)\b/.test(tag) ? 'zh-Hant' : 'zh-Hans';
  if (base === 'pt') return 'pt-BR';
  return known(base) ? base : null;
}

/**
 * The language the interface shows.
 * @param {unknown} preference the saved preference: a language's tag, or anything else to follow the OS
 * @param {readonly string[]} systemLocales the OS's languages, most preferred first
 * @returns {string} a tag from {@link LANGUAGES}
 */
export function resolveLanguage(preference, systemLocales) {
  if (typeof preference === 'string' && known(preference)) return preference;
  for (const locale of systemLocales) {
    const language = languageOfLocale(locale);
    if (language) return language;
  }
  return 'en';
}
