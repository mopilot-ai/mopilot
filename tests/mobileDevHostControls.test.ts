// The dev host's switches and the fake MoMo: MoMo allowed or not, the brain-change setting, the Mac sleeping, dropping off the network, the relay restarting and the Mac removing a phone; MoMo's memory, routines, brain and main chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './support/mobileStack.ts';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeMomo } from '../scripts/mobile-dev-host/fakeMomo.mjs';

function controlsRig(
  o: {
    noRelay?: boolean;
    phones?: { id: string; name: string; pairId: string }[];
    unpairs?: boolean;
    restartFails?: boolean;
    relayState?: string;
    taskCard?: () => boolean;
    draft?: (shape: string) => Promise<string>;
    options?: (shape: string) => Promise<string>;
    report?: (shape: string) => Promise<string>;
    recipientsCard?: (shape: string) => Promise<string>;
  } = {},
) {
  const log: string[] = [];
  const bench = { momo: false, brain: false, tasks: true, voice: 'on' };
  const presence: string[] = [];
  const cuts: number[] = [];
  const momoSwitches: boolean[] = [];
  const titleSwitches: boolean[] = [];
  const later: { ms: number; fn: () => void }[] = [];
  const changed: string[] = [];
  const restarts: number[] = [];
  const unpaired: string[][] = [];
  const gaps: [number, string | undefined][] = [];
  const phones = o.phones ?? [{ id: 'd1', name: 'Du’s iPhone', pairId: 'p1' }];
  const controls = createControls({
    bench,
    relayClient: () =>
      o.noRelay ? null : { state: o.relayState ?? 'open', setPresence: (s: 'online' | 'sleeping') => void presence.push(s) },
    cutMac: (ms: number) => void cuts.push(ms),
    momoSwitched: (on: boolean) => void momoSwitches.push(on),
    ...(o.taskCard && { momoTaskCard: async () => o.taskCard!() }),
    ...(o.draft && { momoDraft: o.draft }),
    ...(o.options && { momoOptions: o.options }),
    ...(o.report && { momoReport: o.report }),
    ...(o.recipientsCard && { momoRecipientsCard: o.recipientsCard }),
    advanceCounters: async (n: number, pairId?: string) => (gaps.push([n, pairId]), `gap: advanced ${n}`),
    restartRelay: async (ms: number) => {
      restarts.push(ms);
      if (o.restartFails) throw new Error('port taken');
    },
    devices: () => phones,
    unpair: async (id: string, pairId: string) => (unpaired.push([id, pairId]), o.unpairs !== false),
    changed: (area: string) => void changed.push(area),
    after: (ms: number, fn: () => void) => void later.push({ ms, fn }),
    log: (l: string) => void log.push(l),
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async (on: boolean) => void titleSwitches.push(on),
    chatTitle: () => null,
  });
  return { controls, bench, log, titleSwitches, presence, cuts, momoSwitches, later, changed, restarts, unpaired, gaps };
}

test('MoMo and the brain-change setting flip, tell the phones, and say what to do next', () => {
  const r = controlsRig();
  assert.deepEqual(r.momoSwitches, []);
  assert.match(r.controls.momo(true), /^MoMo is on: the phone learns it at its next machine\.hello/);
  assert.equal(r.bench.momo, true);
  assert.match(r.controls.brainSwitch(true), /^brain changes from the phone are on$/);
  assert.equal(r.bench.brain, true);
  r.controls.momo(false);
  assert.deepEqual(r.momoSwitches, [true, false]);
  assert.match(r.controls.brainSwitch(false), /are off \(MoMo itself is off: run momo on\)$/);
  assert.deepEqual(r.changed, ['brain', 'brain', 'brain', 'brain']);
  assert.deepEqual(r.log, [
    'bench: MoMo on for this account',
    'bench: brain changes from the phone on',
    'bench: MoMo off for this account',
    'bench: brain changes from the phone off',
  ]);
});

test('sleep keeps the link and wakes later; unplug cuts the Mac off at the relay for a while', () => {
  const r = controlsRig();
  assert.match(r.controls.sleep(5), /back in 5s/);
  assert.deepEqual(r.presence, ['sleeping']);
  assert.equal(r.later[0].ms, 5000);
  r.later[0].fn();
  assert.deepEqual(r.presence, ['sleeping', 'online']);
  assert.match(r.controls.unplug(7), /reconnects by itself within a few seconds after 7s/);
  assert.deepEqual(r.cuts, [7000]);
  assert.equal(r.later[1].ms, 7000);
  r.later[1].fn();
  assert.ok(r.log.includes('bench: the Mac woke up') && r.log.includes('bench: the Mac may reconnect now'));
  const off = controlsRig({ noRelay: true });
  assert.throws(() => off.controls.sleep(1), /Mobile Remote is not running/);
  assert.throws(() => off.controls.unplug(1), /Mobile Remote is not running/);
  assert.deepEqual(off.cuts, []);
});

