// The morning brief in main (A7, electron/app/momoBrief.cjs, wired in app/momoBackground.cjs and momo/routines.cjs): behind `prefs.momo.brief` it is a task of the scheduler at the end of quiet hours beside the nudge check and the routines; its row is in Tasks › Scheduled (next time, the week away, or why it could not start); a human message of the user's in a MoMo chat marks the day they were active; Try again is `momoBrief:runNow`; the stack lands in MoMo's main chat as notes (lines, then a card per suggestion) with the fixed notice and nothing else on the lock screen; Reset MoMo erases the state.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-memory.ts';
import { world } from './support/momoAppWorld.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { openMomoBrief, briefNotes } = require('../electron/app/momoBrief.cjs');
const { resetMomoStores } = require('../electron/momo/stores.cjs');
const { OpenLoopStore } = require('../electron/momo/openLoops.cjs');
const { createSuggestions, memoryStorage } = require('../electron/momo/suggestions.cjs');

const NOW = new Date(2026, 10, 16, 7, 30).getTime();
const DAY = 86_400_000;
const done = async (w: any) => {
  await w.m.close();
  require('../electron/momo/contract/context.cjs').setMomoContextProvider(null);
};
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

test('behind the flag the brief is a scheduler task at the end of quiet hours, a Scheduled row and a Try again; off, none of them exist', async () => {
  const w = world({
    allowed: true,
    prefs: { momo: { tasksPanel: true, brief: false, routines: { quietHours: { start: '03:10', end: '03:11' } } } },
  });
  const ids = () => w.m.routines.tasks().map((t: any) => t.id);
  assert.equal(ids().includes('momo.brief'), false);
  assert.equal((await w.call('momoBrief:runNow')).reason, 'unavailable');
  assert.equal(
    (await w.call('momoTasks:list')).tasks.some((t: any) => t.kind === 'brief'),
    false,
  );
  w.prefs = { ...w.prefs, momo: { ...w.prefs.momo, brief: true } };
  const task = w.m.routines.tasks().find((t: any) => t.id === 'momo.brief');
  assert.deepEqual([task.name, task.rrule, task.status], ['Morning brief', 'FREQ=DAILY;BYHOUR=3;BYMINUTE=11;BYSECOND=0', 'ACTIVE']);
  // the Scheduled row: suspended until the user has been here, because no day of activity is known yet
  const rows = (await w.call('momoTasks:list')).tasks.filter((t: any) => t.kind === 'brief');
  assert.deepEqual(
    rows.map((t: any) => [t.id, t.tab, t.state, t.paused, t.detail, t.nextAt]),
    [['brief:morning', 'scheduled', 'scheduled', true, 'Paused because you were away for a week.', null]],
  );
  // the scheduler's run of it goes to the brief, which holds it for a user not yet seen here
  await assert.rejects(w.m.routines.run(task), (e: any) => ['away', 'quiet-hours'].includes(e.reason));
  // not allowed: nothing is listed and Try again is refused
  w.allowed = false;
  assert.equal(ids().includes('momo.brief'), false);
  assert.equal((await w.call('momoBrief:runNow')).reason, 'not_allowed');
  await done(w);
});

