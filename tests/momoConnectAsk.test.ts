// MoMo's "connect this" card in main (#2999, electron/momo/sources/connectAsk.cjs) over the app's real ApprovalBroker: what the card carries, the user's connect answering it (here or in Settings), Not now and its cooldown, one card for overlapping asks, a routine's unattended run and a source macOS does not ask for never getting one, a stopped call withdrawing its card, MoMo turned off or the chat deleted, and an answer that is no connect counting as none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createConnectAsk, KIND, COOLDOWN_MS } = require('../electron/momo/sources/connectAsk.cjs');
const { ApprovalBroker, KINDS } = require('../electron/capabilities/contract/approvals.cjs');

async function until(cond: () => boolean) {
  await waitFor(cond, 'the condition');
  assert.ok(cond(), 'timed out');
}

/** The broker over a fake controller, a hub that emits 'changed', and the ask. */
function rig(o: { attended?: (chatId: string) => boolean | Promise<boolean> } = {}) {
  const cards: any[] = [];
  const resolved: string[] = [];
  const broker = new ApprovalBroker({
    controller: {
      addApproval: (chatId: string, a: any) => cards.push({ chatId, ...a }),
      resolveApproval: (id: string) => (resolved.push(id), true),
    },
  });
  let brokerUp = true;
  const connected = new Set<string>();
  const hub: any = new EventEmitter();
  const ungranted = new Set<string>();
  hub.get = (id: string) => (connected.has(id) ? { id } : null);
  hub.ready = (id: string) => connected.has(id) && !ungranted.has(id);
  let at = 1_000_000;
  const ask = createConnectAsk({
    broker: () => (brokerUp ? broker : null),
    hub,
    harnessOf: (chatId: string) => (chatId === 'momo-main' ? 'claude' : undefined),
    attended: o.attended ?? (() => true),
    now: () => at,
  });
  /** The user connects the source (a click on the card, or Settings): the hub says it changed. */
  const connect = (id: string) => {
    connected.add(id);
    ungranted.delete(id);
    hub.emit('changed');
  };
  /** The source is connected in MoMo but macOS refuses it (the grant was reset). */
  const refuse = (id: string) => {
    connected.add(id);
    ungranted.add(id);
  };
  return {
    cards,
    resolved,
    broker,
    hub,
    ask,
    connect,
    refuse,
    setBroker: (v: boolean) => (brokerUp = v),
    advance: (ms: number) => (at += ms),
  };
}
const calendar = { chatId: 'momo-main', source: 'calendar' };

test('the card is a momoConnect card in the chat, naming the source and the chat’s harness, and the kind is one the broker knows', async () => {
  assert.ok(KINDS.has(KIND));
  const r = rig();
  const p = r.ask.ask(calendar);
  await until(() => r.cards.length === 1);
  assert.equal(r.cards[0].chatId, 'momo-main');
  assert.equal(r.cards[0].method, 'sage/momoConnect');
  assert.deepEqual(r.cards[0].params, { kind: 'momoConnect', harness: 'claude', momoConnect: { source: 'calendar' } });
  assert.equal(r.ask.openCount(), 1);
  r.connect('calendar');
  assert.equal(await p, 'connected');
  assert.equal(r.ask.openCount(), 0);
  assert.equal(r.resolved.length, 1, 'the card left the chat');
  // a chat whose harness is unknown still gets the card
  const q = r.ask.ask({ chatId: 'momo-other', source: 'reminders' });
  await until(() => r.cards.length === 2);
  assert.equal(r.cards[1].params.harness, '');
  r.broker.answer(r.cards[1].id, null);
  assert.equal(await q, 'none');
});

test('a change that did not connect it leaves the card up, and an answer that is no connect counts as none', async () => {
  const r = rig();
  const p = r.ask.ask(calendar);
  await until(() => r.cards.length === 1);
  r.hub.emit('changed');
  await tick();
  assert.equal(r.ask.openCount(), 1, 'Files changed, not Calendar');
  // a window claiming it connected while the hub says it did not
  r.broker.answer(r.cards[0].id, { connected: true });
  assert.equal(await p, 'none');
  const q = r.ask.ask(calendar);
  await until(() => r.cards.length === 2);
  r.broker.answer(r.cards[1].id, { decision: 'allow', scope: 'once' });
  assert.equal(await q, 'none', 'allow is not an answer this card offers');
});

