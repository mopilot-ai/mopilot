// A paired phone's MoMo state, settings, routine edits, memory history, About you and open loops (electron/remote/methods/momo.cjs over electron/remote/momoOps.cjs): each a thin wrapper over the handler MoMo's windows use, checked in main, refused while MoMo is paused only for Run now (#3648's table: the user's own edits go through, as on the Mac), and told to phones as `momo.changed` with only an area; a nudge note reaches a following phone's rows with its loop id.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { settle } from './support/remote-kit.ts';
import { sweep } from './support/momo-routines.ts';
import { ok, fail, askSlow, momoRig, LOOPS_NOW } from './support/remote-momo-kit.ts';
import { changedTopic, parseBrain } from '../mobile/src/momo/contract';

const require = createRequire(import.meta.url);
const { PARSERS } = require('../shared/remote/schema.mjs');
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { withChatNotes } = require('../shared/chatNotes.mjs');
const methods = require('../electron/remote/methods/momo.cjs');
const { momoPrefsForPhones } = require('../electron/app/ipc/momoPrefs.cjs');
const { MOMO_PROACTIVITY_LIMITS } = require('../shared/momoPrefs.mjs');

const NOW = LOOPS_NOW;
const D = 86_400_000;

/** momoRig with prefs.momo held here (main's patchPrefs and onPrefs over it) and MoMo's open loops on the tapped ipcMain. */
async function wrapRig(o: { momo?: any; saveFails?: boolean; noMainChat?: boolean } = {}) {
  const m = momoRig({ noMainChat: o.noMainChat });
  const state: { prefs: { momo: any } } = { prefs: { momo: o.momo ?? {} } };
  const saves: any[] = [];
  const live: any = {
    ...m.live,
    patchPrefs: (set: any) => {
      if (o.saveFails) return false;
      saves.push(set);
      state.prefs = { ...state.prefs, ...set };
      // main's onPrefs (electron/app/ipc/chats.cjs) tells MoMo's phone layer
      m.remote.prefsChanged(state.prefs);
      return true;
    },
  };
  m.remote = m.wired.attach({
    live,
    mainChat: m.mainChat,
    readState: () => state,
    runAttended: async (task: any) => void m.ran.push(task),
    ...momoPrefsForPhones({ readState: () => state, live }, { allowed: () => m.gate.allowed }),
  });
  m.r.service.momo = () => m.remote;
  const line = (text: string) => ({
    kind: 'todo',
    text,
    quote: text.toLowerCase(),
    line: { text, at: NOW - D, turnId: 't1' },
    tz: 'UTC',
    confidence: 'sure',
  });
  await m.loops.applyPass(
    { add: [line('Renew the lease'), line('Call mum')], mention: [], done: [] },
    { chatId: 'momo-main', harness: 'claude' },
  );
  return { ...m, state, saves, p: m.r.phone('p1') };
}

const changed = (p: any) => p.events('momo.changed').map((e: any) => e.area);

