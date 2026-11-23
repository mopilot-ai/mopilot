// Mobile Remote end to end, scenario 6: MoMo's methods behind the closed-alpha gate (the real access rule) and the Mac's brain-change switch, over the relay with MoMo's real handlers behind them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startRelay, startMac, startPhone, until, type Relay } from './support/mobileStack.ts';
import { momoRig, MOMO_METHODS, LOOPS_NOW } from './support/remote-momo-kit.ts';
import { sweep } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { decide } = require('../electron/momo/access.cjs');

/** MoMo behind the real closed-alpha rule: the server's invite (`features` on the account) decides, the Mac's switch decides the brain. */
async function momoPhone(relay: Relay, invited: boolean) {
  const account = { features: invited ? ['momo'] : [] };
  const m = momoRig({ allowed: invited });
  const allowed = () =>
    decide({
      status: { signedIn: true, user: { id: 'u1', features: account.features }, checkedAt: 1 },
      cache: null,
      flagOn: true,
      now: Date.now(),
    });
  const mac = await startMac(relay, { momoAllowed: allowed, momo: () => m.remote });
  m.live.chromePanel.service.onMomoChanged = (area: string) => mac.service.onMomoChanged(area);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  const invite = (on: boolean) => {
    account.features = on ? ['momo'] : [];
    m.gate.allowed = on;
  };
  return { m, mac, phone, invite };
}

test('an account that was never invited sees no MoMo: not offered, every call refused, nothing changed', async () => {
  const relay = await startRelay();
  const { m, phone } = await momoPhone(relay, false);
  const hello = await phone.ask('machine.hello');
  assert.ok(!('momo' in hello.capabilities || 'momoBrainSet' in hello.capabilities), 'no MoMo field, not even false');
  assert.deepEqual(
    hello.capabilities.methods.filter((x: string) => x.startsWith('momo.')),
    [],
  );
  for (const method of ['momo.chat.follow', 'momo.memory.list', 'momo.routines.list', 'momo.brain.get'])
    await assert.rejects(phone.ask(method), /Unknown request: momo\./, method);
  await assert.rejects(phone.ask('momo.chat.send', { id: 'r1', text: 'hi' }), /Unknown request: momo\.chat\.send/);
  assert.deepEqual([m.sent, m.stopped, m.brains], [[], [], []]);
});

test('an invited account gets MoMo’s methods, its main chat and its memory, and a granted invite shows up without a restart', async () => {
  const relay = await startRelay();
  const { m, phone, invite } = await momoPhone(relay, false);
  await assert.rejects(phone.ask('momo.chat.follow'), /Unknown request: momo\.chat\.follow/);
  invite(true);
  const hello = await phone.ask('machine.hello');
  assert.equal(hello.capabilities.momo, true);
  assert.deepEqual(hello.capabilities.methods.filter((x: string) => x.startsWith('momo.')).sort(), [...MOMO_METHODS].sort());

  // MoMo's one main chat; the phone cannot name another
  const snap = await phone.ask('momo.chat.follow', { items: 3, chatId: 'someone-elses' });
  assert.equal(snap.chatId, 'momo-main');
  assert.deepEqual(await phone.ask('momo.chat.send', { id: '11111111-1111-4111-8111-111111111111', text: 'hello' }), { sent: true });
  assert.equal(m.sent[0][0], 'momo-main');
  assert.equal(m.sent[0][1].text, 'hello');
  assert.deepEqual(await phone.ask('momo.chat.stop'), { stopped: true });
  assert.deepEqual(m.stopped, ['momo-main']);

  // memory through MoMo's own store: the phone is told which part changed, never what
  const fact = await m.store.save({ text: 'Likes green tea', source: 'user', confidence: 'sure' });
  const listed = await phone.ask('momo.memory.list');
  assert.deepEqual(
    listed.facts.map((f: any) => f.text),
    ['Likes green tea'],
  );
  await phone.ask('momo.memory.forget', { factId: fact.id ?? listed.facts[0].id });
  await until(() => phone.eventsOf('momo.changed').some((e) => e.area === 'memory'), 'the memory change notice');
  assert.deepEqual(
    Object.keys(phone.eventsOf('momo.changed').at(-1)).sort(),
    ['area', 'ev', 'id', 'kind', 't'],
    'a notice names the area and nothing else',
  );
  assert.deepEqual((await m.store.list()).facts, []);
});

test('the brain stays the Mac’s until its switch is on, and a revoked invite ends MoMo for the phone at once', async () => {
  const relay = await startRelay();
  const { m, phone, invite } = await momoPhone(relay, true);
  assert.equal((await phone.ask('machine.hello')).capabilities.momoBrainSet, false);
  assert.deepEqual((await phone.ask('momo.brain.get')).brain, { harness: 'codex', account: null, model: null });
  await assert.rejects(phone.ask('momo.brain.set', { brain: { harness: 'claude' } }), /Allow brain changes from this Mac/);
  assert.deepEqual(m.brains, []);

  m.gate.remoteBrain = true;
  assert.equal((await phone.ask('machine.hello')).capabilities.momoBrainSet, true);
  assert.deepEqual((await phone.ask('momo.brain.set', { brain: { harness: 'claude' } })).brain, { harness: 'claude' });
  assert.deepEqual(m.brains, [{ harness: 'claude' }]);

  invite(false);
  await assert.rejects(phone.ask('momo.brain.set', { brain: { harness: 'codex' } }), /Unknown request: momo\.brain\.set/);
  await assert.rejects(phone.ask('momo.memory.list'), /Unknown request: momo\.memory\.list/);
  assert.equal((await phone.ask('machine.hello')).capabilities.momoBrainSet, undefined);
  assert.deepEqual(m.brains, [{ harness: 'claude' }], 'nothing changed after the invite was withdrawn');
});

