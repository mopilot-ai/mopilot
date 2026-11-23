// Settings search finds pages by name, group or the words they answer to, and marks what matched.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { searchSettings, highlight, KEYWORDS } = await import('../src/lib/settingsSearch.ts');
const { NAV } = await import('../src/lib/settingsNav.ts');

const items = [
  { id: 'accounts', label: 'Accounts & billing', group: 'App' },
  { id: 'codex', label: 'Codex', group: 'Harnesses' },
  { id: 'browser', label: 'Browser', group: 'Built-in tools' },
];
const words = { accounts: ['API key', 'Usage', 'Usage limits', 'Credits'], codex: ['Pay with API key'], browser: [] };

test('an empty query finds every page with no hint', () => {
  assert.deepEqual(
    searchSettings(items, '  ', words).map((h) => [h.item.id, h.hint]),
    [
      ['accounts', null],
      ['codex', null],
      ['browser', null],
    ],
  );
});

test('a page found by its name or group shows no hint; one found by its words shows them, at most two', () => {
  assert.deepEqual(
    searchSettings(items, 'BROWSER', words).map((h) => [h.item.id, h.hint]),
    [['browser', null]],
  );
  assert.deepEqual(
    searchSettings(items, 'harness', words).map((h) => [h.item.id, h.hint]),
    [['codex', null]],
  );
  assert.deepEqual(
    searchSettings(items, 'api key', words).map((h) => [h.item.id, h.hint]),
    [
      ['accounts', 'API key'],
      ['codex', 'Pay with API key'],
    ],
  );
  assert.deepEqual(
    searchSettings(items, 'usage', words).map((h) => [h.item.id, h.hint]),
    [['accounts', 'Usage · Usage limits']],
  );
  assert.deepEqual(searchSettings(items, 'zzz', words), []);
  // a page with no words of its own is found by name only
  assert.deepEqual(searchSettings([{ id: 'x', label: 'X', group: 'G' }], 'key', words), []);
});

test('every sidebar page has words of its own, and the default words are used', () => {
  for (const n of NAV) assert.ok(KEYWORDS[n.id]?.length, n.id);
  assert.deepEqual(
    searchSettings(NAV, 'cloud provider').map((h) => h.item.id),
    ['claude'],
  );
});

test('highlight cuts a text where the query appears, every time, case-insensitively', () => {
  assert.deepEqual(highlight('Pay with API key', 'api key'), [
    { text: 'Pay with ', hit: false },
    { text: 'API key', hit: true },
  ]);
  assert.deepEqual(highlight('aXaXa', 'x'), [
    { text: 'a', hit: false },
    { text: 'X', hit: true },
    { text: 'a', hit: false },
    { text: 'X', hit: true },
    { text: 'a', hit: false },
  ]);
  assert.deepEqual(highlight('Codex', 'codex'), [{ text: 'Codex', hit: true }]);
  assert.deepEqual(highlight('Codex', ' '), [{ text: 'Codex', hit: false }]);
  assert.deepEqual(highlight('Codex', 'zz'), [{ text: 'Codex', hit: false }]);
});

test("Other harnesses answers to the agents by their app names and by the vendors' own product names", () => {
  const other = [{ id: 'other-harnesses', label: 'Other harnesses', group: 'Harnesses' }];
  assert.equal(searchSettings(other, 'gemini cli')[0].hint, 'Gemini CLI');
  assert.equal(searchSettings(other, 'copilot')[0].hint, 'Copilot · Copilot CLI');
  assert.equal(searchSettings(other, 'cursor cli')[0].hint, 'Cursor CLI');
});

test('a hit found by its words names the first matched word as the setting to land on; a name hit names none', () => {
  assert.deepEqual(
    searchSettings(items, 'usage', words).map((h) => [h.item.id, h.target]),
    [['accounts', 'Usage']],
  );
  assert.equal(searchSettings(items, 'browser', words)[0].target, null);
  assert.equal(searchSettings(items, '', words)[0].target, null);
});