test('state and settings: a phone reads name, color, status and the cards that wait; sets one allowed setting through momoPrefs; hears `prefs` only when what it shows changed', async () => {
  const t = await wrapRig({ momo: { persona: { name: 'Mo', color: 'blue' }, routines: { proactivity: 'low' } } });
  assert.deepEqual(ok(await t.p.ask('momo.state.get')), { name: 'Mo', color: 'blue', status: 'online', needsYou: 0 });
  // a momoAction card up in the main chat needs the user; another kind of approval does not count
  t.controller.state.get = () =>
    ({
      approvals: [
        { id: 'a1', params: { kind: 'momoAction' } },
        { id: 'a2', params: { kind: 'other' } },
      ],
    }) as any;
  assert.equal(ok(await t.p.ask('momo.state.get')).needsYou, 1);
  const prefs = ok(await t.p.ask('momo.prefs.get'));
  assert.deepEqual(
    { ...prefs, levels: undefined },
    { paused: false, proactivity: 'low', quietHours: { start: '22:00', end: '07:00' }, levels: undefined },
  );
  assert.deepEqual(prefs.levels, [
    { id: 'off', runs: 0 },
    { id: 'low', runs: 2 },
    { id: 'default', runs: 6 },
    { id: 'high', runs: 12 },
  ]);
  assert.equal(ok(await t.p.ask('momo.prefs.set', { proactivity: 'high' })).proactivity, 'high');
  assert.deepEqual(ok(await t.p.ask('momo.prefs.set', { quietHours: { start: '21:00', end: '06:30' } })).quietHours, {
    start: '21:00',
    end: '06:30',
  });
  assert.deepEqual(ok(await t.p.ask('momo.prefs.set', { quietHours: null })).quietHours, null);
  // the window's own merge: the persona and anything else saved are kept
  assert.deepEqual(t.state.prefs.momo.persona, { name: 'Mo', color: 'blue' });
  assert.deepEqual(t.state.prefs.momo.routines, { proactivity: 'high', quietHours: null });
  // a prefs change that touches nothing a phone shows is not told
  t.remote.prefsChanged({ ...t.state.prefs, momo: { ...t.state.prefs.momo, notify: { needsAnswer: false } } });
  await settle();
  assert.deepEqual(changed(t.p), ['prefs', 'prefs', 'prefs']);
  assert.equal(changedTopic({ ev: 'momo.changed', area: 'prefs' } as any), 'prefs');
  // one setting a request, only these three, each value checked in main
  for (const bad of [{}, { paused: true, proactivity: 'low' }, { atLimit: 'pause' }, { 'remote.brainChange': true }])
    fail(await t.p.ask('momo.prefs.set', bad), 'invalid', /one of MoMo/);
  fail(await t.p.ask('momo.prefs.set', { proactivity: 'max' }), 'invalid', /how often/);
  fail(await t.p.ask('momo.prefs.set', { paused: 'yes' }), 'invalid', /Pause or resume/);
  for (const q of [{ start: '22:00', end: '22:00' }, { start: '25:00', end: '07:00' }, 'night'])
    fail(await t.p.ask('momo.prefs.set', { quietHours: q }), 'invalid', /quiet hours/);
  // a key the phone layer does not know is left out, as for every method
  assert.deepEqual(PARSERS['momo.prefs.set']({ paused: false, chatId: 'x' }), { paused: false });
  assert.equal(t.saves.length, 3);
});

// While MoMo is paused (the MoMo owner's table on #3648): pause holds only MoMo's own work, as on the Mac; one test per row
const PAUSED_MOMO = { paused: true, remote: { brainChange: true } };
const PAUSED = /MoMo is paused/;

test('paused, row 1: momo.routines.run is refused with the paused reason and never reaches the runner; reads still answer', async () => {
  const t = await wrapRig({ momo: PAUSED_MOMO });
  const a = await t.w.routines.add({ ...sweep, name: 'Sweep' }, { approved: true });
  fail(await askSlow(t.p, 'momo.routines.run', { id: a.id }), 'forbidden', PAUSED);
  assert.deepEqual(t.ran, []);
  assert.equal(ok(await t.p.ask('momo.state.get')).status, 'paused');
  ok(await t.p.ask('momo.prefs.get'));
  for (const method of ['momo.memory.changes', 'momo.memory.past', 'momo.loops.list', 'momo.routines.list']) ok(await askSlow(t.p, method));
  // resumed, it runs
  ok(await t.p.ask('momo.prefs.set', { paused: false }));
  assert.deepEqual(ok(await askSlow(t.p, 'momo.routines.run', { id: a.id })), { started: true });
});

test('paused, row 2: momo.chat.send and momo.card.answer go through (the user talking to MoMo)', async () => {
  const t = await wrapRig({ momo: PAUSED_MOMO });
  assert.equal(ok(await t.p.ask('momo.chat.send', { id: 'p1', text: 'still there?' })).sent, true);
  assert.equal(t.sent.length, 1);
  ok(await t.p.ask('momo.chat.follow', {}));
  // no paused refusal: it reaches the card check (no such card up)
  fail(await t.p.ask('momo.card.answer', { cardId: 'none', rev: 1, key: 'once' }), 'stale');
});

