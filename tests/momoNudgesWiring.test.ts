// MoMo's nudges in main (#2139 P4, electron/app/momoNudges.cjs and its wiring in app/momoBackground.cjs and momo/routines.cjs): a nudge is a note in MoMo's main chat (shown as MoMo's, no model turn, never the user's words) and the lock screen says only "MoMo needs you"; the check runs as the scheduler's momo.nudges task while an open loop exists; its chat is unattended and data-only; Calendar is read only when connected, as MoMo's main chat; tokens count against the nudge budget; a turn's end and MoMo going off reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-memory.ts';
import { world } from './support/momoAppWorld.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { openMomoNudges, nudgeNote, CHECK_TOKENS } = require('../electron/app/momoNudges.cjs');
const { createMomoNotices } = require('../electron/momo/notices.cjs');
const { MOMO_NOTICE_TITLES } = require('../shared/momoNotices.mjs');
const { OpenLoopStore } = require('../electron/momo/openLoops.cjs');
const { NUDGE_TASK } = require('../electron/momo/routines.cjs');
const { UNATTENDED } = require('../electron/momo/routines.cjs');
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');

const NOW = new Date(2030, 2, 20, 12, 0).getTime();
const LOOP = { id: 'L1', kind: 'todo', text: 'Renew the lease with Mr. Smith', quote: 'renew the lease', saidAt: NOW - 5 * 86_400_000 };

function setup(o: any = {}) {
  const dir = path.join(scratch(), 'momo');
  const notes: any[] = [];
  const broadcasts: any[] = [];
  const posted: any[] = [];
  const spends: any[] = [];
  const patched: any[] = [];
  const reads: any[] = [];
  const flags = {
    allowed: true,
    patchOk: true,
    record: true,
    main: 'momo-main' as string | null,
    calendar: true,
    noMeta: false,
    ...o.flags,
  };
  const live = {
    chats: {
      record: (id: string) => (flags.record ? (flags.noMeta ? {} : { meta: { notes: [...notes] } }) : null),
      patchMeta: (id: string, p: any) => {
        if (!flags.patchOk) return false;
        notes.splice(0, notes.length, ...p.notes);
        return true;
      },
      get: (id: string) => ({ id }),
    },
    sessions: { patch: (id: string, p: any) => void patched.push([id, p]) },
    codex: { modelList: async () => [] },
  };
  const notifier = {
    notify: (kind: string, key: string, opts: any) => (posted.push({ kind, key, opts }), {}),
    notice: () => {},
    clear: () => {},
    clearMatching: () => {},
  };
  const notices = createMomoNotices({
    notifier,
    allowed: () => true,
    prefs: () => ({ momo: { routines: { quietHours: null } } }),
    open: () => {},
    now: () => NOW,
  });
  const core = {
    dir,
    loops: new OpenLoopStore({ dir, safeStorage: fakeSafe(), now: () => NOW }),
    mainChat: { current: () => flags.main, ensureMainChat: async () => ({ chatId: 'momo-main' }) },
    sources: {
      hub: { list: () => [{ id: 'calendar', connected: flags.calendar, needsGrant: false }] },
      calendar: {
        events: async (args: any, chatId: string) => (
          reads.push([args, chatId]), o.noEvents ? undefined : { events: [{ title: 'Lease signing', start: NOW + 1000 }, { start: 'x' }] }
        ),
      },
    },
  };
  const budget = { spend: async (k: string, n: number) => void spends.push([k, n]), left: () => o.left ?? 10_000 };
  const { nudges, state } = openMomoNudges({
    core,
    live,
    allowed: () => flags.allowed,
    safeStorage: fakeSafe(),
    startChat: async (_b: any, tag: any) => (o.tags?.push(tag), 'check-1'),
    send: async (chat: string, item: any) => void o.sent?.push([chat, item]),
    authored: (chat: string, text: string, show: any) => ({ chat, text, show }),
    discardChat: () => {},
    limitOf: () => ({ go: {} }),
    momoPrefs: () => ({ brain: { main: { harness: 'claude', model: 'opus' } } }),
    prefs: () => ({ momo: { routines: { proactivity: 'high', quietHours: null } } }),
    budget,
    notices,
    broadcastAll: (ch: string, p: any) => void broadcasts.push([ch, p]),
    now: () => NOW,
  });
  return { nudges, state, notes, broadcasts, posted, spends, patched, reads, flags, core, notices };
}

