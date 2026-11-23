// The interface language in main: resolves the preference, holds its catalog for the menus and hands it to each window (docs/i18n.md).
const fs = require('node:fs');
const path = require('node:path');
const { fillHoles, resolveLanguage } = require('../../shared/i18n/languages.mjs');
const { noteIgnored } = require('../ignored.cjs');

const LOCALES = path.join(__dirname, '../../shared/i18n/locales');

/** A language's messages. English is the source text, and a catalog that can't be read leaves the interface in English. */
function readCatalog(tag) {
  if (tag === 'en') return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES, `${tag}.json`), 'utf8'));
  } catch (error) {
    noteIgnored(`read the ${tag} interface language`, error);
    return {};
  }
}

/**
 * The lookup with no catalog: English, with its holes filled.
 * @param {string} text
 * @param {readonly unknown[]} [values]
 */
const englishText = (text, values = []) => fillHoles(text, values);

/**
 * @param {{ prefs: () => { interfaceLanguage?: unknown } | undefined, systemLocales: () => string[], read?: (tag: string) => Record<string, string> }} deps
 */
function createLanguage({ prefs, systemLocales, read = readCatalog }) {
  /** @type {string | null} */
  let tag = null;
  /** @type {Record<string, string>} */
  let messages = {};

  /** Follow the preference. @returns {boolean} whether the language changed */
  function refresh() {
    const next = resolveLanguage(prefs()?.interfaceLanguage, systemLocales());
    if (next === tag) return false;
    tag = next;
    messages = read(next);
    return true;
  }

  /** What a window shows itself in. */
  function snapshot() {
    if (tag === null) refresh();
    return { tag, messages };
  }

  /**
   * The current language's text for an English string, which is also the fallback.
   * @param {string} text
   * @param {readonly unknown[]} [values] what fills its `{0}` holes
   */
  function t(text, values) {
    return englishText(Object.hasOwn(snapshot().messages, text) ? messages[text] : text, values);
  }

  return { refresh, snapshot, t };
}

/** The app's language: the saved preference over the OS's languages. @param {{ app: Electron.App, readState: () => { prefs?: { interfaceLanguage?: unknown } } }} deps */
const openLanguage = ({ app, readState }) =>
  createLanguage({ prefs: () => readState().prefs, systemLocales: () => app.getPreferredSystemLanguages() });

module.exports = { createLanguage, englishText, openLanguage, readCatalog };
