// The gate's cards as rows of MoMo's chat (host/src/momoServices/gate.mjs → host/src/momoRows.mjs): one row per card id, written when the card is raised and updated in place at every change (answered, used, failed, expired, void), through the real rows store and against the shared fixture both UIs draw.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { createMomoRows, rowsShape } from '../host/src/momoRows.mjs';
import { FIXTURE_ROWS } from '../shared/momoRowsFixture.ts';
import { chat, world } from './support/host/momoCoreWorld.ts';

const send = {
  tool: 'gmail.send',
  effect: 'send' as const,
  scope: 'dana@example.com',
  args: { to: 'dana@example.com', body: 'Hi' },
  summary: 'Send a mail to Dana',
  fields: [{ label: 'body', value: 'Hi' }],
};

/** The world with the real durable row store on the home, and a main chat unless told not to have one. */
async function rowsWorld(t: any, { main = true, report }: { main?: boolean; report?: (m: string) => void } = {}) {
  const w = await world(t, { report });
  const has = { main };
  w.home.chats = { main: () => (has.main ? { chatId: 'momo-chat', harness: 'claude' } : null), isMomoChat: () => true } as any;
  w.home.rows = createMomoRows({
    store: w.home.data.sealed('chat-rows.json', rowsShape),
    stamp: () => w.home.stamp(),
    hasChat: () => has.main,
    now: () => w.clock.at,
  });
  const rowOf = (cardId: string) => w.home.rows.list().rows.find((r: any) => r.id === `approval:${cardId}`);
  /** Waits for the row of a card to say `status` (the gate's change listeners write it after the card is read), or for `ms`; true when it does. */
  const until = async (cardId: string, status: string, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10)))
      if (rowOf(cardId)?.approval.status === status) return true;
    return false;
  };
  /** Waits until no row has been written for a moment, for what must not appear. */
  const quiet = async () => {
    for (let last = -1, same = 0; same < 5; await new Promise((r) => setTimeout(r, 20))) {
      const next = w.home.rows.list().next;
      same = next === last ? same + 1 : 0;
      last = next;
    }
  };
  return { ...w, has, rowOf, until, quiet };
}

test('a card is a row when it is raised, with the fields the card shows, and the row has the shape both UIs draw', async (t) => {
  const w = await rowsWorld(t);
  const asked = await w.gate.run(chat(send), () => 1);
  assert.ok(await w.until(asked.card.id, 'pending'));
  const row = w.rowOf(asked.card.id);
  assert.equal(row.kind, 'approval');
  assert.equal(row.approval.status, 'pending');
  assert.deepEqual(row.approval.fields.map((f: any) => f.value).slice(0, 2), ['gmail.send', 'dana@example.com']);
  assert.ok(
    row.approval.fields.some((f: any) => f.label === 'body' && f.value === 'Hi'),
    'the bound arguments are on the row',
  );
  const fixture = FIXTURE_ROWS.find((r) => r.kind === 'approval') as any;
  assert.deepEqual(Object.keys(row.approval).sort(), Object.keys(fixture.approval).sort());
  assert.deepEqual(Object.keys(row).sort(), Object.keys(fixture).sort());
});

test('the same row is updated in place as the card is answered, spent, and ends, and a reader after a cursor sees each change once', async (t) => {
  const w = await rowsWorld(t);
  const asked = await w.gate.run(chat(send), () => 1);
  const id = asked.card.id;
  assert.ok(await w.until(id, 'pending'));
  const first = w.rowOf(id);
  const cursor = w.home.rows.list().next;
  await w.gate.answer(id, 'allow', 'phone:abc', 'Phone');
  assert.ok(await w.until(id, 'approved'));
  assert.equal(w.rowOf(id).at, first.at, 'the row keeps its place in the chat');
  assert.deepEqual(
    w.home.rows.list(cursor).rows.map((r: any) => r.id),
    [`approval:${id}`],
  );
  assert.deepEqual(await w.gate.resume(id, chat(send), () => 1), { done: true, result: 1 });
  assert.ok(await w.until(id, 'completed'));
  assert.equal(w.home.rows.list().rows.filter((r: any) => r.id === `approval:${id}`).length, 1, 'one row per card');
});

