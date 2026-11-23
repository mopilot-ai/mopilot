// What the user can do to MoMo's open loops (#2139 P4): one set of acts (electron/momo/loopActs.cjs: done, dismiss which closes the loop and spaces out its kind, snooze a day or a week or to a time, reopen) behind the Memory tab's IPC (loopsIpc.cjs) and MoMo's momo_open_loops tool (loopTools.cjs), which only MoMo's own chats see while MoMo is allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const { OpenLoopStore } = require('../electron/momo/openLoops.cjs');
const { createLoopActs, SNOOZES } = require('../electron/momo/loopActs.cjs');
const { registerLoopsIpc, CHANNELS, CLOSED_SHOWN } = require('../electron/momo/loopsIpc.cjs');
const { registerLoopTools, DATA_NOTE } = require('../electron/momo/loopTools.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const NOW = Date.UTC(2030, 2, 20, 12);
const D = 86_400_000;
const SRC = { chatId: 'momo-main', harness: 'claude' };
const add = (text: string, extra: any = {}) => ({
  kind: 'todo',
  text,
  quote: text.toLowerCase(),
  line: { text, at: NOW - 2 * D, turnId: 't1' },
  tz: 'UTC',
  confidence: 'sure',
  ...extra,
});

async function setup(o: any = {}) {
  let n = 0;
  const loops = new OpenLoopStore({
    dir: path.join(scratch(), 'momo'),
    safeStorage: o.safe ?? fakeSafe(),
    now: () => NOW,
    newId: () => `L${++n}`,
  });
  if (o.safe?.available !== false)
    await loops.applyPass(
      { add: o.loops ?? [add('Renew the lease', { kind: 'promise', dueAt: NOW + D }), add('Call mum')], mention: [], done: [] },
      SRC,
    );
  const dismissed: string[] = [];
  const act = createLoopActs({ loops, dismissed: (k: string) => void dismissed.push(k), now: () => NOW });
  return { loops, act, dismissed };
}

test('done, dismiss (which spaces out its kind), snooze and reopen; anything else is refused with why', async () => {
  const t = await setup();
  assert.equal((await t.act('L2', { action: 'done' })).state, 'done');
  assert.equal((await t.act('L2', { action: 'reopen' })).state, 'open');
  const gone = await t.act('L1', { action: 'dismiss' });
  assert.equal(gone.state, 'dismissed');
  assert.deepEqual(t.dismissed, ['promise']);
  assert.equal((await t.act('L2', { action: 'snooze', snooze: 'day' })).snoozedUntil, NOW + SNOOZES.day);
  assert.equal((await t.act('L2', { action: 'snooze', snooze: 'week' })).snoozedUntil, NOW + 7 * D);
  assert.equal((await t.act('L2', { action: 'snooze', until: NOW + 3 * D })).snoozedUntil, NOW + 3 * D);
  for (const [id, a] of [
    ['', { action: 'done' }],
    [7, { action: 'done' }],
    ['L2', { action: 'explode' }],
    ['L2', null],
    ['L2', { action: 'snooze', snooze: 'year' }],
    ['L2', { action: 'snooze', until: NOW - 1 }],
    ['L2', { action: 'snooze', until: 'later' }],
  ] as const)
    await assert.rejects(t.act(id, a), (e: any) => e.code === 'bad_args', JSON.stringify([id, a]));
  await assert.rejects(t.act('nope', { action: 'done' }), (e: any) => e.code === 'not_found');
  assert.equal(t.dismissed.length, 1, 'a refused dismiss spaces out nothing');
});

function fakeIpc() {
  const handlers = new Map<string, any>();
  return {
    handlers,
    handle: (ch: string, fn: any) => void handlers.set(ch, fn),
    removeHandler: (ch: string) => void handlers.delete(ch),
    call: (ch: string, ...args: any[]) => handlers.get(ch)({}, ...args),
  };
}

test('the IPC lists open loops and the latest closed ones, acts on one, tells every window of a change, and is refused while MoMo is off', async () => {
  const t = await setup({ loops: Array.from({ length: CLOSED_SHOWN + 3 }, (_, i) => add(`Loop ${i}`)) });
  for (let i = 1; i <= CLOSED_SHOWN + 2; i++) await t.act(`L${i}`, { action: 'done' });
  const ipc = fakeIpc();
  const sent: string[] = [];
  const gate = { allowed: true };
  const off = registerLoopsIpc(ipc, {
    loops: t.loops,
    act: t.act,
    allowed: () => gate.allowed,
    broadcast: (c: string) => void sent.push(c),
  });
  assert.deepEqual([...ipc.handlers.keys()].sort(), [...CHANNELS].sort());
  const r = await ipc.call('momoMemory:loops');
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.open.map((l: any) => l.id),
    [`L${CLOSED_SHOWN + 3}`],
  );
  assert.equal(r.closed.length, CLOSED_SHOWN);
  const a = await ipc.call('momoMemory:loopAct', `L${CLOSED_SHOWN + 3}`, { action: 'snooze', snooze: 'day' });
  assert.equal(a.loop.snoozedUntil, NOW + D);
  assert.ok(sent.includes('momoMemory:changed'));
  assert.deepEqual(await ipc.call('momoMemory:loopAct', 'nope', { action: 'done' }), { ok: false, error: 'No such open loop' });
  gate.allowed = false;
  assert.equal((await ipc.call('momoMemory:loops')).reason, 'not_allowed');
  sent.length = 0;
  await t.act(`L${CLOSED_SHOWN + 3}`, { action: 'done' });
  assert.deepEqual(sent, [], 'no window hears of it while MoMo is off');
  off();
  assert.equal(ipc.handlers.size, 0);
});