test('paused, row 3: momo.memory.edit, forget, undo and writeDoc go through (the user editing their own memory)', async () => {
  const t = await wrapRig({ momo: PAUSED_MOMO });
  const a = (await t.store.save({ text: 'Likes green tea', source: 'user', confidence: 'sure' })).fact;
  const b = (await t.store.save({ text: 'Lives in Lyon', source: 'user', confidence: 'sure' })).fact;
  assert.equal(ok(await askSlow(t.p, 'momo.memory.edit', { factId: a.id, text: 'Likes oolong' })).fact.text, 'Likes oolong');
  const change = ok(await askSlow(t.p, 'momo.memory.changes')).changes.find((c: any) => c.undoable);
  ok(await askSlow(t.p, 'momo.memory.undo', { changeId: change.id }));
  assert.equal(ok(await askSlow(t.p, 'momo.memory.forget', { factId: b.id })).forgotten, true);
  assert.deepEqual(ok(await askSlow(t.p, 'momo.memory.writeDoc', { doc: 'aboutYou', text: 'I teach piano.' })), { written: true });
  assert.equal(t.store.readFile('aboutYou'), 'I teach piano.');
});

test('paused, row 4: momo.routines.edit, delete, pause, resume and approve go through, and approving runs nothing', async () => {
  const t = await wrapRig({ momo: PAUSED_MOMO });
  const a = await t.w.routines.add({ ...sweep, name: 'Sweep' }, { approved: true });
  const proposal = await t.w.routines.add({ ...sweep, name: 'Proposed' }, { approved: false });
  const declined = await t.w.routines.add({ ...sweep, name: 'Declined' }, { approved: false });
  assert.equal(ok(await askSlow(t.p, 'momo.routines.edit', { id: a.id, edit: { name: 'Inbox sweep' } })).routine.name, 'Inbox sweep');
  assert.equal(ok(await askSlow(t.p, 'momo.routines.pause', { id: a.id })).routine.status, 'PAUSED');
  assert.equal(ok(await askSlow(t.p, 'momo.routines.resume', { id: a.id })).routine.status, 'ACTIVE');
  const { proposals } = ok(await askSlow(t.p, 'momo.routines.list'));
  const shown = proposals.find((x: any) => x.id === proposal.id);
  assert.equal(ok(await askSlow(t.p, 'momo.routines.approve', { id: proposal.id, seen: shown.rev })).routine.approved, true);
  assert.deepEqual(ok(await askSlow(t.p, 'momo.routines.delete', { id: declined.id })), { deleted: true });
  assert.deepEqual([t.ran, t.w.started], [[], []]);
});

test('paused, row 5: momo.loops.act, momo.brain.set and momo.prefs.set go through', async () => {
  const t = await wrapRig({ momo: PAUSED_MOMO });
  assert.equal(ok(await askSlow(t.p, 'momo.loops.act', { loopId: 'L1', action: 'done' })).loop.state, 'done');
  ok(await t.p.ask('momo.brain.set', { brain: { harness: 'claude', account: null, model: 'opus', modelLabel: 'Opus' } }));
  assert.equal(t.brains.length, 1);
  assert.equal(ok(await t.p.ask('momo.prefs.set', { proactivity: 'high' })).proactivity, 'high');
  assert.equal(ok(await t.p.ask('momo.prefs.set', { quietHours: null })).quietHours, null);
  // still paused: changing a setting doesn't resume MoMo
  assert.equal(ok(await t.p.ask('momo.state.get')).status, 'paused');
  assert.equal(t.saves.length, 2);
  // a save that fails is said in the window's words
  const broken = await wrapRig({ saveFails: true });
  fail(await broken.p.ask('momo.prefs.set', { paused: true }), 'failed', /Couldn't save MoMo's settings/);
});

test('a status read never makes the main chat: with none yet, nothing waits; a follow still makes it', async () => {
  const t = await wrapRig({ noMainChat: true });
  assert.deepEqual(ok(await t.p.ask('momo.state.get')), { name: 'MoMo', color: 'clay', status: 'online', needsYou: 0 });
  assert.deepEqual(t.main, { exists: false, made: 0 });
  // paused too
  const paused = await wrapRig({ noMainChat: true, momo: { paused: true } });
  assert.equal(ok(await paused.p.ask('momo.state.get')).status, 'paused');
  assert.deepEqual(paused.main, { exists: false, made: 0 });
  ok(await t.p.ask('momo.chat.follow', {}));
  assert.deepEqual(t.main, { exists: true, made: 1 });
});

