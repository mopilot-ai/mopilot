// What the phone does with each answer a Host gives to a message it sent straight to it (#4786, shared/remote/phoneChats.mjs, mobile/src/outbox.ts): a start the Host refused (`queued` carrying its reason) is a refused send with that reason, not a message sent, and a Host's refusal before it did anything is shown as not sent (never as "may have arrived") and goes again on Retry; every answer that took the message is taken as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneChats } from '../shared/remote/phoneChats.mjs';
import { startRefusal } from '../shared/host/startRefusal.mjs';
import { createOutbox } from '../mobile/src/outbox.ts';

const REASON = "Couldn't start Claude Code: no such binary.";

function rig(answer: (p: any) => unknown) {
  const calls: any[] = [];
  const session: any = {
    send: async (p: any) => (calls.push(['send', p]), answer(p)),
    start: async (p: any) => (calls.push(['start', p]), answer(p)),
  };
  const chats = createPhoneChats({ host: async () => session, hostKeyOf: () => 'a'.repeat(64), emit: () => undefined, now: () => 1000 });
  return { chats, calls };
}
const refused = { replayed: false, result: { action: 'queued', id: 'k', error: REASON, turnId: 'k' } };

test('A: a Host that answers a send or a start with `queued` and its reason refused it: the phone rejects with the reason, as a refusal that may be sent again', async () => {
  const r = rig(() => refused);
  const sendFailure = await r.chats.send('m1', { chatId: 'c1', text: 'hi', sendId: 's1' }).catch((e: any) => e);
  assert.equal(sendFailure.message, REASON);
  assert.equal(sendFailure.code, 'unsupported');
  const startFailure = await r.chats
    .start('m1', { chatId: 'claude:1', startId: 'st1', harness: 'claude', text: 'go' })
    .catch((e: any) => e);
  assert.equal(startFailure.message, REASON);
  assert.equal(startFailure.code, 'unsupported');
  // the key of the next try is the one of this try: the Host runs a refused key again
  await r.chats.send('m1', { chatId: 'c1', text: 'hi', sendId: 's1' }).catch(() => undefined);
  assert.equal(r.calls[0][1].key, r.calls[2][1].key);
});

for (const action of ['started', 'steered', 'queued', 'held', 'discarded', 'dispatched']) {
  test(`B: ${action} with no error is the Host taking the message: the phone resolves with what it answered`, async () => {
    const answer = { replayed: false, result: { action, id: 'k', turnId: 'k' } };
    const r = rig(() => answer);
    assert.equal(await r.chats.send('m1', { chatId: 'c1', text: 'hi', sendId: 's1' }), answer);
    assert.equal(await r.chats.start('m1', { chatId: 'claude:1', startId: 'st1', harness: 'claude', text: 'go' }), answer);
  });
}

test('B: an answer that is no receipt (an older Host answers with a turn id alone) is taken as before', () => {
  for (const answer of [
    undefined,
    null,
    'ok',
    { turnId: 't' },
    { result: null },
    { result: { action: 'queued' } },
    { action: 'queued', error: '' },
  ])
    assert.equal(startRefusal(answer), null);
  assert.equal(startRefusal({ action: 'queued', error: REASON }), REASON, 'the result alone reads the same as the connection’s answer');
  assert.equal(startRefusal(refused), REASON);
});

test('W: a refusal of the Host before it did anything is not sent, with its reason, and goes again on Retry; an unknown code still reads as not confirmed', async () => {
  const gates: Array<{ ok: () => void; fail: (e: unknown) => void }> = [];
  const changes: any[][] = [];
  let n = 0;
  const box = createOutbox({
    online: () => true,
    send: () => new Promise((resolve, reject) => gates.push({ ok: () => resolve({ sent: true }), fail: reject })),
    lost: () => false,
    idempotent: () => true,
    ready: () => Promise.resolve(true),
    newId: () => `id-${++n}`,
    now: () => 100,
    onChange: (items) => changes.push(items),
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const id = box.add({ pairId: 'p1', chatId: 'c1', text: 'hello', attachments: [] });
  await tick();
  gates[0].fail(Object.assign(new Error(REASON), { code: 'unsupported' }));
  await tick();
  const shown = changes.at(-1)![0];
  assert.deepEqual(
    [shown.status, shown.error, shown.errorCode, shown.uncertain, shown.final],
    ['failed', REASON, 'unsupported', undefined, undefined],
  );
  assert.equal(box.retry(id), true);
  await tick();
  gates[1].ok();
  await tick();
  assert.deepEqual(changes.at(-1), []);
  // the Host's other pre-effect refusals read the same; a code nobody knows still does not claim non-delivery
  for (const code of ['harness_not_configured', 'directory_missing', 'unknown_client']) {
    const other = box.add({ pairId: 'p1', chatId: `c-${code}`, text: code, attachments: [] });
    await tick();
    gates.at(-1)!.fail(Object.assign(new Error(code), { code }));
    await tick();
    assert.equal(changes.at(-1)!.find((i) => i.id === other).uncertain, undefined, code);
  }
  const odd = box.add({ pairId: 'p1', chatId: 'c-odd', text: 'odd', attachments: [] });
  await tick();
  gates.at(-1)!.fail(Object.assign(new Error('odd'), { code: 'something_new' }));
  await tick();
  assert.equal(changes.at(-1)!.find((i) => i.id === odd).uncertain, true);
});
