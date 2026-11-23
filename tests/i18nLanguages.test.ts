// Which interface language a preference and the OS mean (shared/i18n/languages.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillHoles, LANGUAGES, resolveLanguage, SYSTEM_LANGUAGE } from '../shared/i18n/languages.mjs';

test('the languages are the ones Claude Code documents itself in', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.tag).sort(), [
    'de',
    'en',
    'es',
    'fr',
    'id',
    'it',
    'ja',
    'ko',
    'pt-BR',
    'ru',
    'zh-Hans',
    'zh-Hant',
  ]);
});

test('a chosen language wins over the OS', () => {
  assert.equal(resolveLanguage('ja', ['zh-CN']), 'ja');
  assert.equal(resolveLanguage('en', ['zh-CN']), 'en');
});

test('following the OS, the first language the app has wins', () => {
  const cases: [string[], string][] = [
    [['zh-Hans-CN'], 'zh-Hans'],
    [['zh-CN'], 'zh-Hans'],
    [['zh'], 'zh-Hans'],
    [['zh-Hant-TW'], 'zh-Hant'],
    [['zh-TW'], 'zh-Hant'],
    [['zh_HK'], 'zh-Hant'],
    [['zh-Hans-HK'], 'zh-Hans'],
    [['zh-Hans-TW'], 'zh-Hans'],
    [['zh-Hans-MO'], 'zh-Hans'],
    [['zh-MO'], 'zh-Hant'],
    [['pt-PT'], 'pt-BR'],
    [['pt-BR'], 'pt-BR'],
    [['fr-CA'], 'fr'],
    [['de_AT'], 'de'],
    [['nl-NL', 'id-ID', 'en-US'], 'id'],
    [['en-GB', 'ja-JP'], 'en'],
    [['nl-NL'], 'en'],
    [[], 'en'],
  ];
  for (const [locales, expected] of cases) assert.equal(resolveLanguage(SYSTEM_LANGUAGE, locales), expected, locales.join());
});

test('a preference that names no language follows the OS, as an old or damaged one must', () => {
  for (const preference of [undefined, null, 7, 'klingon']) assert.equal(resolveLanguage(preference, ['ko-KR']), 'ko');
});

test('holes fill by number, and a hole without a value stays', () => {
  assert.equal(fillHoles('{1} then {0} then {2}', ['a', 1]), '1 then a then {2}');
});

test('the preference keeps a name of its own: `language` is a retired setting that every boot deletes', async () => {
  const { DEFAULT_PREFS, loadPrefs } = await import('../src/store/types.ts');
  assert.equal(DEFAULT_PREFS.interfaceLanguage, SYSTEM_LANGUAGE);
  assert.equal(loadPrefs({ interfaceLanguage: 'ja' }).interfaceLanguage, 'ja');
});