test('an earlier sleep’s timer does not wake the Mac in the middle of a later sleep', () => {
  const r = controlsRig();
  r.controls.sleep(20);
  r.controls.sleep(5);
  r.later[0].fn();
  assert.deepEqual(r.presence, ['sleeping', 'sleeping'], 'the first timer is stale');
  r.later[1].fn();
  assert.deepEqual(r.presence, ['sleeping', 'sleeping', 'online']);
});

test('the relay restart reports when it is back, or why it is not', async () => {
  const r = controlsRig();
  assert.match(r.controls.restartRelay(3), /down for 3s/);
  await until(() => r.log.includes('bench: the relay restart finished'), 'the relay to come back');
  assert.deepEqual(r.restarts, [3000]);
  const bad = controlsRig({ restartFails: true });
  bad.controls.restartRelay(1);
  await until(() => bad.log.some((l) => l.includes('the relay restart failed: port taken')), 'the failure to be logged');
});

test('revoke removes the numbered paired phone, or says why it cannot', async () => {
  const r = controlsRig({
    phones: [
      { id: 'd1', name: 'One', pairId: 'p1' },
      { id: 'd2', name: 'Two', pairId: 'p2' },
    ],
  });
  assert.match(await r.controls.revoke(2), /^Two was removed on the Mac/);
  assert.deepEqual(r.unpaired, [['d2', 'p2']]);
  await assert.rejects(r.controls.revoke(3), /No paired phone number 3 \(there are 2\)\./);
  await assert.rejects(controlsRig({ phones: [] }).controls.revoke(1), /No phone is paired\./);
  await assert.rejects(controlsRig({ unpairs: false }).controls.revoke(1), /could not remove Du’s iPhone/);
  // with the link down the phone would not be told, so nothing is removed
  const down = controlsRig({ relayState: 'backoff' });
  await assert.rejects(down.controls.revoke(1), /not connected to the relay, so the phone would not be told/);
  assert.deepEqual(down.unpaired, []);
  await assert.rejects(controlsRig({ noRelay: true }).controls.revoke(1), /Mobile Remote is not running/);
});

function momoRig(allowBrain = false) {
  const app = createFakeApp({ repo: '/repo', now: () => 1_000_000, sleep: async () => undefined, status: async () => ' M a\n' });
  const told: string[] = [];
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const momo = createFakeMomo({
    app,
    brainChangeAllowed: () => allowBrain,
    changed: (a: string) => void told.push(a),
    now: () => 1_000_000,
  });
  return { app, momo, told };
}

test('report puts a routine’s report in MoMo’s main chat, tells the phones the chat changed, and off takes it out', async () => {
  const { app, momo, told } = momoRig();
  assert.match(await momo.report('done'), /one-line report card/);
  const rows = () => app.chats.get('dev-momo-main').rows.filter((r: any) => r.role === 'user' && /not from the user/.test(r.text));
  assert.equal(rows().length, 1);
  assert.deepEqual(told, ['chat']);
  assert.match(await momo.report('off'), /1 report removed/);
  assert.equal(rows().length, 0);
});

test('MoMo’s main chat is made once, stays out of the chat list, and runs turns with cards', async () => {
  const { app, momo } = momoRig();
  assert.equal(await momo.mainChatId(), 'dev-momo-main');
  assert.equal(await momo.mainChatId(), 'dev-momo-main');
  assert.ok(!(await app.ops.recent(50)).some((c: any) => c.id === 'dev-momo-main'), 'hidden from the list');
  assert.equal((await app.ops.read('dev-momo-main')).rows.length, 1);
  assert.equal(await momo.send('dev-momo-main', { id: 's1', text: 'hello MoMo' }), null);
  assert.equal(await momo.send('dev-momo-main', { id: 's1', text: 'hello MoMo' }), null, 'a retried send runs once');
  assert.equal((await app.ops.read('dev-momo-main')).rows.filter((r: any) => r.role === 'user').length, 1);
  assert.equal(app.ops.reachable('dev-momo-main'), false, 'only the momo.* methods reach it');
  await until(
    () => momo.cardOf('dev-momo-main', 'nope') === null && app.ops.cardsOf('dev-momo-main').then((c: any[]) => c.length),
    'the card',
  );
  const [card] = await app.ops.cardsOf('dev-momo-main');
  assert.equal(momo.cardOf('dev-momo-main', card.id).id, card.id);
  assert.equal(momo.cardOf('dev-momo-main', 'nope'), null);
  assert.equal(momo.answerCard({ id: card.id }, 'once'), true);
  assert.equal(momo.answerCard({ id: card.id }, 'once'), false, 'a card answers once');
  await app.idle();
  await momo.send('dev-momo-main', { id: 's2', text: 'again' });
  await momo.stop('dev-momo-main');
  await app.idle();
});

