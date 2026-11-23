// chat.send under a send id from the Mac's own panel: it goes to the harness once and its ledger key is separate from a phone's same id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { PANEL } = require('../electron/remote/service.cjs');

test('chat.send from the panel under a send id reaches the harness once, apart from a phone using the same id', async () => {
  const reached: string[] = [];
  const r = rig({
    ops: {
      send: async (m: any) => {
        reached.push(m.text);
        return m.text === 'warned' ? { warning: 'Queued behind another message.' } : {};
      },
    },
  });
  const message = { chatId: 'c1', text: 'hello', sendId: 'send-0001' };
  assert.deepEqual(await r.service.call(PANEL, 'chat.send', message), { sent: true });
  assert.deepEqual(await r.service.call(PANEL, 'chat.send', message), { sent: true }, 'the repeat gets the first answer');
  assert.deepEqual(reached, ['hello'], 'the repeat did not reach the harness');

  // a phone sending the same id for the same chat is its own send, not the panel's answer
  const phoneReply = await r.phone('p1').ask('chat.send', { chatId: 'c1', text: 'from phone', sendId: 'send-0001' });
  assert.equal(phoneReply.ok, true, JSON.stringify(phoneReply.error));
  assert.deepEqual(reached, ['hello', 'from phone']);
  await r.phone('p1').ask('chat.send', { chatId: 'c1', text: 'from phone', sendId: 'send-0001' });
  assert.deepEqual(reached, ['hello', 'from phone'], 'the phone repeat is answered from its own entry');

  // the panel's entry is also kept apart from the phone's: other text under the panel's id is refused
  await assert.rejects(r.service.call(PANEL, 'chat.send', { chatId: 'c1', text: 'other', sendId: 'send-0001' }), /different message/);
  assert.deepEqual(reached, ['hello', 'from phone']);
});