test('a denied card, an expired one, a failed one and one the home no longer owns are each their state on the row', async (t) => {
  const w = await rowsWorld(t);
  const ask = async (extra: object) => (await w.gate.run(chat({ ...send, ...extra }), () => 0)).card;
  const denied = await ask({ args: { to: 'a@example.com' }, scope: 'a@example.com' });
  await w.gate.answer(denied.id, 'deny', 'phone:abc', 'Phone');
  const failing = await ask({ args: { to: 'b@example.com' }, scope: 'b@example.com' });
  await w.gate.answer(failing.id, 'allow', 'phone:abc', 'Phone');
  const failed = await w.gate.resume(failing.id, chat({ ...send, args: { to: 'b@example.com' }, scope: 'b@example.com' }), () => {
    throw Object.assign(new Error('Gmail refused the send.'), { notSent: true });
  });
  assert.equal(failed.failed, true);
  const waiting = await ask({ args: { to: 'c@example.com' }, scope: 'c@example.com', origin: 'task' });
  w.clock.at += 31 * 60_000;
  await w.gate.sweep();
  const stale = await ask({ args: { to: 'd@example.com' }, scope: 'd@example.com' });
  assert.ok(await w.until(denied.id, 'denied'));
  assert.ok(await w.until(failing.id, 'failed'));
  assert.equal(w.rowOf(failing.id).approval.failure.cause, 'Gmail refused the send.');
  assert.ok(await w.until(waiting.id, 'expired'));
  assert.ok(await w.until(stale.id, 'pending'));
});

test('with no main chat the card still works and has no row; the row is written once there is a chat', async (t) => {
  const w = await rowsWorld(t, { main: false });
  const asked = await w.gate.run(chat(send), () => 1);
  await w.quiet();
  assert.equal(asked.pending, true);
  assert.equal(w.rowOf(asked.card.id), undefined);
  w.has.main = true;
  await w.home.lifecycle('pause');
  await w.home.lifecycle('start');
  assert.ok(await w.until(asked.card.id, 'pending'));
});

test('with no row store the gate works as before', async (t) => {
  const w = await rowsWorld(t);
  w.home.rows = null;
  const asked = await w.gate.run(chat(send), () => 1);
  assert.equal(asked.pending, true);
  await w.gate.answer(asked.card.id, 'allow', 'phone:abc', 'Phone');
  assert.deepEqual(await w.gate.resume(asked.card.id, chat(send), () => 1), { done: true, result: 1 });
});

test('a card of an earlier lease is a void row on the next look, and a row that cannot be written does not stop the card', async (t) => {
  const w = await rowsWorld(t);
  const asked = await w.gate.run(chat(send), () => 1);
  assert.ok(await w.until(asked.card.id, 'pending'));
  // the home's lease moves on: the card was raised under the old one
  const real = w.home.stamp.bind(w.home);
  w.home.stamp = () => {
    const s = real();
    return s && { ...s, leaseEpoch: s.leaseEpoch + 1 };
  };
  w.home.current = () => true;
  await w.gate.cards('phone:abc');
  assert.ok(await w.until(asked.card.id, 'void'));
  // a row store that fails does not stop a card
  w.home.rows.put = async () => {
    throw new Error('disk full');
  };
  const other = await w.gate.run(chat({ ...send, args: { to: 'z@example.com' }, scope: 'z@example.com' }), () => 1);
  assert.equal(other.pending, true);
  await w.gate.answer(other.card.id, 'allow', 'phone:abc', 'Phone');
  assert.deepEqual(await w.gate.resume(other.card.id, chat({ ...send, args: { to: 'z@example.com' }, scope: 'z@example.com' }), () => 1), {
    done: true,
    result: 1,
  });
});

test('the gate looks at its cards every minute: an overdue card ends and its row says so, and a look that fails is reported', async (t) => {
  const reports: string[] = [];
  const w = await rowsWorld(t, { report: (m) => reports.push(m) });
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  await w.home.lifecycle('pause');
  await w.home.lifecycle('start');
  const asked = await w.gate.run(chat({ ...send, origin: 'task' }), () => 1);
  assert.ok(await w.until(asked.card.id, 'pending'));
  w.clock.at += 31 * 60_000;
  mock.timers.tick(60_000);
  assert.ok(await w.until(asked.card.id, 'expired'));
  const real = w.home.stamp.bind(w.home);
  w.home.stamp = () => {
    throw new Error('no stamp');
  };
  mock.timers.tick(60_000);
  for (const end = Date.now() + 3000; !reports.some((m) => /sweep failed: no stamp/.test(m)) && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 10));
  w.home.stamp = real;
  assert.ok(reports.some((m) => /sweep failed: no stamp/.test(m)));
});

test('a gate that cannot build its stores at start says so and the home goes on', async (t) => {
  const reports: string[] = [];
  const w = await rowsWorld(t);
  await w.home.lifecycle('pause');
  const real = w.home.data.safeStorage;
  w.home.data.safeStorage = {
    ...real,
    encryptString: () => {
      throw new Error('no key');
    },
  };
  t.after(() => void (w.home.data.safeStorage = real));
  (await import('../host/src/momoServices/gate.mjs' as string)).default({
    home: w.home,
    now: () => w.clock.at,
    report: (m: string) => reports.push(m),
  });
  await w.home.lifecycle('start');
  for (const end = Date.now() + 3000; !reports.length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.match(reports[0], /gate could not start/);
});
