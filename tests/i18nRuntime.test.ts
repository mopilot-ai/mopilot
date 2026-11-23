// The lookups the build's wrapped strings call (src/lib/i18n.ts): a catalog, its holes, and English as the fallback.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { window } from './support/dom.ts';
import { __t, __tj, installLanguage, t } from '../src/lib/i18n.ts';

afterEach(() => installLanguage({ tag: 'en', messages: {} }));

test('the renamed app label still reads its German translation from the shipped catalog', () => {
  const messages = JSON.parse(readFileSync(new URL('../shared/i18n/locales/de.json', import.meta.url), 'utf8'));
  installLanguage({ tag: 'de', messages });
  assert.equal(__t('Quit MoPilot?'), 'MoPilot beenden?');
});

test('a message reads its translation, and one the catalog lacks reads as written', () => {
  installLanguage({ tag: 'zh-Hans', messages: { Save: '保存' } });
  assert.equal(__t('Save'), '保存');
  assert.equal(__t('Not translated yet'), 'Not translated yet');
  assert.equal(t, __t);
});

test('a name a plain object inherits is not a translation', () => {
  installLanguage({ tag: 'zh-Hans', messages: {} });
  assert.equal(__t('constructor'), 'constructor');
});

test('holes take their values in the translation’s order, and text that holds braces is left alone', () => {
  installLanguage({ tag: 'ja', messages: { 'Move {0} to {1}': '{1} に {0} を移動' } });
  assert.equal(__t('Move {0} to {1}', ['a', 'b']), 'b に a を移動');
  assert.equal(__t('Only {0} and {1}', ['one']), 'Only one and {1}');
  assert.equal(__t('Literal {0}'), 'Literal {0}');
});

test('a sentence keeps elements as elements, in the translation’s order', () => {
  installLanguage({ tag: 'zh-Hans', messages: { 'Open {0} in {1}': '在 {1} 中打开 {0}' } });
  const node = __tj('Open {0} in {1}', [createElement('b', { key: 'x' }, 'file'), 'Chrome']);
  assert.equal(renderToStaticMarkup(node as any), '在 Chrome 中打开 <b>file</b>');
});

test('the page says its language, which picks the right CJK glyphs', () => {
  installLanguage({ tag: 'ja', messages: {} });
  assert.equal(window.document.documentElement.lang, 'ja');
});
