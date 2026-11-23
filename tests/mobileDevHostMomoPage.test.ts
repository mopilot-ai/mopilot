// The fake MoMo behind the phone's MoMo page and chat in the dev host: its state and pause, settings, sources, reminders, what MoMo learned, routine edits, and the reminder command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeMomo, VOICE_TEXT, voiceOps } from '../scripts/mobile-dev-host/fakeMomo.mjs';
import { momoScenarios } from '../scripts/mobile-dev-host/scenariosMomo.mjs';

function rig() {
  const app = createFakeApp({ repo: '/repo', now: () => 1_000_000, sleep: async () => undefined, status: async () => ' M a\n' });
  const told: string[] = [];
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const momo = createFakeMomo({ app, brainChangeAllowed: () => true, changed: (a: string) => void told.push(a), now: () => 1_000_000 });
  return { app, momo, told };
}

test('state: online with nothing waiting, paused after a pause, and counting a card MoMo asks', async () => {
  const { app, momo } = rig();
  assert.deepEqual(await momo.state(), { name: 'MoMo', color: 'orange', status: 'online', needsYou: 0 });
  await momo.mainChatId();
  assert.equal((await momo.state()).needsYou, 0);
  await momo.send('dev-momo-main', { id: 's1', text: 'hello' });
  const { until } = await import('./support/mobileStack.ts');
  await until(async () => (await app.ops.cardsOf('dev-momo-main')).length > 0, 'the card');
  assert.equal((await momo.state()).needsYou, 1);
  momo.prefs.set({ paused: true });
  assert.equal((await momo.state()).status, 'paused');
  await app.ops.stop('dev-momo-main');
  await app.idle();
});

test('Run now is refused while paused, with the Mac’s own words, and allowed once resumed', () => {
  const { momo } = rig();
  momo.awake();
  momo.prefs.set({ paused: true });
  assert.throws(() => momo.awake(), /MoMo is paused\. Resume it first\./);
  momo.prefs.set({ paused: false });
  momo.awake();
});

test('settings: one setting per call, answered whole, with quiet hours copied out', () => {
  const { momo, told } = rig();
  const first = momo.prefs.get();
  assert.deepEqual(first, {
    paused: false,
    proactivity: 'default',
    quietHours: null,
    levels: [{ id: 'off' }, { id: 'low' }, { id: 'default' }, { id: 'high' }],
  });
  const after = momo.prefs.set({ quietHours: { start: '22:00', end: '07:00' } });
  assert.deepEqual(after.quietHours, { start: '22:00', end: '07:00' });
  after.quietHours!.start = '00:00';
  assert.equal(momo.prefs.get().quietHours!.start, '22:00', 'a reader cannot change what MoMo keeps');
  assert.equal(momo.prefs.set({ proactivity: 'low' }).proactivity, 'low');
  assert.deepEqual(told, ['prefs', 'prefs']);
});

test('sources and activity answer what the phone asks', async () => {
  const { momo } = rig();
  assert.deepEqual(await momo.sources.status(), { calendar: true, reminders: false });
  assert.deepEqual(await momo.activity.list(), { items: [] });
});

test('a reminder lands in MoMo’s chat with its loop; each answer closes it, and a closed one is refused', async () => {
  const { app, momo, told } = rig();
  const first = await momo.remind();
  const second = await momo.remind('Call the bank');
  const rows = (await app.ops.read('dev-momo-main')).rows;
  assert.deepEqual(
    rows.filter((r: any) => r.nudge).map((r: any) => [r.role, r.text, r.nudge.loopId, r.at]),
    [
      ['note', 'Reminder 1', first, 1_000_000],
      ['note', 'Call the bank', second, 1_000_000],
    ],
  );
  assert.equal((await momo.loops.list()).loops.length, 2);
  assert.deepEqual(await momo.loops.act(first, { action: 'done' }), { loopId: first, action: 'done' });
  assert.deepEqual(
    (await momo.loops.list()).loops.map((l: any) => l.loopId),
    [second],
  );
  await assert.rejects(momo.loops.act(first, { action: 'dismiss' }), /already closed/);
  assert.deepEqual(told, ['chat', 'chat', 'chat']);
});