test('a human message in a MoMo chat marks today as active, once; the brief is then on its row with a next time; a failed run says why and Try again clears it', async () => {
  const w = world({ allowed: true, prefs: { momo: { tasksPanel: true, brief: true, routines: { quietHours: null } } } });
  w.live.controller.state = { has: () => true, get: () => ({ turn: 'idle', queue: [], approvals: [] }) };
  const main = (await w.call('momoChat:mainChat')).value.chatId;
  // a message that is not a human's, or not in a MoMo chat, marks nothing
  await w.live.controller.beforeDispatch({ chatId: main, item: { opts: { human: false } } });
  await w.live.controller.beforeDispatch({ chatId: 'coding-1', item: { opts: { human: true } } });
  await w.live.controller.beforeDispatch({ chatId: main });
  const row = async () => (await w.call('momoTasks:list')).tasks.find((t: any) => t.kind === 'brief');
  assert.equal((await row()).paused, true);
  await w.live.controller.beforeDispatch({ chatId: main, item: { opts: { human: true } } });
  await w.live.controller.beforeDispatch({ chatId: main, item: { opts: { human: true } } });
  await waitFor(async () => (await row()).paused === false, 'the day the user was active is kept');
  const r1 = await row();
  assert.deepEqual([r1.state, r1.paused, typeof r1.nextAt], ['scheduled', false, 'number']);
  // nothing to say today (no loops, no cards, no suggestions): Try again says so and nothing fails
  const said = await w.call('momoBrief:runNow');
  assert.deepEqual([said.ok, said.reason, said.error], [false, 'skipped', 'Nothing to tell you today.']);
  assert.equal((await row()).state, 'scheduled');
  // a run that cannot start (no brain here) is the row's failure, with its reason
  await w.m.routines.failed({ id: 'momo.brief', name: 'Morning brief' }, new Error('MoMo’s brain is not signed in.'));
  const failed = await row();
  assert.deepEqual([failed.state, failed.detail], ['failed', 'MoMo’s brain is not signed in.']);
  // MoMo's chat is not woken for it
  assert.deepEqual(w.sends, []);
  await done(w);
});

test('Reset MoMo erases the brief’s state with the routines', async () => {
  const w = world({ allowed: true, prefs: { momo: { tasksPanel: true, brief: true } } });
  w.live.controller.state = { has: () => true, get: () => ({ turn: 'idle', queue: [], approvals: [] }) };
  const main = (await w.call('momoChat:mainChat')).value.chatId;
  await w.live.controller.beforeDispatch({ chatId: main, item: { opts: { human: true } } });
  const file = path.join(w.m.dir, 'brief.json');
  await waitFor(() => fs.existsSync(file), 'the day is kept');
  assert.equal(fs.existsSync(file), true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /2026|activeDays/);
  await resetMomoStores();
  assert.equal(fs.existsSync(file), false);
  await done(w);
});

/** openMomoBrief over small fakes, as the nudges' wiring test is: MoMo's chat is a list of notes. */
function setup(o: { flags?: any } = {}) {
  const dir = path.join(scratch(), 'momo');
  const notes: any[] = [];
  const posted: any[] = [];
  const broadcasts: any[] = [];
  const sent: any[] = [];
  const flags = { allowed: true, paused: false, suggestions: true, record: true, patchOk: true, tasks: [] as any[], ...o.flags };
  const live = {
    chats: {
      record: () => (flags.record ? (flags.noMeta ? {} : { meta: { notes: [...notes] } }) : null),
      patchMeta: (_id: string, p: any) => (flags.patchOk ? (notes.splice(0, notes.length, ...p.notes), true) : false),
      get: (id: string) => ({ id }),
    },
    sessions: { patch: () => undefined },
    codex: { modelList: async () => [] },
    controller: {
      state: {
        has: () => true,
        get: () => ({
          approvals: [
            { id: 'a1', params: { kind: 'momoAction', momo: { summary: 'Send the mail', source: 'Mail' } } },
            { id: 'a2', params: { kind: 'momoAction' } },
            { id: 'a4', params: { kind: 'momoAction', momo: { tool: 'mail_send' } } },
            { id: 'a3', params: { kind: 'other' } },
          ],
        }),
      },
    } as any,
  };
  const loops = new OpenLoopStore({ dir, safeStorage: fakeSafe(), now: () => NOW });
  const suggestions = createSuggestions({ storage: memoryStorage({ now: () => NOW - 2 * DAY }), now: () => NOW - 2 * DAY });
  const handlers = new Map<string, Function>();
  const b = openMomoBrief({
    core: {
      dir,
      loops,
      mainChat: { ensureMainChat: async () => ({ chatId: 'momo-main' }) },
      isMomoChat: (id: string) => id === 'momo-main',
    },
    live,
    allowed: () => flags.allowed,
    safeStorage: fakeSafe(),
    startChat: async () => {
      if (flags.startFails) throw new Error('The harness is not signed in.');
      return 'words-chat';
    },
    send: async (id: string, item: any) => void sent.push([id, item]),
    authored: (_id: string, text: string, show: any) => ({ text, show }),
    discardChat: async () => undefined,
    limitOf: () => ({ go: {} }),
    momoPrefs: () => ({ brief: true, suggestions: flags.suggestions, paused: flags.paused, brain: { main: { harness: 'claude' } } }),
    prefs: () => ({ momo: { routines: { quietHours: null } } }),
    notices: { needsYou: (t: any) => (posted.push(t), true) },
    broadcastAll: (c: string, p?: unknown) => void broadcasts.push([c, p]),
    mainChat: { current: () => 'momo-main', mainChatId: () => 'momo-main' },
    routineStore: {
      routineRunsSince: () => [
        { chatId: 'r1', taskId: 't1', endedAt: NOW - 3600_000, outcome: 'failed' },
        { chatId: 'r2', taskId: 't1', endedAt: NOW - 3600_000, outcome: 'completed' },
        { chatId: 'r3', taskId: 't1', endedAt: NOW - 3600_000, outcome: 'failed' },
        { chatId: 'r4', taskId: 'gone', startedAt: NOW },
        { chatId: 'r5', taskId: 'gone', endedAt: NOW - 3600_000, outcome: 'stopped' },
      ],
      get: (id: string) => (id === 't1' ? { name: 'Weekly cleanup' } : undefined),
    },
    marks: { list: () => ({ 'run:r3': { mark: 'archived', at: NOW } }) },
    suggestions,
    ipc: {
      ipcMain: { handle: (c: string, f: Function) => handlers.set(c, f), removeHandler: () => undefined },
      nextRun: () => new Date(NOW + DAY),
      broadcast: () => undefined,
    },
    now: () => NOW,
  });
  return { b, notes, posted, broadcasts, sent, flags, live, loops, suggestions, handlers, dir };
}

