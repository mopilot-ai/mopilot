// The phone feed's side-chat rebuild with nothing given (#5202): no side chats and no asks are the defaults, and an item that carries no turn id is a turn of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openPhoneItems } = require('../electron/app/chromePanelPhones.cjs');
const KEY = 'claude:fork-1';

test('with no side chats and no asks given, a turn the feed holds is rebuilt as it is; an item with no turn id is a turn of its own', async () => {
  const phone = openPhoneItems({ service: () => ({ attached: true, onFeedEvent: () => {} }), chatOf: () => KEY, rows: async () => [] });
  phone.live('claude', { kind: 'turnStarting', key: KEY, turnId: undefined, clientId: 'x', text: 'q' });
  assert.deepEqual(
    phone.turnsOf(KEY).map((t: any) => [t.id, t.status, t.items.map((i: any) => i.type)]),
    [['', 'completed', ['userMessage']]],
    'nothing was asked of the app, so no question is added',
  );
  assert.deepEqual(phone.turnsOf('nothing-here'), [], 'and a chat with no entries has no turns');
});