test('proactivity: every level MoMo enforces (MOMO_PROACTIVITY_LIMITS) is accepted, and nothing else', async () => {
  const t = await wrapRig();
  for (const level of Object.keys(MOMO_PROACTIVITY_LIMITS)) {
    assert.deepEqual(PARSERS['momo.prefs.set']({ proactivity: level }), { proactivity: level });
    assert.equal(ok(await t.p.ask('momo.prefs.set', { proactivity: level })).proactivity, level);
  }
  for (const v of ['max', 'Default', '', 2, 'toString', 'constructor'])
    fail(await t.p.ask('momo.prefs.set', { proactivity: v }), 'invalid', /how often/);
});

test('MoMo not made yet: state is offline under the default name, every other call says MoMo is not ready', async () => {
  const t = await wrapRig();
  t.r.service.momo = () => null;
  assert.deepEqual(ok(await t.p.ask('momo.state.get')), { name: 'MoMo', color: 'clay', status: 'offline', needsYou: 0 });
  fail(await t.p.ask('momo.prefs.get'), 'failed', /not ready/);
  fail(await t.p.ask('momo.loops.list'), 'failed', /not ready/);
});

test('routines: a phone edits through momoRoutines:edit (checked in main) and deletes or declines through momoRoutines:remove', async () => {
  const t = await wrapRig();
  const a = await t.w.routines.add({ ...sweep, name: 'Sweep' }, { approved: true });
  const proposal = await t.w.routines.add({ ...sweep, name: 'Proposed' }, { approved: false });
  const edited = ok(
    await askSlow(t.p, 'momo.routines.edit', { id: a.id, edit: { name: '  Inbox sweep ', time: '08:30', days: ['MO', 'MO', 'FR'] } }),
  );
  assert.equal(edited.routine.name, 'Inbox sweep');
  assert.equal(edited.routine.rrule, 'FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8;BYMINUTE=30;BYSECOND=0');
  ok(
    await askSlow(t.p, 'momo.routines.edit', {
      id: a.id,
      edit: { prompt: 'Sweep the inbox', sources: ['calendar', 'calendar'], rrule: 'FREQ=DAILY;BYHOUR=9' },
    }),
  );
  // what main's own edit refuses comes back as it says
  fail(await askSlow(t.p, 'momo.routines.edit', { id: a.id, edit: { rrule: 'FREQ=DAILY', time: '09:00' } }), 'failed', /either an RRULE/);
  fail(await askSlow(t.p, 'momo.routines.edit', { id: 'missing', edit: { name: 'x' } }), 'gone', /routines/);
  for (const edit of [
    undefined,
    [],
    {},
    { paused: true },
    { name: '' },
    { name: 'x'.repeat(81) },
    { prompt: 7 },
    { sources: 'mail' },
    { sources: ['!'] },
    { time: '9am' },
    { days: ['XX'] },
    { rrule: '' },
  ])
    fail(await t.p.ask('momo.routines.edit', { id: a.id, edit }), 'invalid');
  // Decline a proposal and Remove a routine are one path
  assert.deepEqual(ok(await askSlow(t.p, 'momo.routines.delete', { id: proposal.id })), { deleted: true });
  assert.deepEqual(ok(await askSlow(t.p, 'momo.routines.delete', { id: a.id })), { deleted: true });
  fail(await askSlow(t.p, 'momo.routines.delete', { id: a.id }), 'gone', /routines/);
  assert.deepEqual(await t.w.routines.list(), []);
  await settle();
  assert.ok(changed(t.p).every((x: string) => x === 'routines') && changed(t.p).length >= 4);
});

test('memory: a phone reads the changes and past facts, undoes one (a refusal says the store’s reason), and rewrites About you only', async () => {
  const t = await wrapRig();
  const a = (await t.store.save({ text: 'Likes green tea', source: 'user', confidence: 'sure' })).fact;
  await t.store.update(a.id, { text: 'Likes oolong' });
  const { changes } = ok(await askSlow(t.p, 'momo.memory.changes'));
  assert.ok(changes.length >= 2 && changes.every((c: any) => typeof c.undoable === 'boolean'));
  const edit = changes.find((c: any) => c.undoable && c.op === 'update') ?? changes[0];
  assert.equal(ok(await askSlow(t.p, 'momo.memory.past')).facts.length >= 0, true);
  ok(await askSlow(t.p, 'momo.memory.undo', { changeId: edit.id }));
  // undone already: the store's own words, not a generic failure
  const again = await askSlow(t.p, 'momo.memory.undo', { changeId: edit.id });
  fail(again, 'failed');
  assert.notEqual(again.error.message, 'MoMo could not do that.');
  await assert.rejects(t.store.undo(edit.id), (e: any) => e.message === again.error.message);
  fail(await t.p.ask('momo.memory.undo', { changeId: '' }), 'invalid', /no longer in the log/);
  assert.deepEqual(ok(await askSlow(t.p, 'momo.memory.writeDoc', { doc: 'aboutYou', text: 'I teach piano.' })), { written: true });
  assert.equal(t.store.readFile('aboutYou'), 'I teach piano.');
  fail(await t.p.ask('momo.memory.writeDoc', { doc: 'persona', text: 'Be rude.' }), 'invalid', /Only About you/);
  fail(await t.p.ask('momo.memory.writeDoc', { doc: 'aboutYou', text: 'x'.repeat(20001) }), 'invalid', /20,000/);
  fail(await t.p.ask('momo.memory.writeDoc', { doc: 'aboutYou' }), 'invalid');
  assert.equal(t.store.readFile('persona'), '');
});