test('the inputs are MoMo’s own: loops, cards and unmarked failed runs, and the suggestions; the words chat gets them as data and lands the stack in the main chat with the fixed notice', async () => {
  const t = setup();
  // cards come from the controller's state: none here
  await t.loops
    .applyPass(
      {
        add: [
          {
            kind: 'todo',
            text: 'Send the invoice',
            quote: 'I will send it',
            line: { text: 'x', at: NOW - DAY, turnId: 't' },
            tz: 'UTC',
            confidence: 'sure',
            due: { at: NOW + DAY },
          },
        ],
        mention: [],
        done: [],
      },
      { chatId: 'momo-main', harness: 'claude' },
    )
    .catch(() => undefined);
  await t.suggestions.add({
    title: 'Reply to Sam',
    why: 'He asked.',
    source: 'Mail: Sam',
    step: 'Draft a reply',
    from: 'mail',
    ref: 't1',
    kind: 'reply',
    cost: 'person',
    confidence: 'high',
  });
  await t.b.brief.noteActive(NOW - DAY);
  const chat = await t.b.brief.run();
  assert.equal(chat, 'words-chat');
  assert.match(t.sent[0][1].text, /Attention item.*"Send the mail", source "Mail"/s);
  assert.doesNotMatch(t.sent[0][1].text, /r3|Weekly cleanup/);
  assert.deepEqual(t.sent[0][1].show, { by: 'momo', title: 'Morning brief' });
  const words = '{"greeting":"Morning!","attention":"A routine did not finish.","lead":"I can move 1 thing forward:"}';
  assert.equal(await t.b.brief.finished({ chatId: chat, text: words }), true);
  assert.deepEqual(
    t.notes.map((n: any) => [n.kind, n.text, n.suggestion?.title ?? null]),
    [
      ['brief', 'Morning!', null],
      ['brief', 'A routine did not finish.', null],
      ['brief', 'I can move 1 thing forward:', null],
      ['brief', 'Reply to Sam', 'Reply to Sam'],
    ],
  );
  assert.equal(
    t.notes.every((n: any) => n.turnId === null && n.turn === Number.MAX_SAFE_INTEGER),
    true,
  );
  assert.equal(t.notes[3].suggestion.source, 'Mail: Sam');
  assert.deepEqual(t.posted, [{ kind: 'chat', chatId: 'momo-main' }], 'the fixed notice, nothing of the brief');
  assert.equal(t.broadcasts[0][0], 'chats:changed');
});