test('a nudge’s note says MoMo’s line and why: the user’s words, when they said them, the trigger', () => {
  const note = nudgeNote(
    { loop: LOOP, trigger: { trigger: 'due' }, text: 'The lease is due Friday.', why: 'due Fri 2030-03-22 23:59' },
    NOW,
  );
  assert.deepEqual(note, {
    id: `nudge-${NOW}-L1`,
    kind: 'nudge',
    text: 'The lease is due Friday.',
    turnId: null,
    turn: Number.MAX_SAFE_INTEGER,
    at: NOW,
    nudge: {
      loopId: 'L1',
      title: LOOP.text,
      quote: 'renew the lease',
      saidAt: LOOP.saidAt,
      trigger: 'due',
      why: 'due Fri 2030-03-22 23:59',
    },
  });
});

/** Runs one whole check over a loop not mentioned for 30 days, answering `reply`. */
async function check(t: any, reply = '{"send":[{"id":"n1","text":"Still on the lease?"}]}') {
  await t.core.loops.applyPass(
    {
      add: [
        {
          kind: 'todo',
          text: LOOP.text,
          quote: 'renew the lease',
          line: { text: 'x', at: NOW - 30 * 86_400_000, turnId: 't' },
          tz: 'UTC',
          confidence: 'sure',
        },
      ],
      mention: [],
      done: [],
    },
    { chatId: 'momo-main', harness: 'claude' },
  );
  // the loop was last mentioned 30 days ago
  await t.core.loops.file.change((v: any) => {
    v.loops[0].lastMentionedAt = NOW - 30 * 86_400_000;
  });
  await t.state.change((v: any) => {
    v.firstAt = NOW - 30 * 86_400_000;
  });
  const chat = await t.nudges.run();
  return t.nudges.finished({ chatId: chat, text: reply });
}

test('a whole check: the note lands in the main chat, every window hears it, and the notice says only “MoMo needs you”', async () => {
  const tags: any[] = [];
  const sent: any[] = [];
  const t = setup({ tags, sent });
  const out = await check(t);
  assert.equal(out.length, 1);
  assert.equal(t.notes.length, 1);
  assert.equal(t.notes[0].kind, 'nudge');
  assert.equal(t.notes[0].text, 'Still on the lease?');
  assert.equal(t.notes[0].nudge.why, 'not mentioned for 14 days');
  assert.deepEqual(t.broadcasts, [['chats:changed', { id: 'momo-main', chat: { id: 'momo-main' } }]]);
  assert.equal(t.posted.length, 1);
  const p = t.posted[0];
  assert.equal(p.kind, 'momo');
  assert.equal(p.opts.title, MOMO_NOTICE_TITLES.needsYou);
  assert.equal(p.opts.body, '');
  assert.equal(p.opts.chatTitle, '');
  const payload = JSON.stringify(p);
  for (const secret of ['lease', 'Smith', 'Still on']) assert.ok(!payload.includes(secret), `the notice never carries "${secret}"`);
  // the check's chat: data-only, isolated, unattended; its prompt sent as MoMo's
  assert.equal(tags[0].momo, 'nudge');
  assert.ok(tags[0].isolation);
  assert.deepEqual(t.patched, [['check-1', { scheduled: UNATTENDED }]]);
  assert.deepEqual(sent[0][1].show, { by: 'momo', title: 'Nudges' });
  assert.ok(t.spends.every(([k]: any) => k === 'nudges') && t.spends.length === 2);
});