test('what MoMo learned: the newest first, one change taken back once, the past, and About you', async () => {
  const { momo, told } = rig();
  const { changes } = await momo.memory.changes();
  assert.deepEqual(
    changes.map((c: any) => [c.id, c.undoable]),
    [
      ['c2', true],
      ['c1', false],
    ],
  );
  await assert.rejects(momo.memory.undo('c1'), /can no longer be undone/);
  await assert.rejects(momo.memory.undo('zzz'), /can no longer be undone/);
  await momo.memory.edit('f2', 'Release notes go out on Thursdays');
  assert.deepEqual(await momo.memory.undo('c2'), { undone: true });
  assert.equal((await momo.memory.list()).facts.find((f: any) => f.id === 'f2')?.text, 'Release notes go out on Fridays');
  await assert.rejects(momo.memory.undo('c2'), /can no longer be undone/);
  assert.equal((await momo.memory.changes()).changes[0].undone, 1_000_000);
  assert.deepEqual((await momo.memory.past()).facts, [{ id: 'x1', text: 'Release notes go out on Fridays' }]);
  await momo.memory.writeAboutYou('Du prefers email.');
  assert.equal((await momo.memory.docs()).aboutYou, 'Du prefers email.');
  assert.deepEqual(told, ['memory', 'memory', 'memory']);
});

test('an undo of a change whose fact is gone only marks it taken back', async () => {
  const { momo } = rig();
  await momo.memory.forget('f2');
  assert.deepEqual(await momo.memory.undo('c2'), { undone: true });
});

test('routines: edit a name or prompt, delete a routine, decline a suggested one', async () => {
  const { momo, told } = rig();
  assert.equal((await momo.routines.edit('r1', { name: 'Morning digest', prompt: 'Short.' })).name, 'Morning digest');
  await assert.rejects(momo.routines.edit('zzz', { name: 'x' }), /isn't one of MoMo's routines/);
  await momo.routines.remove('r2');
  await momo.routines.remove('p1');
  const list = await momo.routines.list();
  assert.deepEqual([list.proposals.length, list.routines.map((r: any) => r.id)], [0, ['r1']]);
  await assert.rejects(momo.routines.remove('r2'), /isn't one of MoMo's routines/);
  assert.deepEqual(told, ['routines', 'routines', 'routines']);
});

test('the reminder command: MoMo raises one, and says when MoMo itself is off', async () => {
  const titles: (string | undefined)[] = [];
  const mk = (on: boolean) =>
    createControls({
      bench: { momo: on, brain: false, tasks: true, voice: 'on' },
      relayClient: () => null,
      cutMac: () => undefined,
      advanceCounters: async () => '',
      momoSwitched: () => undefined,
      momoRemind: async (title?: string) => (titles.push(title), 'loop'),
      restartRelay: async () => undefined,
      devices: () => [],
      unpair: async () => true,
      changed: () => undefined,
      after: () => undefined,
      log: () => undefined,
      pushRequest: async () => 'sent',
      seal: () => null,
      setTitles: async () => undefined,
      chatTitle: () => null,
    });
  assert.equal(await mk(true).remind('Call the bank'), 'MoMo raised a reminder');
  assert.equal(await mk(false).remind(undefined), 'MoMo raised a reminder (MoMo itself is off: run momo on)');
  assert.deepEqual(titles, ['Call the bank', undefined]);
  // with no MoMo behind the host there is nothing to remind from
  const bare = createControls({
    bench: { momo: true, brain: false, tasks: true, voice: 'on' },
    relayClient: () => null,
    cutMac: () => undefined,
    advanceCounters: async () => '',
    momoSwitched: () => undefined,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: () => undefined,
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  });
  await assert.rejects(bare.remind(undefined), /MoMo is not running/);
});