test('memory: list, search, edit and forget, telling the phones what changed', async () => {
  const { momo, told } = momoRig();
  const all = await momo.memory.list();
  assert.equal(all.facts.length, 3);
  assert.equal(all.now, 1_000_000);
  assert.deepEqual(
    (await momo.memory.search('TEA')).facts.map((f: any) => f.id),
    ['f1'],
  );
  assert.deepEqual((await momo.memory.search('nothing like this')).facts, []);
  assert.equal((await momo.memory.edit('f1', 'Likes black tea')).fact.text, 'Likes black tea');
  assert.deepEqual(await momo.memory.forget('f2'), {});
  assert.equal((await momo.memory.list()).facts.length, 2);
  await assert.rejects(momo.memory.edit('zzz', 'x'), /not in MoMo’s memory/);
  await assert.rejects(momo.memory.forget('zzz'), /not in MoMo’s memory/);
  assert.deepEqual(told, ['memory', 'memory']);
  assert.deepEqual(Object.keys(await momo.memory.docs()), ['aboutYou', 'persona', 'unreadable']);
});

test('routines: pause, resume, approve a proposal that has not changed, and run', async () => {
  const { app, momo, told } = momoRig();
  assert.equal((await momo.routines.list()).proposals.length, 1);
  assert.equal((await momo.routines.pause('r1')).paused, true);
  assert.equal((await momo.routines.resume('r2')).paused, false);
  await assert.rejects(momo.routines.pause('zzz'), /isn't one of MoMo's routines/);
  await assert.rejects(momo.routines.approve('p1', 99), /changed/);
  await assert.rejects(momo.routines.approve('zzz', 1), /changed/);
  const made = await momo.routines.approve('p1', 1);
  assert.equal(made.id, 'r-p1');
  const list = await momo.routines.list();
  assert.deepEqual([list.proposals.length, list.routines.length], [0, 3]);
  await momo.routines.run('r1');
  await assert.rejects(momo.routines.run('zzz'), /isn't one of MoMo's routines/);
  assert.deepEqual(told, ['routines', 'routines', 'routines']);
  await until(async () => (await app.ops.cardsOf('dev-momo-main')).length > 0, 'the routine to ask');
  await app.ops.stop('dev-momo-main');
  await app.idle();
});

test('the brain is read and changed, and the Mac’s setting is reported as it is', async () => {
  const off = momoRig(false);
  assert.equal(off.momo.brain.allowedToSet(), false);
  assert.equal((await off.momo.brain.get()).brain.modelLabel, 'Dev Fast');
  const on = momoRig(true);
  assert.equal(on.momo.brain.allowedToSet(), true);
  assert.equal(
    (await on.momo.brain.set({ harness: 'claude', account: null, model: 'dev-deep', modelLabel: 'Dev Deep' })).brain.harness,
    'claude',
  );
  assert.equal((await on.momo.brain.get()).brain.modelLabel, 'Dev Deep');
  assert.deepEqual(on.told, ['brain']);
});

test('chat titles in push switch on and off on the Mac, and need Mobile Remote to be running', async () => {
  const r = controlsRig();
  assert.match(await r.controls.titles(true), /^chat titles in push are on: the phone gets its title key, then run push seals each title$/);
  assert.equal(await r.controls.titles(false), 'chat titles in push are off');
  assert.deepEqual(r.titleSwitches, [true, false]);
  assert.deepEqual(r.log, ['bench: chat titles in push on', 'bench: chat titles in push off']);
  const stopped = controlsRig({ noRelay: true });
  await assert.rejects(() => stopped.controls.titles(true), /Mobile Remote is not running/);
  assert.deepEqual(stopped.titleSwitches, []);
});