test('nothing is delivered when MoMo went off, the main chat is gone or its note can’t be saved', async () => {
  for (const flags of [{ record: false }, { patchOk: false }]) {
    const t = setup({ flags });
    assert.deepEqual(await check(t), []);
    assert.equal(t.posted.length, 0);
  }
  const t = setup();
  const pending = check(t, '{"send":[{"id":"n1","text":"x"}]}');
  // off between the check and its delivery: on() is read at delivery
  t.flags.allowed = false;
  await pending.catch(() => {});
  assert.equal(t.posted.length, 0);
});

test('Calendar is read for the next day only when connected, as MoMo’s main chat; never with no main chat; the budget gates a check', async () => {
  const withEvent = async (t: any) => {
    await t.core.loops.applyPass(
      {
        add: [
          {
            kind: 'todo',
            text: 'Sign the lease',
            quote: 'sign the lease',
            line: { text: 'x', at: NOW - 1000, turnId: 't' },
            tz: 'UTC',
            confidence: 'sure',
            event: 'lease signing',
          },
        ],
        mention: [],
        done: [],
      },
      { chatId: 'momo-main', harness: 'claude' },
    );
    return t.nudges.run().catch((e: any) => e.reason);
  };
  const on = setup();
  assert.equal(await withEvent(on), 'check-1');
  assert.equal(on.reads.length, 1);
  assert.deepEqual(on.reads[0][1], 'momo-main');
  assert.equal(on.reads[0][0].end - on.reads[0][0].start, 86_400_000);
  for (const flags of [{ calendar: false }, { main: null }]) {
    const off = setup({ flags });
    await withEvent(off);
    assert.equal(off.reads.length, 0);
  }
  const broke = setup({ left: CHECK_TOKENS - 1 });
  assert.equal(await withEvent(broke), 'budget');
});

test('in the app: the check is the scheduler’s momo.nudges task while an open loop exists; a turn’s end and MoMo going off reach it', async () => {
  const w = world({ allowed: true });
  assert.ok(w.m.nudges);
  assert.equal(
    w.m.routines.tasks().some((x: any) => x.id === NUDGE_TASK.id),
    false,
    'no open loop: no task',
  );
  await w.m.loops.applyPass(
    {
      add: [{ kind: 'todo', text: 'Call mum', quote: 'call mum', line: { text: 'x', at: 1, turnId: 't' }, tz: 'UTC', confidence: 'sure' }],
      mention: [],
      done: [],
    },
    { chatId: 'momo-main', harness: 'claude' },
  );
  const task = w.m.routines.tasks().find((x: any) => x.id === NUDGE_TASK.id);
  assert.deepEqual(
    { ...task, harness: undefined },
    {
      id: 'momo.nudges',
      kind: 'momo-routine',
      name: 'Nudges',
      status: 'ACTIVE',
      rrule: NUDGE_TASK.rrule,
      created_at: 0,
      schedule_from: 0,
      harness: undefined,
    },
  );
  assert.deepEqual(await w.m.routines.validate(task), task);
  let ran = 0;
  w.m.nudges.run = async () => (ran++, 'check-9');
  assert.equal(await w.m.routines.run(task), 'check-9');
  assert.equal(ran, 1);
  // a failed check tells nobody
  let told = 0;
  const report = w.m.routines.o.report;
  w.m.routines.o.report = async () => (told++, true);
  await w.m.routines.failed(task, new Error('boom'));
  assert.equal(told, 0);
  w.m.routines.o.report = report;
  const seen: string[] = [];
  let cancelled = 0;
  w.m.nudges.finished = async (e: any) => void seen.push(e.chatId);
  w.m.nudges.cancelAll = () => void cancelled++;
  await w.live.controller.onFinished({ chatId: 'mc' });
  await waitFor(() => seen.length, 'the finished chat');
  assert.deepEqual(seen, ['mc']);
  for (const cb of w.access) cb(false);
  assert.equal(cancelled, 1);
  await w.m.close();
  setMomoContextProvider(null);
});