test('Not now declines, the same chat is not asked again for a while, and is after it', async () => {
  const r = rig();
  const p = r.ask.ask(calendar);
  await until(() => r.cards.length === 1);
  r.broker.answer(r.cards[0].id, { decision: 'deny' });
  assert.equal(await p, 'declined');
  assert.equal(await r.ask.ask(calendar), 'declined');
  assert.equal(r.cards.length, 1, 'no second card inside the cooldown');
  // another chat and another source are asked
  const other = r.ask.ask({ chatId: 'momo-other', source: 'calendar' });
  const rem = r.ask.ask({ chatId: 'momo-main', source: 'reminders' });
  await until(() => r.cards.length === 3);
  r.broker.answer(r.cards[1].id, null);
  r.broker.answer(r.cards[2].id, null);
  await Promise.all([other, rem]);
  r.advance(COOLDOWN_MS + 1);
  const again = r.ask.ask(calendar);
  await until(() => r.cards.length === 4);
  r.connect('calendar');
  assert.equal(await again, 'connected');
});

test('overlapping asks for the same chat and source share one card', async () => {
  const r = rig({ attended: async () => (await tick(), true) });
  const [a, b, c] = [r.ask.ask(calendar), r.ask.ask(calendar), r.ask.ask(calendar)];
  await until(() => r.cards.length === 1);
  await tick();
  assert.equal(r.cards.length, 1);
  // and one asking while the card is up joins it
  const late = r.ask.ask(calendar);
  await tick();
  assert.equal(r.cards.length, 1);
  r.connect('calendar');
  assert.deepEqual(await Promise.all([a, b, c, late]), ['connected', 'connected', 'connected', 'connected']);
  // a source connected before the ask needs no card
  assert.equal(await r.ask.ask(calendar), 'connected');
  assert.equal(r.cards.length, 1);
});

test('no card for a source macOS does not ask for, a stopped call, a routine’s unattended run or a missing broker', async () => {
  const r = rig({ attended: (chatId: string) => chatId !== 'routine-run' });
  assert.equal(await r.ask.ask({ chatId: 'momo-main', source: 'files' }), 'none');
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await r.ask.ask(calendar, { signal: stopped.signal }), 'none');
  assert.equal(await r.ask.ask({ chatId: 'routine-run', source: 'calendar' }), 'none');
  r.setBroker(false);
  assert.equal(await r.ask.ask(calendar), 'none');
  assert.equal(r.cards.length, 0);
  r.setBroker(true);
  // and the failed tries left nothing behind: the next ask shows its card
  const p = r.ask.ask(calendar);
  await until(() => r.cards.length === 1);
  r.broker.answer(r.cards[0].id, null);
  assert.equal(await p, 'none');
});

test('the call’s signal withdraws the card, and a card the broker refuses leaves the next ask fresh', async () => {
  const r = rig();
  const ac = new AbortController();
  const p = r.ask.ask(calendar, { signal: ac.signal });
  await until(() => r.cards.length === 1);
  ac.abort();
  assert.equal(await p, 'none');
  assert.equal(r.ask.openCount(), 0);
  // a broker that rejects (an unknown kind)
  const bad = createConnectAsk({
    broker: () => ({ ask: () => Object.assign(Promise.reject(new Error('unknown approval kind')), { id: 'x' }), answer: () => false }),
    hub: r.hub,
    harnessOf: () => 'claude',
    attended: () => true,
  });
  await assert.rejects(() => bad.ask(calendar), /unknown approval kind/);
  await assert.rejects(() => bad.ask(calendar), /unknown approval kind/, 'asked afresh, not the old failure kept');
});

test('MoMo turned off withdraws every card, a deleted chat only its own, and neither needs a broker', async () => {
  const r = rig();
  const a = r.ask.ask(calendar);
  const b = r.ask.ask({ chatId: 'momo-other', source: 'reminders' });
  await until(() => r.cards.length === 2);
  r.ask.withdrawChat('momo-main');
  assert.equal(await a, 'none');
  assert.equal(r.ask.openCount(), 1, 'the other chat’s card stays');
  r.ask.withdrawAll();
  assert.equal(await b, 'none');
  assert.equal(r.ask.openCount(), 0);
  r.setBroker(false);
  r.ask.withdrawAll();
  r.ask.withdrawChat('momo-main');
});

test('a source connected in MoMo but refused by macOS still gets a card, which only a grant answers', async () => {
  const r = rig();
  r.refuse('calendar');
  const p = r.ask.ask(calendar);
  await until(() => r.cards.length === 1);
  // a change that leaves the grant missing (Settings read again) does not answer it
  r.hub.emit('changed');
  await tick();
  assert.deepEqual(r.resolved, []);
  r.connect('calendar');
  assert.equal(await p, 'connected');
  // granted: nothing to ask
  assert.equal(await r.ask.ask(calendar), 'connected');
  assert.equal(r.cards.length, 1);
});
