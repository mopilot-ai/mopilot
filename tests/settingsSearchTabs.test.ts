// A search hit on a Connections word opens the tab that shows it, so the page lands on the setting and not on the first tab (src/lib/settingsSearch.ts tabOfWord), and the Momo banner's "Open <machine>" opens Control other devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEYWORDS, tabOfWord } from '../src/lib/settingsSearch.ts';
import { connectionsRoute } from '../src/lib/connectionsRoute.ts';

test('each Connections keyword names its tab; a word of another page, or no word, names none', () => {
  assert.equal(tabOfWord('connections', 'SSH'), 'ssh');
  assert.equal(tabOfWord('connections', 'Remote hosts'), 'other');
  assert.equal(tabOfWord('connections', 'Control other devices'), 'other');
  assert.equal(tabOfWord('connections', 'Control this Mac'), 'this-mac');
  assert.equal(tabOfWord('connections', 'Allow connections'), 'this-mac');
  assert.equal(tabOfWord('connections', 'GitHub'), undefined);
  assert.equal(tabOfWord('git', 'SSH'), undefined);
  assert.equal(tabOfWord('connections', null), undefined);
});

test('every keyword of the Connections page lands on a tab', () => {
  for (const word of KEYWORDS.connections) assert.ok(tabOfWord('connections', word), word);
  assert.deepEqual(connectionsRoute('other'), { name: 'settings', section: 'connections', tab: 'other' });
});
