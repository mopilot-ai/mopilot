// What the app's calls to a Host carry of a message (electron/host/remoteChatCalls.cjs, #4916 and the Plan base): `followUp: 'steer'` on a message to a chat and `planBase` on a first message are in the request, and left out when the message has none. They were dropped here, so a mid-turn message always queued and a first-message Plan lost the mode picked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chatCalls } = require('../electron/host/remoteChatCalls.cjs');

function calls() {
  const asked: any[] = [];
  const c = chatCalls({
    needs: () => undefined,
    request: async (method: string, params: any) => (asked.push([method, params]), { result: {} }),
    epochOf: () => 1,
    mintKey: () => 'key-steer-mint00',
    speaks: () => false,
  });
  return { c, asked };
}

test('a message to a chat carries followUp steer, and only that', async () => {
  const { c, asked } = calls();
  await c.send('c1', { text: 'into the turn', followUp: 'steer' });
  await c.send('c1', { text: 'plain' });
  assert.deepEqual(
    asked.map(([m, p]) => [m, p.followUp]),
    [
      ['chat.send', 'steer'],
      ['chat.send', undefined],
    ],
  );
});

test('a first message carries the mode picked for Plan as planBase, and only with it', async () => {
  const { c, asked } = calls();
  await c.start('c2', { harness: 'codex', text: 'plan it', permission: 'plan', planBase: 'auto-review' });
  await c.start('c3', { harness: 'codex', text: 'just go', permission: 'default' });
  assert.deepEqual(
    asked.map(([m, p]) => [m, p.permission, p.planBase]),
    [
      ['chat.start', 'plan', 'auto-review'],
      ['chat.start', 'default', undefined],
    ],
  );
});