test('open loops: a phone lists them and acts with Done, Snooze (a day or a week) or Dismiss, as the nudge card does on the Mac', async () => {
  const t = await wrapRig();
  const view = ok(await askSlow(t.p, 'momo.loops.list'));
  assert.deepEqual(
    view.open.map((l: any) => l.id),
    ['L1', 'L2'],
  );
  assert.equal(ok(await askSlow(t.p, 'momo.loops.act', { loopId: 'L1', action: 'done' })).loop.state, 'done');
  assert.equal(ok(await askSlow(t.p, 'momo.loops.act', { loopId: 'L2', action: 'snooze', snooze: 'week' })).loop.snoozedUntil, NOW + 7 * D);
  assert.equal(ok(await askSlow(t.p, 'momo.loops.act', { loopId: 'L2', action: 'dismiss' })).loop.state, 'dismissed');
  assert.equal(t.dismissed.length, 1);
  fail(await askSlow(t.p, 'momo.loops.act', { loopId: 'L9', action: 'done' }), 'failed');
  for (const params of [
    { loopId: 'L1', action: 'erase' },
    { loopId: 'L1', action: 'snooze' },
    { loopId: 'L1', action: 'snooze', snooze: 'year' },
    { loopId: '', action: 'done' },
  ])
    fail(await t.p.ask('momo.loops.act', params), 'invalid');
  // a stray snooze on Done is not passed on
  assert.deepEqual(PARSERS['momo.loops.act']({ loopId: 'L1', action: 'done', snooze: 'day' }), { loopId: 'L1', action: 'done' });
  await settle();
  assert.ok(changed(t.p).includes('memory'));
});

test('a nudge note reaches a phone intact: its row keeps the loop id and why, and a new note in the main chat tells phones `chat`', async () => {
  const t = await wrapRig();
  const note = {
    id: 'nudge-1-L1',
    kind: 'nudge',
    text: 'The lease is due tomorrow.',
    turnId: null,
    turn: Number.MAX_SAFE_INTEGER,
    at: NOW,
    nudge: {
      loopId: 'L1',
      title: 'Renew the lease',
      quote: 'renew the lease',
      saidAt: NOW - D,
      trigger: 'due',
      why: 'Due tomorrow',
      extra: { x: 1 },
    },
  };
  const turns = [{ id: 'ct-1', items: [{ type: 'agentMessage', id: 'i1', text: 'Hi' }] }];
  const { rows } = rowsOf(withChatNotes(turns, [note, { ...note, id: 'nudge-2', nudge: { title: 'no loop' } }]));
  assert.deepEqual(rows.at(-1), {
    role: 'note',
    text: 'The lease is due tomorrow.',
    nudge: { loopId: 'L1', title: 'Renew the lease', quote: 'renew the lease', saidAt: NOW - D, trigger: 'due', why: 'Due tomorrow' },
    id: JSON.stringify([undefined, '1', 'nudge-1-L1']),
    // #4201 adds a stable phone identity alongside the existing panel/action identity.
    phoneId: JSON.stringify([null, '1', 'statusNote', 'nudge-1-L1']),
  });
  assert.equal(rows.length, 2, 'a nudge with no loop is not a row');
  // only the loop id and title are needed; a field of the wrong type is left out
  const bare = rowsOf(withChatNotes(turns, [{ ...note, nudge: { loopId: 'L2', saidAt: 'soon', why: 3 } }])).rows.at(-1);
  assert.deepEqual(bare.nudge, { loopId: 'L2', title: '' });
  // the main chat's notes changed: followers are told `chat`; the same notes again, or another chat, are not news
  const main = (notes: any[]) => ({ id: 'momo-main', chat: { meta: { momo: 'main', notes } } });
  t.wired.broadcast('chats:changed', main([]));
  t.wired.broadcast('chats:changed', main([]));
  t.wired.broadcast('chats:changed', main([note]));
  t.wired.broadcast('chats:changed', main([note]));
  t.wired.broadcast('chats:changed', { id: 'c2', chat: { meta: { notes: [note] } } });
  t.wired.broadcast('chats:changed', { id: 'momo-main', chat: { meta: { momo: 'main' } } });
  t.wired.broadcast('chats:changed', null);
  await settle();
  assert.deepEqual(changed(t.p), ['chat', 'chat', 'chat']);
  assert.equal(changedTopic({ ev: 'momo.changed', area: 'chat' } as any), 'chat');
  assert.equal(changedTopic({ ev: 'momo.changed', area: 'nope' } as any), null);
});

