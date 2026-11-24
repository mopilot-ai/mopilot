// How the gate keeps the rows of its cards in step (host/src/momoServices/gate.mjs `syncRows`): a card's row is never written from an older read than another write of it, a look heals a row that is missing or older whatever the card's age but does not push settled rows out, runs even when the sweep failed, and the first row of a card the Host runs says it can be edited.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { createGateRows } from '../host/src/momoGateRows.mjs';
// @ts-ignore
import { createMomoRows, rowsShape } from '../host/src/momoRows.mjs';
// @ts-ignore
import { createIntentRegistry } from '../shared/momoIntents.mjs';
import { add, owner, world } from './support/host/notesToolWorld.ts';

const send = (to: string, over: object = {}) => ({
  chatId: 'momo-chat',
  origin: 'chat' as const,
  tool: 'gmail.send',
  effect: 'send' as const,
  scope: to,
  args: { to },
  summary: `Send to ${to}`,
  ...over,
});

async function rowed(t: any, report: (m: string) => void = () => {}) {
  const w = await world(t, { report });
  w.home.rows = createMomoRows({
    store: w.home.data.sealed('chat-rows.json', rowsShape),
    stamp: () => w.home.stamp(),
    hasChat: () => true,
    now: () => w.clock.at,
  });
  const rowOf = (id: string) => w.home.rows.list().rows.find((r: any) => r.id === `approval:${id}`);
  const until = async (ok: () => boolean) => {
    for (const end = Date.now() + 3000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    return ok();
  };
  const gate = () => w.home.service('gate');
  return { w, rowOf, until, gate };
}
/** One minute of the gate's timer, with the timers the test controls. */
async function minute(t: any, w: any) {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  await w.home.lifecycle('pause');
  await w.home.lifecycle('start');
  return () => mock.timers.tick(60_000);
}

test('a look leaves a row alone that is kept as the card shows it, whatever the age', async (t) => {
  const { w, rowOf, until, gate } = await rowed(t);
  await w.home.gate.run(send('a@example.com'), () => 1).catch(() => {});
  const [card] = await gate().cards('phone:x');
  assert.ok(await until(() => rowOf(card.id)?.approval.status === 'pending'));
  await gate().answer(card.id, 'deny', 'phone:x', 'Phone');
  assert.ok(await until(() => rowOf(card.id)?.approval.status === 'denied'));
  const tick = await minute(t, w);
  const writes: string[] = [];
  const put = w.home.rows.put.bind(w.home.rows);
  w.home.rows.put = (row: any) => (writes.push(row.id), put(row));
  w.clock.at += 60 * 60_000;
  tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(writes, [], 'the row is as the card shows it: nothing is written');
});

test('a row whose write failed when the card was answered is written by the first look after a long stop, however old the card is', async (t) => {
  const { w, rowOf, until, gate } = await rowed(t);
  await w.home.gate.run(send('a@example.com'), () => 1).catch(() => {});
  const [card] = await gate().cards('phone:x');
  assert.ok(await until(() => rowOf(card.id)?.approval.status === 'pending'));
  const put = w.home.rows.put.bind(w.home.rows);
  // the owner taps Deny and the row cannot be written (the Host dies, the disk is full)
  w.home.rows.put = async () => {
    throw new Error('disk full');
  };
  await gate().answer(card.id, 'deny', 'phone:x', 'Phone');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(rowOf(card.id).approval.status, 'pending', 'the chat still shows Allow and Deny');
  w.home.rows.put = put;
  const tick = await minute(t, w);
  w.clock.at += 3 * 60 * 60_000;
  tick();
  assert.ok(await until(() => rowOf(card.id)?.approval.status === 'denied'), 'the look put it right');
});

test('a settled card with no row comes back only when the store has room, so an evicted row does not return on every look', async (t) => {
  const { w, rowOf, until, gate } = await rowed(t);
  const put = w.home.rows.put.bind(w.home.rows);
  w.home.rows.put = async () => {
    throw new Error('no chat yet');
  };
  await w.home.gate.run(send('a@example.com'), () => 1).catch(() => {});
  const [card] = await gate().cards('phone:x');
  await gate().answer(card.id, 'deny', 'phone:x', 'Phone');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(rowOf(card.id), undefined);
  w.home.rows.put = put;
  const stat = w.home.rows.stat.bind(w.home.rows);
  // the store is full of newer settled rows: this old card's row would push one of them out
  w.home.rows.stat = () => ({ settled: 500, oldest: Date.now() + 10 * 60_000 });
  const tick = await minute(t, w);
  tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rowOf(card.id), undefined, 'not brought back');
  w.home.rows.stat = stat;
  tick();
  assert.ok(await until(() => rowOf(card.id)?.approval.status === 'denied'), 'with room it is written');
});