test('momoRecipients puts a send card up by shape, says when MoMo is off, and refuses a shape it has not got (#4649)', async () => {
  const shapes: string[] = [];
  const r = controlsRig({ recipientsCard: async (shape) => (shapes.push(shape), `Card ${shape}`) });
  assert.match(await r.controls.momoRecipients('many'), /^MoMo asks "Card many" \(MoMo itself is off: run momo on\)$/);
  r.bench.momo = true;
  assert.equal(await r.controls.momoRecipients('blocked'), 'MoMo asks "Card blocked"');
  assert.deepEqual(shapes, ['many', 'blocked']);
  await assert.rejects(r.controls.momoRecipients('maybe'), /Say one of three, many, blocked, off\./);
  // with no MoMo behind it the control says so
  await assert.rejects(controlsRig().controls.momoRecipients('three'), /MoMo is not running/);
});

test('momoTasks lists or hides the Tasks method, putting a card up once when it lists it', async () => {
  const r = controlsRig({ taskCard: () => true });
  assert.match(
    await r.controls.momoTasks(true),
    /^momo\.tasks\.list is on \(a card is up in MoMo’s chat\) \(MoMo itself is off: run momo on\): the phone learns it at its next machine\.hello/,
  );
  assert.equal(r.bench.tasks, true);
  r.controls.momo(true);
  assert.match(await r.controls.momoTasks(false), /^momo\.tasks\.list is off: the phone learns it/);
  assert.equal(r.bench.tasks, false);
  assert.deepEqual(r.log.slice(-1), ['bench: the Mac does not list momo.tasks.list']);
  // no card to raise (already up, or no MoMo to raise it in)
  const quiet = controlsRig();
  assert.doesNotMatch(await quiet.controls.momoTasks(true), /a card is up/);
});

test('momoDraft puts a draft MoMo wrote in its chat and says whether MoMo itself is on; with no MoMo running it says so', async () => {
  const shapes: string[] = [];
  const r = controlsRig({ draft: async (shape) => (shapes.push(shape), `a ${shape} draft`) });
  assert.equal(await r.controls.momoDraft('one'), 'a one draft (MoMo itself is off: run momo on)');
  r.controls.momo(true);
  assert.equal(await r.controls.momoDraft('long'), 'a long draft');
  assert.deepEqual(shapes, ['one', 'long']);
  await assert.rejects(() => controlsRig().controls.momoDraft('one'), /MoMo is not running/);
});

test('momoOptions puts a question with answer chips in MoMo’s chat and says whether MoMo itself is on; with no MoMo running it says so', async () => {
  const shapes: string[] = [];
  const r = controlsRig({ options: async (shape) => (shapes.push(shape), `a ${shape} question`) });
  assert.equal(await r.controls.momoOptions('on'), 'a on question (MoMo itself is off: run momo on)');
  r.controls.momo(true);
  assert.equal(await r.controls.momoOptions('off'), 'a off question');
  assert.deepEqual(shapes, ['on', 'off']);
  await assert.rejects(() => controlsRig().controls.momoOptions('on'), /MoMo is not running/);
});

test('momoReport puts a routine’s report in MoMo’s chat and says whether MoMo itself is on; with no MoMo running it says so', async () => {
  const shapes: string[] = [];
  const r = controlsRig({ report: async (shape) => (shapes.push(shape), `a ${shape} report`) });
  assert.equal(await r.controls.momoReport('done'), 'a done report (MoMo itself is off: run momo on)');
  r.controls.momo(true);
  assert.equal(await r.controls.momoReport('off'), 'a off report');
  assert.deepEqual(shapes, ['done', 'off']);
  await assert.rejects(() => controlsRig().controls.momoReport('done'), /MoMo is not running/);
});

test('momoVoice sets what a MoMo voice note comes back as, or hides the method as an older Mac would', () => {
  const r = controlsRig();
  assert.match(r.controls.momoVoice('fail'), /^momo\.chat\.transcribe is fail \(MoMo itself is off: run momo on\): the phone learns it/);
  assert.equal(r.bench.voice, 'fail');
  assert.deepEqual(r.log.slice(-1), ['bench: MoMo voice notes come back as: fail']);
  r.controls.momo(true);
  assert.match(r.controls.momoVoice('off'), /^momo\.chat\.transcribe is off: the phone learns it/);
  assert.equal(r.bench.voice, 'off');
  assert.deepEqual(r.log.slice(-1), ['bench: MoMo voice notes are not listed by the Mac']);
});

test('advanceTx moves the counters through the host and says when the phone sees it', async () => {
  const r = controlsRig();
  assert.match(await r.controls.advanceTx(5000), /^gap: advanced 5000: the phone sees it on the next frame/);
  await r.controls.advanceTx(7, 'p1');
  assert.deepEqual(r.gaps, [
    [5000, undefined],
    [7, 'p1'],
  ]);
  assert.deepEqual(r.log, ['bench: gap: advanced 5000', 'bench: gap: advanced 7']);
});