test('in the app: the Memory tab’s loop IPC and MoMo’s loop tool are registered; a dismiss spaces out its kind; the main chat’s turn hears of its nudges', async () => {
  const { momoContextFor } = require('../electron/momo/contract/context.cjs');
  const w = world({ allowed: true });
  assert.ok(w.handlers.has('momoMemory:loops') && w.handlers.has('momoMemory:loopAct'));
  assert.ok(w.live.capabilities.has('momo_open_loops'));
  await w.m.loops.applyPass(
    {
      add: [
        { kind: 'promise', text: 'Call mum', quote: 'call mum', line: { text: 'x', at: 1, turnId: 't' }, tz: 'UTC', confidence: 'sure' },
      ],
      mention: [],
      done: [],
    },
    { chatId: 'momo-main', harness: 'claude' },
  );
  const id = w.m.loops.list()[0].id;
  const kinds: string[] = [];
  w.m.nudges.dismissed = async (k: string) => void kinds.push(k);
  const r = await w.call('momoMemory:loopAct', id, { action: 'dismiss' });
  assert.equal(r.loop.state, 'dismissed');
  assert.deepEqual(kinds, ['promise']);
  w.chats.commit({
    id: 'mc',
    segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }],
    meta: {
      momo: 'main',
      notes: [{ id: 'n1', kind: 'nudge', text: 'Still calling mum?', at: Date.now(), turnId: null, turn: 9, nudge: { title: 'Call mum' } }],
    },
  });
  assert.match(momoContextFor('mc', { session: 's9', query: '' }) ?? '', /about "Call mum": "Still calling mum\?"/);
  await w.m.close();
  setMomoContextProvider(null);
});

test('a calendar that answers nothing reads as no events; a chat with no notes yet gets its first; MoMo going off mid-delivery stops the rest', async () => {
  const quiet = setup({ noEvents: true });
  await quiet.core.loops.applyPass(
    {
      add: [
        {
          kind: 'todo',
          text: 'Sign it',
          quote: 'sign it',
          line: { text: 'x', at: NOW - 1000, turnId: 't' },
          tz: 'UTC',
          confidence: 'sure',
          event: 'lease',
        },
      ],
      mention: [],
      done: [],
    },
    { chatId: 'momo-main', harness: 'claude' },
  );
  await quiet.nudges.run().catch(() => {});
  assert.equal(quiet.reads.length, 1);
  const fresh = setup({ flags: { noMeta: true } });
  assert.equal((await check(fresh)).length, 1);
  assert.equal(fresh.notes.length, 1);
  // two due loops; MoMo goes off as the first is told
  const t = setup();
  for (const text of ['Renew the lease', 'Call the bank'])
    await t.core.loops.applyPass(
      {
        add: [
          {
            kind: 'todo',
            text,
            quote: text.toLowerCase(),
            line: { text: 'x', at: NOW - 30 * 86_400_000, turnId: 't' },
            tz: 'UTC',
            confidence: 'sure',
          },
        ],
        mention: [],
        done: [],
      },
      { chatId: 'momo-main', harness: 'claude' },
    );
  await t.core.loops.file.change((v: any) => {
    for (const l of v.loops) l.lastMentionedAt = NOW - 30 * 86_400_000;
  });
  await t.state.change((v: any) => {
    v.firstAt = NOW - 30 * 86_400_000;
  });
  const chat = await t.nudges.run();
  const first = t.notices.needsYou;
  t.notices.needsYou = (target: any) => ((t.flags.allowed = false), first(target));
  const out = await t.nudges.finished({ chatId: chat, text: '{"send":[{"id":"n1","text":"a"},{"id":"n2","text":"b"}]}' });
  assert.equal(out.length, 1, 'the second is not delivered');
  assert.equal(t.notes.length, 1);
});
