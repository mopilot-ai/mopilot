// A paired phone's MoMo (electron/remote/methods/momo.cjs, electron/remote/momoOps.cjs): an account MoMo isn't allowed for gets no momo.* on any harness; MoMo's one main chat and only it; memory written only by memory.cjs and told to phones as "memory changed"; a routine a phone paused is skipped by the scheduler; the brain stays the Mac's unless it allows a phone; a momoAction card answered by a phone is audited with that device's id and the log still verifies.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';
import { sweep, START } from './support/momo-routines.ts';
import { ok, fail, UNINVITED, askSlow, SAMPLE, MOMO_METHODS, HARNESSES, momoRig } from './support/remote-momo-kit.ts';

const require = createRequire(import.meta.url);
const { parseParams } = require('../shared/remote/schema.mjs');
const { PANEL } = require('../electron/remote/service.cjs');
const { CHANGED_AREA } = require('../electron/remote/momoOps.cjs');
const { withMomoTasks } = require('../electron/momo/schedulerTasks.cjs');
const { Scheduler } = require('../electron/platform/scheduler.cjs');
const { RunLedger } = require('../electron/platform/runLedger.cjs');

test('an account MoMo is not allowed for gets no momo.* at all: not listed, every call refused before the schema and the operations', async () => {
  const r = rig({ momo: false });
  const touched: string[] = [];
  r.service.momo = () => new Proxy({}, { get: (_t, k) => (touched.push(String(k)), undefined) });
  const p = r.phone('p1');
  const hello = ok(await p.ask('machine.hello'));
  assert.ok(!('momo' in hello.capabilities || 'momoBrainSet' in hello.capabilities), 'no MoMo field, not even false');
  assert.deepEqual(
    hello.capabilities.methods.filter((m: string) => m.startsWith('momo.')),
    [],
  );
  assert.ok(MOMO_METHODS.length >= 15);
  for (const m of MOMO_METHODS) fail(await p.ask(m, SAMPLE[m] ?? {}), 'invalid', new RegExp(`^Unknown request: ${m.replace('.', '\\.')}`));
  // not even a method name the Mac doesn't have, or a bad param, tells an uninvited account anything more
  fail(await p.ask('momo.nothing', {}), 'invalid', /^Unknown request: momo\.nothing$/);
  fail(await p.ask('momo.memory.edit', { factId: '!!' }), 'invalid', /^Unknown request: momo\.memory\.edit$/);
  assert.deepEqual(touched, []);
  await assert.rejects(
    r.service.call(PANEL, 'momo.chat.stop', {}),
    /^Error: Unknown request: momo\.chat\.stop$|Unknown request: momo\.chat\.stop/,
  );
});