test('the sources status reaches the phone through the relay, follows the Mac and ends with the invite', async () => {
  const relay = await startRelay();
  const { m, phone } = await momoPhone(relay, true);
  await phone.ask('momo.chat.follow', {});
  // nothing connected yet: the first-run status; a change on the Mac is announced without saying what
  assert.deepEqual(await phone.ask('momo.sources.status'), { calendar: false, reminders: false });
  m.sourceList.sources = [{ id: 'calendar', connected: true }];
  m.wired.broadcast('momoSources:changed');
  await until(() => phone.eventsOf('momo.changed').some((e) => e.area === 'sources'), 'the sources change notice');
  assert.deepEqual(await phone.ask('momo.sources.status'), { calendar: true, reminders: false });
  // an invite withdrawn ends the status like every other MoMo call
  m.gate.allowed = false;
  await assert.rejects(phone.ask('momo.sources.status'), /MoMo isn't available|not available/);
});

test('a paused MoMo over the relay: the user’s own writes go through, only Run now returns the paused reason, and Resume brings it back (#3648)', async () => {
  const relay = await startRelay();
  const { m, phone } = await momoPhone(relay, true);
  const routine = await m.w.routines.add({ ...sweep, name: 'Sweep' }, { approved: true });
  const D = 86_400_000;
  await m.loops.applyPass(
    {
      add: [
        {
          kind: 'todo',
          text: 'Call mum',
          quote: 'call mum',
          line: { text: 'Call mum', at: LOOPS_NOW - D, turnId: 't1' },
          tz: 'UTC',
          confidence: 'sure',
        },
      ],
      mention: [],
      done: [],
    },
    { chatId: 'momo-main', harness: 'claude' },
  );
  const fact = (await m.store.save({ text: 'Likes green tea', source: 'user', confidence: 'sure' })).fact;
  m.gate.paused = true;
  assert.equal((await phone.ask('momo.state.get')).status, 'paused');

  // the user's own direct writes, as on the Mac
  assert.equal((await phone.ask('momo.prefs.set', { proactivity: 'low' })).paused, true, 'changing a setting does not resume MoMo');
  assert.deepEqual(await phone.ask('momo.memory.writeDoc', { doc: 'aboutYou', text: 'I teach piano.' }), { written: true });
  assert.equal((await phone.ask('momo.memory.edit', { factId: fact.id, text: 'Likes oolong' })).fact.text, 'Likes oolong');
  const change = (await phone.ask('momo.memory.changes')).changes.find((c: any) => c.undoable);
  await phone.ask('momo.memory.undo', { changeId: change.id });
  assert.equal((await m.store.list()).facts.find((f: any) => f.id === fact.id).text, 'Likes green tea', 'the undo put the fact back');
  const loopId = (await phone.ask('momo.loops.list')).open[0].id;
  assert.equal((await phone.ask('momo.loops.act', { loopId, action: 'done' })).loop.state, 'done');
  assert.equal((await phone.ask('momo.routines.pause', { id: routine.id })).routine.status, 'PAUSED');
  assert.equal((await phone.ask('momo.routines.resume', { id: routine.id })).routine.status, 'ACTIVE');
  assert.deepEqual(await phone.ask('momo.chat.send', { id: '22222222-2222-4222-8222-222222222222', text: 'still there?' }), { sent: true });

  // MoMo's own work is what a pause holds
  await assert.rejects(phone.ask('momo.routines.run', { id: routine.id }), /MoMo is paused/);
  assert.deepEqual(m.ran, []);

  // resumed, Run now starts
  m.gate.paused = false;
  assert.deepEqual(await phone.ask('momo.routines.run', { id: routine.id }), { started: true });
  assert.deepEqual(
    m.ran.map((r: any) => r.id),
    [routine.id],
  );
});

test('a message typed for MoMo while the Mac is away waits in the outbox under one send id and goes once as momo.chat.send when the Mac is back', async () => {
  const relay = await startRelay();
  const { m, mac, phone } = await momoPhone(relay, true);
  const pairId = phone.snap().pairs[0].pairId;
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait for the Mac');
  const id = phone.runtime.send('momo', 'remind me at five', [], [], true);
  const waiting = phone.snap().outbox;
  assert.deepEqual(
    waiting.map((i: any) => [i.id, i.chatId, i.text, i.status, i.momo]),
    [[id, 'momo', 'remind me at five', 'queued', true]],
  );
  assert.deepEqual(m.sent, [], 'nothing reached MoMo while the Mac was away');
});

test('a MoMo message sent while the Mac is there goes at once as momo.chat.send under its send id and leaves the outbox', async () => {
  const relay = await startRelay();
  const { m, phone } = await momoPhone(relay, true);
  const id = phone.runtime.send('momo', 'plan my day', [], [], true);
  await until(() => phone.snap().outbox.length === 0 && m.sent.length === 1, 'the message to reach MoMo');
  assert.equal(m.sent[0][1].text, 'plan my day');
  assert.equal(m.sent[0][1].id, id, 'the Mac de-duplicates by the id the message was typed with');
});
