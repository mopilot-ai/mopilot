// Unit tests for shared/sendOnce.mjs: in-flight and accepted sends answer a retry, failed and refused ones are sent again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendOnce } from '../shared/sendOnce.mjs';

const tick = () => new Promise((r) => setImmediate(r));

test('a retry while the send is in flight answers the same send, and is not sent twice', async () => {
  const once = sendOnce();
  let release!: (v: string) => void;
  let calls = 0;
  const dispatch = () => (calls++, new Promise<string>((r) => (release = r)));
  const first = once('k', dispatch);
  const retry = once('k', dispatch);
  assert.equal(retry, first);
  await tick();
  release('ok');
  assert.equal(await retry, 'ok');
  assert.equal(await once('k', dispatch), 'ok');
  assert.equal(calls, 1);
});

test('a result the accepted check refuses is forgotten, so the same key is sent again', async () => {
  const once = sendOnce({ accepted: (r: { ok: boolean }) => r.ok });
  const answers = [{ ok: false }, { ok: true }];
  let calls = 0;
  const dispatch = () => answers[calls++];
  assert.deepEqual(await once('k', dispatch), { ok: false });
  await tick();
  assert.deepEqual(await once('k', dispatch), { ok: true });
  await tick();
  assert.deepEqual(await once('k', dispatch), { ok: true });
  assert.equal(calls, 2);
});

test('a send that throws synchronously rejects and is sent again on retry', async () => {
  const once = sendOnce();
  let calls = 0;
  await assert.rejects(
    once('k', () => {
      calls++;
      throw new Error('boom');
    }),
    /boom/,
  );
  await tick();
  assert.equal(await once('k', () => (calls++, 'sent')), 'sent');
  assert.equal(calls, 2);
});

test('the oldest send goes past keep, and an evicted send failing late never forgets a newer send under its key', async () => {
  const once = sendOnce({ keep: 2 });
  let fail!: (e: Error) => void;
  const old = once('a', () => new Promise((_r, j) => (fail = j)));
  old.catch(() => {});
  await tick();
  await once('b', () => 'b');
  await once('c', () => 'c');
  assert.deepEqual([...once.sends.keys()], ['b', 'c']);
  const newer = once('a', () => 'a2');
  fail(new Error('late'));
  await tick();
  assert.equal(once.sends.get('a'), newer);
});