test('a store that can’t be read says memory is off', async () => {
  const safe = fakeSafe();
  safe.available = false;
  const t = await setup({ safe });
  const ipc = fakeIpc();
  registerLoopsIpc(ipc, { loops: t.loops, act: t.act, allowed: () => true });
  assert.equal((await ipc.call('momoMemory:loops')).reason, 'unavailable');
  // no broadcast given: a change tells nobody
  safe.available = true;
  await t.loops.applyPass({ add: [add('x y z w')], mention: [], done: [] }, SRC);
});

async function tools(o: any = {}) {
  const t = await setup(o);
  const registry = new Registry();
  registry.setApprover(async () => true);
  const gate = { allowed: true, momo: new Set(['momo-main', 'momo-pass']), pass: new Set(['momo-pass']) };
  const off = registerLoopTools(registry, {
    loops: t.loops,
    act: t.act,
    allowed: () => gate.allowed,
    isMomoChat: (id: string) => gate.momo.has(id),
    owner: o.owner ?? ((ctx: any) => ctx.chatId),
    passChat: (id: string) => gate.pass.has(id),
  });
  const call = (args: any, chatId = 'momo-main') => registry.invoke(chatId, 'claude:s1', 'momo_open_loops', args);
  const text = (r: any) => r.content.map((c: any) => c.text).join('');
  return { ...t, registry, gate, off, call, text };
}

test('the tool is listed only for MoMo’s own chats while MoMo is allowed; a call from elsewhere is refused', async () => {
  const t = await tools();
  const names = (chatId: string) => t.registry.list({ chatId }).map((x: any) => x.name);
  assert.deepEqual(names('momo-main'), ['momo_open_loops']);
  assert.deepEqual(names('coding-1'), []);
  assert.deepEqual(names('momo-pass'), [], 'a data-only pass chat never sees it');
  t.gate.allowed = false;
  assert.deepEqual(names('momo-main'), []);
  t.gate.allowed = true;
  for (const chat of ['coding-1', 'momo-pass']) assert.equal((await t.call({ action: 'list' }, chat)).error.code, 'unavailable');
  const stranger = await tools({ owner: () => null });
  assert.equal((await stranger.call({ action: 'list' })).error.code, 'unavailable');
  t.off();
  assert.deepEqual(names('momo-main'), []);
});