test('tasks: a routine run, two reminders and a card, the snoozed one left out, and the loop acts change the list', async () => {
  const { app, momo, told } = rig();
  const first = await momo.tasks.list();
  assert.deepEqual(
    first.tasks.map((t: any) => [t.id, t.kind, t.title]),
    [
      ['loop:tl1', 'loop', 'Renew the lease'],
      ['run:dev-run-1', 'run', 'Morning brief'],
    ],
    'tl2 is snoozed out of the list',
  );
  assert.equal(first.now, 1_000_000);
  // a reminder MoMo raised is a task too
  const reminder = await momo.remind('Call mum');
  assert.ok((await momo.tasks.list()).tasks.some((t: any) => t.id === `loop:${reminder}`));
  // a card in MoMo's chat comes first, once
  assert.equal(await momo.tasks.raiseCard(), true);
  assert.equal(await momo.tasks.raiseCard(), false);
  const { until } = await import('./support/mobileStack.ts');
  await until(async () => (await app.ops.cardsOf('dev-momo-main')).length > 0, 'the card');
  const withCard = (await momo.tasks.list()).tasks;
  assert.deepEqual([withCard[0].kind, withCard[0].title], ['card', 'Send the weekly summary to the team?']);
  // answering the card ends the turn and the card leaves the list
  assert.equal(app.answerCard('dev-momo-main', (await app.ops.cardsOf('dev-momo-main'))[0].id, 'once'), true);
  await app.idle();
  assert.equal(
    (await momo.tasks.list()).tasks.some((t: any) => t.kind === 'card'),
    false,
  );
  // Snooze takes a loop out for a day or a week, Done and Dismiss close it
  assert.deepEqual(await momo.loops.act('tl1', { action: 'snooze' }), { loopId: 'tl1', action: 'snooze' });
  assert.equal(
    (await momo.tasks.list()).tasks.some((t: any) => t.id === 'loop:tl1'),
    false,
  );
  await momo.loops.act('tl2', { action: 'snooze', snooze: 'week' });
  await momo.loops.act('tl2', { action: 'dismiss' }).catch(() => undefined);
  assert.ok(told.includes('memory'));
  await app.ops.stop('dev-momo-main');
  await app.idle();
});

test('tasks: Done closes a task loop for good, and a closed loop is refused like a closed reminder', async () => {
  const { momo } = rig();
  await momo.loops.act('tl1', { action: 'done' });
  assert.equal(
    (await momo.tasks.list()).tasks.some((t: any) => t.id === 'loop:tl1'),
    false,
  );
  await assert.rejects(() => momo.loops.act('tl1', { action: 'done' }), /already closed/);
  await momo.loops.act('tl2', { action: 'dismiss' });
  await assert.rejects(() => momo.loops.act('tl2', { action: 'done' }), /already closed/);
});

test('voice: a MoMo note is answered as the scenario says, and the coding chat’s own note stays the fake app’s', async () => {
  const { app } = rig();
  let mode = 'on';
  const dictation = voiceOps(app.ops.dictation, () => mode);
  assert.deepEqual(await dictation.transcribeClip({ audio: Buffer.from('RIFFxxxxWAVE'), mime: 'audio/wav', keep: false }), {
    text: VOICE_TEXT,
  });
  mode = 'empty';
  assert.deepEqual(await dictation.transcribeClip({ audio: Buffer.from('RIFF'), mime: 'audio/wav', keep: false }), { text: '' });
  mode = 'fail';
  await assert.rejects(
    dictation.transcribeClip({ audio: Buffer.from('RIFF'), mime: 'audio/wav', keep: false }),
    /Speech services did not respond/,
  );
  // a clip that is kept is the coding chat's: read as the Mac's engine would, whatever MoMo's note is set to
  assert.deepEqual(await dictation.transcribeClip({ audio: Buffer.from('RIFFxxxxWAVE'), mime: 'audio/wav', keep: true }), {
    text: 'Heard 12 bytes of audio/wav: a WAV file.',
  });
  assert.deepEqual(await dictation.transcribeClip({}), { text: '' });
  assert.equal(dictation.engine, app.ops.dictation.engine);
});

test('voice: the momo-voice scenario passes its mode to the controls, on by default, and refuses another', () => {
  const modes: string[] = [];
  const scenario = momoScenarios(
    () => ({ momoVoice: (mode: string) => (modes.push(mode), 'done') }),
    () => true,
  )['momo-voice'];
  assert.equal(scenario.run([]), 'done');
  assert.equal(scenario.run(['fail']), 'done');
  assert.deepEqual(modes, ['on', 'fail']);
  assert.throws(() => scenario.run(['loud']), /momo-voice \[on\|off\|fail\|empty\]/);
});