test('an invited account lists the methods; the panel never reaches MoMo; a method the Mac does not allow the device is forbidden', async () => {
  const r = rig({ momo: true, policy: { allow: (_pair: string, m: string) => m !== 'momo.brain.get' } });
  r.service.momo = () => ({});
  const p = r.phone('p1');
  const hello = ok(await p.ask('machine.hello'));
  assert.equal(hello.capabilities.momo, true);
  assert.ok(hello.capabilities.methods.includes('momo.chat.follow'));
  assert.ok(!hello.capabilities.methods.includes('momo.brain.get'));
  fail(await p.ask('momo.brain.get'), 'forbidden', /doesn't allow that from this device/);
  await assert.rejects(r.service.call(PANEL, 'momo.memory.list', {}), /doesn't allow that/);
  r.service.momo = () => null;
  fail(await p.ask('momo.chat.stop'), 'failed', /MoMo is not ready/);
});

test('the schema checks every MoMo request and names no chat', () => {
  for (const m of [
    'momo.chat.follow',
    'momo.chat.unfollow',
    'momo.chat.stop',
    'momo.memory.list',
    'momo.memory.docs',
    'momo.routines.list',
    'momo.brain.get',
  ])
    assert.deepEqual(parseParams(m, { chatId: 'other' }).chatId, undefined, m);
  assert.deepEqual(parseParams('momo.chat.follow', { items: 5000 }), { items: 200 });
  assert.deepEqual(parseParams('momo.chat.follow', {}), { items: 50 });
  assert.deepEqual(parseParams('momo.chat.send', { id: 'a', text: ' hi ', followUp: 'steer', chatId: 'other' }), {
    id: 'a',
    text: 'hi',
    followUp: 'steer',
  });
  assert.equal(parseParams('momo.chat.send', { id: 'a', text: 'hi' }).followUp, 'queue');
  const bad: [string, any, RegExp][] = [
    ['momo.chat.send', { id: 'a', text: '  ' }, /Type a message/],
    ['momo.chat.send', { id: 'a', text: 'x'.repeat(100_001) }, /too long/],
    ['momo.chat.send', { id: '', text: 'x' }, /Send that again/],
    ['momo.memory.search', { query: '  ' }, /what to look for/],
    ['momo.memory.edit', { factId: 'f', text: '' }, /Write the memory/],
    ['momo.memory.edit', { factId: 'f', text: 'x'.repeat(2001) }, /Write the memory/],
    ['momo.memory.edit', { factId: 'a b', text: 'x' }, /memories/],
    ['momo.memory.forget', {}, /memories/],
    ['momo.routines.pause', { id: 7 }, /routines/],
    ['momo.routines.approve', { id: 'r' }, /version is missing/],
    ['momo.brain.set', { brain: [] }, /Pick a brain/],
    ['momo.brain.set', {}, /Pick a brain/],
    ['momo.card.answer', { rev: 1, key: 'once' }, /Pick one/],
    ['momo.card.answer', { cardId: 'a', key: 'once' }, /already answered/],
    ['momo.card.answer', { cardId: 'a', rev: 1 }, /Pick one/],
  ];
  for (const [m, p, re] of bad)
    assert.throws(
      () => parseParams(m, p),
      (e: any) => e.code === 'invalid' && re.test(e.message),
      `${m} ${JSON.stringify(p)}`,
    );
  assert.deepEqual(parseParams('momo.memory.search', { query: ' tea ' }), { query: 'tea' });
  assert.deepEqual(parseParams('momo.card.answer', { cardId: 4, rev: 2, key: 'once', extra: 1 }), { cardId: 4, rev: 2, key: 'once' });
  assert.deepEqual(parseParams('momo.routines.approve', { id: 'r', seen: 2 }), { id: 'r', seen: 2 });
});

for (const harness of HARNESSES) {
  test(`${harness} as MoMo's brain: an uninvited account reaches no MoMo handler, and changes nothing`, async () => {
    const m = momoRig({ allowed: false, harness, remoteBrain: true });
    const p = m.r.phone('p1');
    for (const method of MOMO_METHODS) fail(await p.ask(method, SAMPLE[method] ?? {}), 'forbidden', UNINVITED);
    // the service's own gate is not the only one: the operations behind it refuse in main as well
    const ops = m.remote;
    const refused = (e: any) => e.code === 'forbidden';
    await assert.rejects(ops.mainChatId(), refused);
    await assert.rejects(ops.memory.list(), refused);
    await assert.rejects(ops.memory.edit('f1', 'x'), refused);
    await assert.rejects(ops.memory.forget('f1'), refused);
    await assert.rejects(ops.memory.docs(), refused);
    await assert.rejects(ops.routines.list(), refused);
    await assert.rejects(ops.routines.pause('r'), refused);
    await assert.rejects(ops.routines.approve('r', 1), refused);
    await assert.rejects(ops.routines.run('r'), refused);
    await assert.rejects(ops.brain.get(), refused);
    await assert.rejects(ops.brain.set({ harness }), refused);
    assert.throws(() => ops.state(), refused);
    assert.throws(() => ops.prefs.get(), refused);
    assert.throws(() => ops.assertAllowed(), refused);
    assert.throws(() => ops.prefs.set({ paused: false }), refused);
    await assert.rejects(ops.memory.changes(), refused);
    await assert.rejects(ops.memory.undo('c1'), refused);
    await assert.rejects(ops.memory.past(), refused);
    await assert.rejects(ops.memory.writeAboutYou('x'), refused);
    await assert.rejects(ops.loops.list(), refused);
    await assert.rejects(ops.loops.act('L1', { action: 'done' }), refused);
    await assert.rejects(ops.routines.edit('r', { name: 'x' }), refused);
    await assert.rejects(ops.routines.remove('r'), refused);
    await assert.rejects(ops.activity.list(), refused);
    assert.deepEqual([m.brains, m.sent, m.ran, m.store.list().facts], [[], [], [], []]);
    assert.deepEqual(m.told, []);
  });

  test(`${harness} as MoMo's brain: a phone reads it, and the Mac decides whether a phone may change it (off by default)`, async () => {
    const m = momoRig({ harness });
    const p = m.r.phone('p1');
    assert.deepEqual(ok(await p.ask('momo.brain.get')).brain, { harness, account: null, model: null });
    fail(await p.ask('momo.brain.set', { brain: { harness: 'claude' } }), 'forbidden', /Allow brain changes from this Mac/);
    assert.deepEqual(m.brains, []);
    m.gate.remoteBrain = true;
    assert.deepEqual(ok(await p.ask('momo.brain.set', { brain: { harness: 'claude' } })).brain, { harness: 'claude' });
    assert.deepEqual(m.brains, [{ harness: 'claude' }]);
  });
}

test('chat: a phone follows, sends to and stops MoMo’s main chat and cannot name another', async () => {
  const m = momoRig();
  const p = m.r.phone('p1');
  const snap = ok(await p.ask('momo.chat.follow', { items: 3, chatId: 'someone-elses' }));
  assert.equal(snap.chatId, 'momo-main');
  assert.ok(m.r.service.followers('momo-main').length === 1);
  // a send is main's: a human turn to MoMo's chat, the phone's request id kept so a retry is one send
  assert.deepEqual(ok(await p.ask('momo.chat.send', { id: 'r9', text: 'hello', followUp: 'steer', chatId: 'other' })), { sent: true });
  assert.deepEqual(m.sent, [
    ['momo-main', { id: 'r9', text: 'hello', attachments: [], opts: { human: true }, followUp: 'steer' }, null, true],
  ]);
  assert.deepEqual(ok(await p.ask('momo.chat.stop', { chatId: 'other' })), { stopped: true });
  assert.deepEqual(m.stopped, ['momo-main']);
  assert.deepEqual(ok(await p.ask('momo.chat.unfollow')), { unfollowed: true });
  assert.equal(m.r.service.followers('momo-main').length, 0);
  // a follow that fails does not stay followed
  m.r.ops.items = async () => {
    throw new Error('boom');
  };
  fail(await p.ask('momo.chat.follow', {}), 'failed', /boom/);
  assert.equal(m.r.service.followers('momo-main').length, 0);
  // a send the harness did not take says so
  m.controller.send = async () => ({ action: 'rejected', error: 'No harness.' }) as any;
  fail(await p.ask('momo.chat.send', { id: 'r10', text: 'x' }), 'send_uncertain', /may have reached/);
});

test('memory: a phone edits and forgets through memory.cjs, windows and phones are told what changed (no data), and nothing else writes', async () => {
  const m = momoRig();
  const p = m.r.phone('p1');
  const a = (await m.store.save({ text: 'Likes green tea', source: 'user', confidence: 'sure' })).fact;
  await m.store.save({ text: 'Lives in Lyon', source: 'user', confidence: 'sure' });
  assert.equal(ok(await askSlow(p, 'momo.memory.list')).facts.length, 2);
  assert.deepEqual(
    ok(await askSlow(p, 'momo.memory.search', { query: 'tea' })).facts.map((f: any) => f.id),
    [a.id],
  );
  const edited = ok(await askSlow(p, 'momo.memory.edit', { factId: a.id, text: 'Likes oolong' }));
  assert.equal(edited.fact.text, 'Likes oolong');
  // the store holds it: it was written by memory.cjs (sealed on disk), not by the phone layer
  assert.equal(m.store.list().facts.find((f: any) => f.id === a.id).text, 'Likes oolong');
  assert.ok(!fs.readdirSync(m.dir).some((f) => fs.readFileSync(path.join(m.dir, f)).includes('oolong')), 'sealed on disk');
  const docs = ok(await askSlow(p, 'momo.memory.docs'));
  assert.deepEqual(Object.keys(docs).sort(), ['aboutYou', 'persona', 'unreadable']);
  assert.deepEqual(ok(await askSlow(p, 'momo.memory.forget', { factId: a.id })).forgotten, true);
  fail(await askSlow(p, 'momo.memory.forget', { factId: a.id }), 'failed', /no longer in memory/);
  fail(await askSlow(p, 'momo.memory.edit', { factId: 'zzz', text: 'x' }), 'failed', /no longer in memory/);
  await settle();
  // two saves, the edit and the forget: each told to the windows, and to the phone as "memory changed" with nothing more
  assert.deepEqual(
    m.told.map(([ch]) => ch),
    Array(4).fill('momoMemory:changed'),
  );
  assert.deepEqual(
    p.events('momo.changed').map((e: any) => ({ ...e, id: undefined })),
    Array(4).fill({ id: undefined, t: 1000, kind: 'event', ev: 'momo.changed', area: 'memory' }),
  );
  // the only module that touches the memory files is memory.cjs; the phone layer has no file access
  const layer = fs.readFileSync('electron/remote/momoOps.cjs', 'utf8') + fs.readFileSync('electron/remote/methods/momo.cjs', 'utf8');
  // (momoMemory:writeFile is memory.cjs's IPC channel, which the phone layer calls like a window; it is not a file write)
  assert.doesNotMatch(layer, /require\(['"](node:)?fs['"]\)|ports\/fs|(?<!momoMemory:)writeFile|appendFile/);
});

test('a phone is told what changed only while MoMo is allowed, and only which part', async () => {
  const m = momoRig();
  const p = m.r.phone('p1');
  for (const area of Object.values(CHANGED_AREA)) m.r.service.onMomoChanged(area as any);
  await settle();
  assert.deepEqual(
    p.events('momo.changed').map((e: any) => e.area),
    ['memory', 'routines', 'sources', 'brain', 'channels'],
  );
  assert.ok(p.events('momo.changed').every((e: any) => Object.keys(e).sort().join() === 'area,ev,id,kind,t'));
  const off = rig({ momo: false });
  const q = off.phone('p1');
  off.service.onMomoChanged('memory');
  await settle();
  assert.deepEqual(q.events(), []);
  // a channel with no phone-facing meaning tells no phone
  m.wired.broadcast('momoChat:other', {});
  await settle();
  assert.equal(p.events('momo.changed').length, 5);
});

test('routines: a phone lists, approves a proposal of the version shown, pauses, resumes and runs now; the scheduler skips what a phone paused', async (t) => {
  const m = momoRig();
  const p = m.r.phone('p1');
  const { w } = m;
  w.c.t -= 86_400_000;
  const a = await w.routines.add({ ...sweep, name: 'Paused by phone' }, { approved: true });
  const b = await w.routines.add({ ...sweep, name: 'Left alone' }, { approved: true });
  const proposed = await w.routines.add({ ...sweep, name: 'Proposed' }, { approved: false });
  w.c.t += 86_400_000;
  const view = ok(await askSlow(p, 'momo.routines.list'));
  assert.deepEqual(
    view.proposals.map((x: any) => x.name),
    ['Proposed'],
  );
  assert.equal(view.routines.length, 2);
  // pause: the stored routine is paused, and the scheduler starts only the other one
  assert.equal(ok(await askSlow(p, 'momo.routines.pause', { id: a.id })).routine.status, 'PAUSED');
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ledger-'));
  t.after(() => fs.rmSync(ledgerDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ledgerDir, '.baseline'), '1');
  const ledger = new RunLedger({ dir: ledgerDir, now: w.c.now });
  const tasks = withMomoTasks({ list: async () => [], validate: async (x: any) => x, run: async () => 'x' }, () => w.service);
  const sched = new Scheduler({ enabled: () => false, ...tasks, sessions: w.sessions, ledger, now: w.c.now, tickMs: 0 });
  await sched.tick();
  assert.deepEqual(
    w.started.map((s) => s[1].routineId),
    [b.id],
  );
  assert.deepEqual(await ledger.list(a.id), []);
  assert.ok(w.c.t >= START);
  // resume counts from now (routineStore.cjs): the routine is active again
  assert.equal(ok(await askSlow(p, 'momo.routines.resume', { id: a.id })).routine.status, 'ACTIVE');
  // approve needs the version the phone was shown
  fail(await askSlow(p, 'momo.routines.approve', { id: proposed.id, seen: 99 }), 'failed');
  assert.equal(ok(await askSlow(p, 'momo.routines.approve', { id: proposed.id, seen: view.proposals[0].rev })).routine.approved, true);
  // run now: the scheduler's own run, for an approved routine only
  assert.deepEqual(ok(await askSlow(p, 'momo.routines.run', { id: b.id })), { started: true });
  assert.deepEqual(
    m.ran.map((x) => x.id),
    [b.id],
  );
  fail(await askSlow(p, 'momo.routines.run', { id: 'missing' }), 'gone', /routines/);
  // routines off: nothing to run
  const none = momoRig();
  const quiet = await none.w.routines.add({ ...sweep }, { approved: true });
  none.w.service.o.prefs = () => ({ momo: { routines: { proactivity: 'off' } } });
  fail(await askSlow(none.r.phone('p1'), 'momo.routines.run', { id: quiet.id }), 'failed', /routines are off/);
});