test('list shows each open loop with its words, day said, due and nudges; done, dismiss and snooze change one; reopen is the tab’s', async () => {
  const t = await tools();
  await t.loops.nudged('L1', { at: NOW, trigger: 'due', key: 'k' });
  await t.act('L2', { action: 'snooze', snooze: 'day' });
  const list = t.text(await t.call({ action: 'list' }));
  assert.ok(list.startsWith(`2 open loops (${DATA_NOTE}):`));
  assert.match(
    list,
    /- \[L1\] Renew the lease \(promise, sure; said 2030-03-18 12:00 UTC: "renew the lease"; due 2030-03-21 12:00 UTC; nudged 1×\)/,
  );
  assert.match(list, /- \[L2\] Call mum \(todo, sure; said .*; snoozed until 2030-03-21 12:00 UTC\)/);
  assert.equal(t.text(await t.call({ action: 'snooze', id: 'L1', snooze: 'week' })), 'Snoozed: "Renew the lease" (id L1).');
  assert.equal(t.text(await t.call({ action: 'done', id: 'L2' })), 'Marked done: "Call mum" (id L2).');
  assert.equal(t.text(await t.call({ action: 'dismiss', id: 'L1' })), 'Dismissed: "Renew the lease" (id L1).');
  assert.deepEqual(t.dismissed, ['promise']);
  assert.equal(t.text(await t.call({ action: 'list' })), 'No open loops.');
  assert.equal((await t.call({ action: 'reopen', id: 'L1' })).error.code, 'bad_args');
  assert.equal((await t.call({ action: 'done', id: 'gone' })).error.code, 'not_found');
  const one = await tools({ loops: [add('Only one')] });
  assert.match(one.text(await one.call({ action: 'list' })), /^1 open loop \(/);
});

test('a store that can’t be read, or fails otherwise, is said as such', async () => {
  const safe = fakeSafe();
  safe.available = false;
  const t = await tools({ safe });
  assert.equal((await t.call({ action: 'list' })).error.code, 'unavailable');
  const broken = await tools();
  broken.loops.open = () => {
    throw new Error('disk full');
  };
  const r = await broken.call({ action: 'list' });
  assert.equal(r.error.code, 'failed');
  assert.match(r.error.message, /MoMo's open loops could not be changed: disk full/);
  broken.loops.open = () => {
    throw 'odd';
  };
  assert.match((await broken.call({ action: 'list' })).error.message, /odd/);
});

test('closed loops with no time they were closed list last; a tool with no owner given refuses every call', async () => {
  const ipc = fakeIpc();
  const loops = {
    list: () => [
      { id: 'a', state: 'done' },
      { id: 'b', state: 'done', closedAt: 5 },
      { id: 'c', state: 'dismissed' },
    ],
    on: () => {},
    off: () => {},
  };
  registerLoopsIpc(ipc, { loops, act: async () => ({}), allowed: () => true });
  const r = await ipc.call('momoMemory:loops');
  assert.equal(r.closed[0].id, 'b');
  assert.deepEqual(
    r.closed
      .map((l: any) => l.id)
      .slice(1)
      .sort(),
    ['a', 'c'],
  );
  const registry = new Registry();
  registry.setApprover(async () => true);
  registerLoopTools(registry, { loops, act: async () => ({}), allowed: () => true, isMomoChat: () => true });
  assert.deepEqual(
    registry.list({ chatId: 'momo-main' }).map((x: any) => x.name),
    ['momo_open_loops'],
  );
  assert.equal((await registry.invoke('momo-main', 'claude:s1', 'momo_open_loops', { action: 'list' })).error.code, 'unavailable');
});