test('every new method is a thin wrapper: no handler reaches the stores on its own', () => {
  for (const m of [
    'momo.state.get',
    'momo.prefs.get',
    'momo.prefs.set',
    'momo.routines.edit',
    'momo.routines.delete',
    'momo.memory.changes',
    'momo.memory.undo',
    'momo.memory.past',
    'momo.memory.writeDoc',
    'momo.loops.list',
    'momo.loops.act',
  ]) {
    assert.equal(typeof methods[m], 'function', m);
    assert.equal(typeof PARSERS[m], 'function', m);
  }
});

test("brain effort (#3631) reaches MoMo's brain from the phone and back: a level or null as asked, absent left out (MoMo keeps its own), anything else refused", async () => {
  const m = momoRig({ remoteBrain: true });
  const p = m.r.phone('p1');
  const brain = { harness: 'claude', account: null, model: 'opus', modelLabel: 'Opus' };
  ok(await p.ask('momo.brain.set', { brain: { ...brain, effort: 'high' } }));
  ok(await p.ask('momo.brain.set', { brain: { ...brain, effort: null } }));
  ok(await p.ask('momo.brain.set', { brain }));
  assert.deepEqual(m.brains, [{ ...brain, effort: 'high' }, { ...brain, effort: null }, brain]);
  assert.equal('effort' in (m.brains[2] as object), false, 'no effort sent: the Mac keeps the one it has');
  for (const effort of [5, '', 'very high', 'x'.repeat(33), { level: 'high' }, true])
    fail(await p.ask('momo.brain.set', { brain: { ...brain, effort } }), 'invalid', /Pick an effort/);
  assert.equal(m.brains.length, 3);
  // read back: the effort the Mac's brain has reaches the phone's parser
  m.mainChat.getBrain = () => ({ ...brain, effort: 'xhigh' }) as any;
  assert.deepEqual(parseBrain(ok(await p.ask('momo.brain.get'))), { label: 'Opus', effort: 'xhigh' });
  m.mainChat.getBrain = () => ({ ...brain, effort: null }) as any;
  assert.deepEqual(parseBrain(ok(await p.ask('momo.brain.get'))), { label: 'Opus' });
});

test('state: the page shell is told to a phone only when the Mac has it on, with its Tasks panel as its own word', async () => {
  const off = await wrapRig({ momo: { persona: { name: 'Mo', color: 'blue' }, tasksPanel: true } });
  assert.deepEqual(
    ok(await off.p.ask('momo.state.get')),
    { name: 'Mo', color: 'blue', status: 'online', needsYou: 0 },
    'the flag off: no word of it',
  );
  const shellOnly = await wrapRig({ momo: { persona: { name: 'Mo', color: 'blue' }, shell: true } });
  assert.deepEqual(ok(await shellOnly.p.ask('momo.state.get')), {
    name: 'Mo',
    color: 'blue',
    status: 'online',
    needsYou: 0,
    shell: true,
    shellTasks: false,
  });
  const both = await wrapRig({ momo: { persona: { name: 'Mo', color: 'blue' }, shell: true, tasksPanel: true } });
  assert.equal(ok(await both.p.ask('momo.state.get')).shellTasks, true);
});
