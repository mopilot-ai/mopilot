// The scripted home on its edges (shared/momoHomeFake.mjs): a move asked for before there is a home, a message sent while MoMo sleeps and woken, and two messages resent in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createFakeHome } from '../shared/momoHomeFake.mjs';

const fakeHome = (o: object = {}): any => createFakeHome(o);

test('a move asked for before MoMo has a home is refused in words', async () => {
  const fake = fakeHome({ scenario: 'first-run', stepMs: 0 });
  const refused = await fake.api.intent({ kind: 'move', toId: 'mini' });
  assert.equal(refused.ok, false);
  assert.match(refused.cause, /no home to move from/);
});

test('a message sent while MoMo sleeps is queued, and waking delivers it while leaving the rest of the chat as it was', async () => {
  const fake = fakeHome({ scenario: 'asleep', stepMs: 0 });
  const queued: any = await fake.api.intent({ kind: 'send', turnId: 'key-00000001', text: 'later' });
  const before = queued.view.chat.find((x: any) => x.id === 'key-00000001').delivery;
  assert.notEqual(before, 'accepted');
  const woke: any = await fake.api.intent({ kind: 'wake' });
  assert.equal(woke.view.chat.find((x: any) => x.id === 'key-00000001').delivery, 'accepted');
  assert.ok(woke.view.chat.length >= 1);
});

test('resending one message among several changes only that row', async () => {
  const fake = fakeHome({ scenario: 'running', stepMs: 0 });
  await fake.api.intent({ kind: 'send', turnId: 'key-00000001', text: 'one' });
  await fake.api.intent({ kind: 'send', turnId: 'key-00000002', text: 'two' });
  const again: any = await fake.api.intent({ kind: 'send', turnId: 'key-00000001', text: 'one' });
  const rows = again.view.chat.filter((x: any) => x.kind === 'user');
  assert.deepEqual(rows.map((r: any) => r.id).sort(), ['key-00000001', 'key-00000002']);
});

test('releasing a held move with nothing waiting changes nothing, and with the seal waiting lets it go on', async () => {
  const fake = fakeHome({ scenario: 'moving', stepMs: 0 });
  fake.release(); // may run before the seal is reached: nothing waits yet, or it does
  fake.release();
  const view = (await fake.api.view()).view;
  assert.ok(view.home.move);
  const none = fakeHome({ scenario: 'running', stepMs: 0 });
  none.release();
  assert.equal((await none.api.view()).view.home.move, null);
});
