// A phone's chat.send answer says how long the Mac held the request (tookMs), so the phone can tell the Mac's share of a slow send from the network's; the panel's answer is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './support/remote-kit.ts';
import { waitFor } from './support/waitFor.ts';

const PANEL = { kind: 'panel' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a phone’s send answer carries tookMs, with and without a send id; the panel’s answer does not', async () => {
  const r = rig({
    ops: {
      send: async (m: any) => {
        await sleep(30);
        // a harness may answer with nothing, or with a warning to pass on
        return m.text === 'none' ? undefined : m.text === 'warned' ? { warning: 'Queued.' } : {};
      },
    },
  });
  const p = r.phone('p1');
  // the send takes longer than the kit's settle, so the answer is waited for
  const ask = async (params: object, id: string) => {
    await p.send({ id, t: 1, kind: 'request', method: 'chat.send', params });
    return waitFor(() => p.inbox.find((m: any) => m.inReplyTo === id), `the answer to ${id}`);
  };
  const withId = await ask({ chatId: 'c1', text: 'a', sendId: 'send-0001' }, 'q1');
  assert.equal(withId.ok, true);
  assert.equal(withId.result.sent, true);
  assert.ok(withId.result.tookMs >= 25 && withId.result.tookMs < 2000, `tookMs ${withId.result.tookMs}`);
  const plain = await ask({ chatId: 'c1', text: 'b' }, 'q2');
  assert.ok(typeof plain.result.tookMs === 'number', 'a send with no id is timed too');
  const nothing = await ask({ chatId: 'c1', text: 'none' }, 'q3');
  assert.deepEqual([nothing.result.sent, typeof nothing.result.tookMs], [true, 'number']);
  const warned = await ask({ chatId: 'c1', text: 'warned' }, 'q4');
  assert.equal(warned.result.warning, 'Queued.');
  assert.deepEqual(await r.service.call(PANEL as any, 'chat.send', { chatId: 'c1', text: 'c' }), { sent: true });
});