test('the answer made between the look reading a card and writing its row is not overwritten by the older view', async (t) => {
  const { w, rowOf, until, gate } = await rowed(t);
  const put = w.home.rows.put.bind(w.home.rows);
  // the row of the card was never written, so the look has a `pending` row to put
  w.home.rows.put = async () => {
    throw new Error('no chat yet');
  };
  await w.home.gate.run(send('a@example.com'), () => 1).catch(() => {});
  const [card] = await gate().cards('phone:x');
  assert.equal(rowOf(card.id), undefined);
  let answering: Promise<unknown> | null = null;
  w.home.rows.put = async (row: any) => {
    // the look's own write, built from the card as it was read: the owner answers before it lands, and the answer's own row has time to be written
    if (!answering) {
      answering = gate().answer(card.id, 'allow', 'phone:x', 'Phone');
      await answering;
      await new Promise((r) => setTimeout(r, 100));
    }
    return put(row);
  };
  const tick = await minute(t, w);
  tick();
  assert.ok(await until(() => answering !== null));
  assert.ok(await until(() => rowOf(card.id)?.approval.status === 'approved'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rowOf(card.id).approval.status, 'approved', 'the later write read the card again');
});

test('a sweep that fails does not stop the rows: the look still runs, and the failure is reported', async (t) => {
  const reports: string[] = [];
  const { w, rowOf, until, gate } = await rowed(t, (m) => reports.push(m));
  const real = w.home.rows.put.bind(w.home.rows);
  // the row of the card could not be written when it was raised
  w.home.rows.put = async () => {
    throw new Error('disk full');
  };
  await w.home.gate.run(send('a@example.com'), () => 1).catch(() => {});
  const [card] = await gate().cards('phone:x');
  assert.equal(rowOf(card.id), undefined);
  const tick = await minute(t, w);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rowOf(card.id), undefined, 'the look at start could not write it either');
  w.home.rows.put = real;
  // the sweep reads the lease once and fails; the look after it reads it again and does not
  const stamp = w.home.stamp.bind(w.home);
  let failed = false;
  w.home.stamp = () => {
    if (!failed && /\bsweep \(.*momoServices\/gate\.mjs/.test(new Error().stack ?? '')) {
      failed = true;
      throw new Error('lease unreadable');
    }
    return stamp();
  };
  tick();
  assert.ok(await until(() => rowOf(card.id)?.approval.status === 'pending'));
  // the failure is reported once the look after it is done
  assert.ok(await until(() => reports.some((m) => /sweep failed: lease unreadable/.test(m))));
  // a look that fails is reported too
  w.home.rows.put = async () => {
    throw new Error('still full');
  };
  w.clock.at += 1;
  w.home.stamp = () => {
    throw new Error('gone');
  };
  tick();
  assert.ok(await until(() => reports.some((m) => /rows could not be synced: gone/.test(m))));
});

test('the first row of a note card the Host runs already offers Edit', async (t) => {
  const { w, rowOf, until, gate } = await rowed(t);
  await owner(w, 'I prefer email over calls');
  await gate().taintFor(w.M).toolResult('outside');
  await w.call(w.M, 'momo_notes', add);
  const note = (await gate().cards('phone:x')).find((c: any) => c.fields.some((f: any) => f.label === 'You said'));
  assert.ok(await until(() => rowOf(note.id)?.approval.editable === true), 'written again once the note was kept for the card');
});

/** The gate's intents of the owner's taps (Ask again, Edit), over the same world. */
function taps(w: any) {
  const registry = createIntentRegistry({ running: () => !!w.home.stamp() });
  registry.register('gate', w.home.service('gate').intents);
  const run = registry.intents() as Record<string, (i: any) => Promise<any>>;
  const by = { id: 'phone:a', name: 'Phone' };
  return {
    again: (id: string) => run['approval.askAgain']({ kind: 'approval.askAgain', id, by }),
    edit: (id: string, body: string) => run['approval.edit']({ kind: 'approval.edit', id, body, by }),
  };
}

test('a card made by Ask again or by Edit offers Edit in its very first row', async (t) => {
  const { w, rowOf, until, gate } = await rowed(t);
  const { again, edit } = taps(w);
  await owner(w, 'I prefer email over calls');
  await gate().taintFor(w.M).toolResult('outside');
  await w.call(w.M, 'momo_notes', add);
  const waiting = async () => (await gate().cards('phone:a')).filter((c: any) => c.status === 'pending');
  const [first] = await waiting();
  // Edit: a new card for the new text, and its first row already says Edit is offered
  await edit(first.id, 'Prefers email, never phone');
  const [edited] = await waiting();
  assert.notEqual(edited.id, first.id);
  assert.ok(await until(() => rowOf(edited.id)?.approval.editable === true), 'Edit');
  // Ask again after a deny: the same
  await gate().answer(edited.id, 'deny', 'phone:a', 'Phone');
  await again(edited.id);
  const [asked] = await waiting();
  assert.notEqual(asked.id, edited.id);
  assert.ok(await until(() => rowOf(asked.id)?.approval.editable === true), 'Ask again');
});

test('Ask again takes one of the places for waiting cards of its chat, like any other card', async (t) => {
  const { w, gate } = await rowed(t);
  const { again } = taps(w);
  await owner(w, 'I prefer email over calls');
  await gate().taintFor(w.M).toolResult('outside');
  const note = (n: number) => ({ ...add, title: `Dana ${n}` });
  const waiting = async () => (await gate().cards('phone:a')).filter((c: any) => c.status === 'pending');
  for (let n = 0; n < 10; n++) await w.call(w.M, 'momo_notes', note(n));
  assert.equal((await waiting()).length, 10);
  const [first] = await waiting();
  await gate().answer(first.id, 'deny', 'phone:a', 'Phone');
  await w.call(w.M, 'momo_notes', note(10));
  assert.equal((await waiting()).length, 10, 'the chat is full again');
  await assert.rejects(again(first.id), /can’t ask for that any more/);
  assert.equal((await waiting()).length, 10, 'no card was added');
});

test('off the home a row write reads nothing and builds no store', async () => {
  // a gate whose stores were never built, on a Host that is not the running home
  let built = 0;
  const rows = createGateRows({
    home: { stamp: () => null, rows: { put: async () => assert.fail('wrote a row') } },
    ensure: async () => (built++, {}) as any,
    editable: () => false,
    report: () => undefined,
  });
  await rows.rowed('any-card');
  await rows.rowed('any-card', true);
  assert.equal(built, 0);
});

test('a settled card with no row in a full store comes back only when it changed after the oldest settled row, by whichever time it carries', async () => {
  const card = (over: object) => ({
    id: 'c',
    tool: 'gmail.send',
    scope: 's',
    summary: 'Send',
    createdAt: 100,
    expiresAt: null,
    tainted: false,
    reason: 'ask',
    ...over,
  });
  const cases: [string, object, boolean][] = [
    ['only its creation, older than the oldest row', { status: 'denied' }, false],
    ['answered after the oldest row', { status: 'denied', decidedAt: 600 }, true],
    ['used after the oldest row', { status: 'used', decidedAt: 200, usedAt: 700 }, true],
    ['ended unattended after the oldest row', { status: 'expired', expiresAt: 800 }, true],
    ['ended by a move: no end time, and not newer', { status: 'expired', expiresAt: null }, false],
    ['a denied card keeps no end time of its own', { status: 'denied', expiresAt: 900 }, false],
    ['created after the oldest row', { status: 'denied', createdAt: 1000 }, true],
  ];
  for (const [why, over, written] of cases) {
    const puts: unknown[] = [];
    const rows = createGateRows({
      home: {
        stamp: () => ({}),
        rows: { kept: () => undefined, stat: () => ({ settled: 500, oldest: 500 }), put: async (r: unknown) => void puts.push(r) },
      },
      ensure: async () => ({ store: { get: async () => card(over) } }) as any,
      editable: () => false,
      report: () => undefined,
    });
    await rows.rowed('c', true);
    assert.equal(puts.length === 1, written, why);
  }
});

test('the rows store says what it keeps for a look, and only while it is the running home', async (t) => {
  const w = await world(t);
  const stamp = { on: true };
  const rows = createMomoRows({
    store: w.home.data.sealed('chat-rows-2.json', rowsShape),
    stamp: () => (stamp.on ? w.home.stamp() : null),
    hasChat: () => true,
    now: () => w.clock.at,
  });
  assert.deepEqual(rows.stat(), { settled: 0, oldest: Number.POSITIVE_INFINITY });
  assert.equal(rows.kept('approval:x'), undefined);
  await rows.put({ kind: 'approval', id: 'approval:x', approval: { status: 'denied' } });
  assert.equal(rows.stat().settled, 1);
  assert.deepEqual(Object.keys(rows.kept('approval:x')).sort(), ['approval', 'at', 'id', 'kind'], 'no write time');
  stamp.on = false;
  assert.throws(() => rows.kept('approval:x'), { code: 'momo_home_away' });
  assert.throws(() => rows.stat(), { code: 'momo_home_away' });
});