test('the brief’s lead-in and cards need the suggestions flag as well as the brief’s: with it off the stack is the greeting and the attention item alone', async () => {
  for (const suggestions of [true, false]) {
    const t = setup({ flags: { suggestions } });
    await t.suggestions.add({
      title: 'Reply to Sam',
      why: 'W',
      source: 'Mail: Sam',
      step: 'Draft',
      from: 'mail',
      ref: 't1',
      kind: 'reply',
      cost: 'person',
      confidence: 'high',
    });
    await t.b.brief.noteActive(NOW - DAY);
    const chat = await t.b.brief.run();
    // the waiting card is the attention item either way
    assert.match(t.sent[0][1].text, /Attention item/);
    assert.equal(/suggestions? follows? as cards/.test(t.sent[0][1].text), suggestions, 'the words chat is told of cards');
    await t.b.brief.finished({ chatId: chat, text: '{}' });
    const kinds = t.notes.map((n: any) => (n.suggestion ? 'card' : 'line'));
    assert.deepEqual(kinds, suggestions ? ['line', 'line', 'line', 'card'] : ['line', 'line']);
  }
});

test('a chat record with no meta yet still takes the brief’s notes', async () => {
  const t = setup({ flags: { noMeta: true } });
  await t.suggestions.add({ title: 'T', why: 'W', source: 'S', step: 'P', from: 'mail', ref: 'x', kind: 'reply' });
  await t.b.brief.noteActive(NOW);
  const chat = await t.b.brief.run();
  assert.equal(await t.b.brief.finished({ chatId: chat, text: '{}' }), true);
  assert.equal(t.notes.length > 0, true);
});

test('Try again whose words chat cannot start is the brief’s failure, with the reason, and the row says it', async () => {
  const t = setup({ flags: { startFails: true } });
  await t.b.brief.noteActive(NOW);
  const res = await t.handlers.get('momoBrief:runNow')!({});
  assert.deepEqual([res.ok, res.error], [false, 'The harness is not signed in.']);
  assert.deepEqual(t.b.row()?.state, 'failed');
});

test('a delivery is not made while MoMo is paused or off, or when its chat is gone', async () => {
  for (const flags of [{ paused: true }, { allowed: false }, { record: false }, { patchOk: false }]) {
    const t = setup({ flags });
    const deliver = t.b.brief as any;
    // drive the delivery the brief would make
    t.flags.allowed = true;
    t.flags.paused = false;
    const run = await (async () => {
      await t.suggestions.add({ title: 'T', why: 'W', source: 'S', step: 'P', from: 'mail', ref: 'x', kind: 'reply' });
      await t.b.brief.noteActive(NOW);
      return t.b.brief.run().catch((e: Error) => e);
    })();
    assert.ok(run);
    Object.assign(t.flags, flags);
    const landed = await deliver.finished({ chatId: typeof run === 'string' ? run : 'none', text: '{}' });
    assert.equal(landed === false || landed === null, true);
    assert.deepEqual(t.notes, []);
    assert.deepEqual(t.posted, []);
  }
});

test('the notes are lines, then a card per suggestion with its id, title and source', () => {
  const notes = briefNotes({ texts: ['a', 'b'], cards: [{ id: 's1', title: 'T', source: 'S' }] }, 5);
  assert.deepEqual(
    notes.map((n: any) => [n.id, n.kind, n.text, n.suggestion ?? null]),
    [
      ['brief-5-t0', 'brief', 'a', null],
      ['brief-5-t1', 'brief', 'b', null],
      ['brief-5-cs1', 'brief', 'T', { id: 's1', title: 'T', source: 'S' }],
    ],
  );
  assert.equal(dayOf(NOW) > '2026', true);
});
