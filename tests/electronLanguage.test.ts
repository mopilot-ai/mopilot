// The interface language in main (electron/app/language.cjs): what it resolves, what a window and a menu read, and that
// a catalog that can't be read leaves the app in English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LANGUAGES } from '../shared/i18n/languages.mjs';

const require = createRequire(import.meta.url);
const { createLanguage, englishText, openLanguage, readCatalog } = require('../electron/app/language.cjs');

const language = (
  prefs: () => any,
  locales = ['en-US'],
  read: (tag: string) => Record<string, string> = (tag) => ({ Save: `${tag}:save`, 'Open {0}': `${tag}:{0}` }),
) => createLanguage({ prefs, systemLocales: () => locales, read });

test('a window reads the language the preference resolves to, and its messages', () => {
  assert.deepEqual(language(() => ({ interfaceLanguage: 'ja' })).snapshot(), {
    tag: 'ja',
    messages: { Save: 'ja:save', 'Open {0}': 'ja:{0}' },
  });
});

test('the `language` an older build saved means nothing here: it is a retired setting, and must not pin anyone to English', () => {
  assert.equal(language(() => ({ language: 'en' }), ['zh-CN']).snapshot().tag, 'zh-Hans');
});

test('the app reads the saved preference and the OS’s languages', () => {
  const app = { getPreferredSystemLanguages: () => ['ko-KR'] };
  assert.equal(openLanguage({ app, readState: () => ({}) }).snapshot().tag, 'ko');
  assert.equal(openLanguage({ app, readState: () => ({ prefs: { interfaceLanguage: 'fr' } }) }).snapshot().tag, 'fr');
});

test('with no preference saved yet it follows the OS', () => {
  assert.equal(language(() => undefined, ['zh-CN']).snapshot().tag, 'zh-Hans');
});

test('a menu label reads the catalog, fills holes and falls back to English', () => {
  const { t } = language(() => ({ interfaceLanguage: 'de' }));
  assert.equal(t('Save'), 'de:save');
  assert.equal(t('Open {0}', ['x']), 'de:x');
  assert.equal(t('Not in the catalog {0}', ['x']), 'Not in the catalog x');
  assert.equal(englishText('About {0}', ['App']), 'About App');
  assert.equal(englishText('About'), 'About');
});

test('refresh says whether the language changed, and only reads a catalog when it did', () => {
  let prefs = { interfaceLanguage: 'ko' };
  const reads: string[] = [];
  const l = language(
    () => prefs,
    ['en'],
    (tag) => (reads.push(tag), {}),
  );
  assert.equal(l.refresh(), true);
  assert.equal(l.refresh(), false);
  prefs = { interfaceLanguage: 'fr' };
  assert.equal(l.refresh(), true);
  assert.equal(l.snapshot().tag, 'fr');
  assert.deepEqual(reads, ['ko', 'fr']);
});

test('English has no catalog to read, every other language ships one, and an unreadable one is empty', () => {
  assert.deepEqual(readCatalog('en'), {});
  for (const { tag } of LANGUAGES.filter((l) => l.tag !== 'en')) assert.ok(Object.keys(readCatalog(tag)).length > 0, tag);
  assert.deepEqual(readCatalog('no-such-language'), {});
});
