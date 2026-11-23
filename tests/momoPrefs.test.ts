// MoMo's settings in prefs.momo (shared/momoPrefs.mjs) and main's momoPrefs:set (electron/app/ipc/momoPrefs.cjs): defaults for what is missing or not valid, one key merged into what is saved now (the main chat's brain and other windows' changes kept), refused while MoMo is off, failures told in the user's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MOMO_DEFAULTS,
  MOMO_PROACTIVITY_LIMITS,
  isMomoPaused,
  migrateMomoPrefs,
  readMomoPrefs,
  resetMomoPrefs,
  roleBrain,
  setMomoPref,
} from '../shared/momoPrefs.mjs';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/momoPrefs.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');
const { ChatsStore, registerChats, flushPendingWrites } = require('../electron/platform/chats.cjs');
import fs from 'node:fs';
import { tmp } from './support/chat-store-profile.ts';

const MAIN = { harness: 'claude', account: 'a1', model: 'opus', modelLabel: 'Opus' };
const DEFAULTS = {
  atLimit: 'nextAccount',
  routines: { proactivity: 'default', quietHours: { start: '22:00', end: '07:00' }, starter: [] },
  notify: { needsAnswer: true, pushBody: false },
  remote: { brainChange: false },
  paused: false,
  tasksPanel: false,
  brief: false,
  suggestions: false,
  channels: false,
  shell: false,
  sessions: false,
  sessionsShow: true,
  sessionsAct: false,
  persona: { name: 'MoMo', color: 'clay' },
  onboarding: { done: false, step: 0 },
};

test('nothing saved, or junk saved: every setting at its default', () => {
  const d = readMomoPrefs(undefined);
  assert.deepEqual(d, DEFAULTS);
  // a default handed out is a copy: changing it never changes the next read
  d.routines.quietHours!.start = '01:00';
  assert.equal(readMomoPrefs(null).routines.quietHours!.start, '22:00');
  assert.ok(Object.isFrozen(MOMO_DEFAULTS));
  const junk = {
    brain: { topics: { harness: 'nope' }, routines: [], quickAsk: { harness: 'codex', account: 3 } },
    atLimit: 'sometimes',
    routines: { proactivity: 'loud', quietHours: { start: '22:00', end: '22:00' }, feedAt: '25:00', starter: ['morningFeed', 'rm -rf'] },
    notify: { needsAnswer: 'yes', topicDone: 'maybe' },
    paused: 1,
    persona: { name: '   ', style: 'loud' },
    onboarding: { done: false, step: 4 },
  };
  assert.deepEqual(readMomoPrefs(junk), DEFAULTS);
  assert.equal(readMomoPrefs({ atLimit: { main: 'sometimes' } }).atLimit, 'nextAccount', 'an older build’s rule that is junk');
  assert.deepEqual(readMomoPrefs([]), DEFAULTS);
  assert.deepEqual(readMomoPrefs({ routines: 'x' }), DEFAULTS);
});

test('what is saved reads back; an account or model left out is the harness’s own; null quiet hours is none', () => {
  const saved = {
    brain: {
      main: MAIN,
      topics: { harness: 'codex', account: 'team', model: 'gpt-5.5', modelLabel: 'GPT-5.5' },
      routines: { harness: 'acp:gemini', account: null, model: null, modelLabel: null },
      quickAsk: { harness: 'claude' },
    },
    atLimit: 'pause',
    routines: { proactivity: 'high', quietHours: null, feedAt: '07:05', starter: ['bills', 'bills', 'weekAhead'] },
    notify: { needsAnswer: false, topicDone: true },
    paused: true,
    persona: { name: '  Mo  ', style: 'warm' },
    onboarding: { done: true, step: 0 },
  };
  assert.deepEqual(readMomoPrefs(saved), {
    atLimit: 'pause',
    // a Feed time or topic switch an older build saved is no setting any more: it is not read
    routines: { proactivity: 'high', quietHours: null, starter: ['bills', 'weekAhead'] },
    notify: { needsAnswer: false, pushBody: false },
    remote: { brainChange: false },
    paused: true,
    tasksPanel: false,
    brief: false,
    suggestions: false,
    channels: false,
    shell: false,
    sessions: false,
    sessionsShow: true,
    sessionsAct: false,
    persona: { name: 'Mo', color: 'clay' },
    onboarding: { done: true, step: 0 },
  });
  // setup is one screen: a step an older build saved reads as the start
  assert.deepEqual(readMomoPrefs({ onboarding: { done: false, step: 2 } }).onboarding, { done: false, step: 0 });
  assert.deepEqual(
    readMomoPrefs({ onboarding: { done: true, step: 3 } }).onboarding,
    { done: true, step: 0 },
    'one who skipped on a later step stays done',
  );
  assert.deepEqual(
    readMomoPrefs({ atLimit: { main: 'pause', routines: 'skip' } }).atLimit,
    'pause',
    'an older build’s: the main chat’s rule',
  );
  assert.deepEqual(readMomoPrefs({ routines: { quietHours: { start: '23:15', end: '06:00' } } }).routines.quietHours, {
    start: '23:15',
    end: '06:00',
  });
  const r = (momo: unknown) => readMomoPrefs(momo);
  assert.equal(r({ persona: { name: 'x'.repeat(41), style: 'warm' } }).persona.name, 'MoMo', 'a name too long');
  assert.equal(r({ persona: { name: 7 } }).persona.name, 'MoMo');
  assert.equal(r({ onboarding: { done: 'no', step: 1 } }).onboarding.done, false);
  assert.equal(r({ onboarding: { done: true, step: 1.5 } }).onboarding.step, 0);
  assert.equal(r({ onboarding: { done: true, step: -1 } }).onboarding.step, 0);
  assert.equal(r({ routines: { quietHours: [] } }).routines.quietHours!.start, '22:00');
  assert.equal(r({ routines: { quietHours: { start: '1:00', end: '02:00' } } }).routines.quietHours!.start, '22:00');
});

test('one key set: the rest stays, the main chat’s brain included; a key or value it can’t hold is refused', () => {
  const before = { brain: { main: MAIN }, routines: { proactivity: 'low' }, persona: { name: 'Mo' }, other: 1 };
  const r = setMomoPref(before, 'atLimit', 'skip');
  assert.ok(r.ok);
  assert.deepEqual(r.momo, {
    brain: { main: MAIN },
    atLimit: 'skip',
    routines: { proactivity: 'low' },
    persona: { name: 'Mo' },
    other: 1,
  });
  assert.deepEqual(before.brain, { main: MAIN }, 'what was read is not changed in place');
  const q = setMomoPref(before, 'routines.quietHours', null);
  assert.deepEqual(q.ok && q.momo.routines, { proactivity: 'low', quietHours: null });
  const n = setMomoPref(before, 'notify.needsAnswer', false);
  assert.deepEqual(n.ok && n.momo.notify, { needsAnswer: false });
  assert.deepEqual(setMomoPref(undefined, 'paused', true), { ok: true, momo: { paused: true } });
  assert.deepEqual(
    setMomoPref({ atLimit: { main: 'x' } }, 'atLimit', 'pause'),
    { ok: true, momo: { atLimit: 'pause' } },
    'over an older build’s per-role rules',
  );
  // the per-role keys are gone: one brain, one rule
  for (const key of [
    'brain.topics',
    'brain.routines',
    'brain.quickAsk',
    'atLimit.main',
    'atLimit.topics',
    'atLimit.routines',
    'atLimit.quickAsk',
  ])
    assert.equal(setMomoPref({}, key, 'pause').ok, false, key);
  assert.equal(setMomoPref({}, 'atLimit', 'sometimes').ok, false);

  assert.deepEqual(setMomoPref({}, 'brain.main', MAIN), { ok: false, error: 'Not a MoMo setting: brain.main' });
  assert.deepEqual(setMomoPref({}, 'toString', 1), { ok: false, error: 'Not a MoMo setting: toString' });
  assert.deepEqual(setMomoPref({}, 7, 1), { ok: false, error: 'Not a MoMo setting: 7' });
  // the Feed's time and the topic switch are gone with the Feed and Topics
  assert.deepEqual(setMomoPref({}, 'routines.feedAt', '08:00'), { ok: false, error: 'Not a MoMo setting: routines.feedAt' });
  assert.deepEqual(setMomoPref({}, 'notify.topicDone', true), { ok: false, error: 'Not a MoMo setting: notify.topicDone' });
  assert.equal(setMomoPref({}, 'routines.proactivity', 'loud').ok, false);
  assert.equal(setMomoPref({}, 'routines.starter', 'bills').ok, false);
  assert.equal(setMomoPref({}, 'routines.quietHours', { start: '01:00', end: '01:00' }).ok, false);
  // the main brain is chosen through its own flow, never set by a window
  assert.equal(setMomoPref({}, 'brain.main' as any, 'codex').ok, false);
});

test('one resolver: MoMo’s one brain for every role, else none; and whether MoMo is paused', () => {
  const topics = { harness: 'codex', account: 'team', model: null, modelLabel: null };
  const momo = { brain: { main: MAIN, topics } };
  assert.deepEqual(roleBrain(momo), MAIN, 'a per-role brain an older build saved is not used beside the main chat’s');
  assert.equal(roleBrain(undefined), null);
  assert.equal(roleBrain({ brain: { main: { harness: 'nope' } } }), null);
  assert.equal(roleBrain({ brain: { main: { harness: 'nope' }, topics: { harness: 'nope' } } }), null);
  // an older build's per-role brain is the brain until the main chat has one (never none)
  assert.deepEqual(roleBrain({ brain: { topics } }), topics);
  assert.deepEqual(roleBrain({ brain: { routines: topics } }), topics);
  assert.deepEqual(roleBrain({ brain: { quickAsk: topics } }), topics);
  // the brain's effort goes with it (a routine's run follows it); one that is no name is dropped
  assert.deepEqual(roleBrain({ brain: { main: { ...MAIN, effort: 'max' } } }), { ...MAIN, effort: 'max' });
  assert.deepEqual(roleBrain({ brain: { main: { ...MAIN, effort: 3 } } }), MAIN);
  assert.deepEqual(roleBrain({ brain: { main: { ...MAIN, effort: '' } } }), MAIN);
  assert.equal(isMomoPaused({ paused: true }), true);
  assert.equal(isMomoPaused({ paused: 'yes' }), false);
  assert.equal(isMomoPaused(undefined), false);
});

test('migration, once: the main chat’s brain and rule stay, the other roles’ are dropped, and nobody is left with no brain', () => {
  const topics = { harness: 'codex', account: 'team', model: null, modelLabel: null };
  const routines = { harness: 'acp:gemini', account: null, model: null, modelLabel: null };
  // main has a brain: the others go, whatever they said
  const full = migrateMomoPrefs({
    brain: { main: MAIN, topics, routines, quickAsk: topics },
    atLimit: { main: 'pause', topics: 'skip', routines: 'nextAccount', quickAsk: 'skip' },
    persona: { name: 'Mo' },
  });
  assert.deepEqual(full, { brain: { main: MAIN }, atLimit: 'pause', persona: { name: 'Mo' } });
  // run again: nothing left to do
  assert.equal(migrateMomoPrefs(full), null);
  // no main brain yet: the first other role's brain becomes it
  assert.deepEqual(migrateMomoPrefs({ brain: { topics, routines } }), { brain: { main: topics } });
  assert.deepEqual(migrateMomoPrefs({ brain: { quickAsk: routines, other: 1 } }), { brain: { main: routines, other: 1 } });
  // nothing usable to keep: dropped, and no brain is invented
  assert.deepEqual(migrateMomoPrefs({ brain: { topics: { harness: 'nope' } } }), { brain: {} });
  // the rule: the main chat's, or none when it was junk or missing (then the default applies)
  assert.deepEqual(migrateMomoPrefs({ atLimit: { topics: 'skip' } }), {});
  assert.deepEqual(migrateMomoPrefs({ atLimit: { main: 'sometimes' } }), {});
  // already one brain and one rule, or nothing saved: untouched
  assert.equal(migrateMomoPrefs({ brain: { main: MAIN }, atLimit: 'skip' }), null);
  assert.equal(migrateMomoPrefs(undefined), null);
  assert.equal(migrateMomoPrefs([]), null);
  assert.equal(migrateMomoPrefs({}), null);
});

test('Reset puts every setting back to its default, the main chat’s brain too', () => {
  // the brain goes with the main chat it was for, and MoMo is no longer paused
  const after = readMomoPrefs(resetMomoPrefs());
  assert.deepEqual(after, readMomoPrefs(undefined));
  assert.equal(roleBrain(resetMomoPrefs()), null);
  assert.equal(after.paused, false);
});

function setup(o: { allowed?: boolean; saved?: unknown; save?: boolean } = {}) {
  const handlers = new Map<string, (e: unknown, ...args: any[]) => any>();
  let state: any = { prefs: { theme: 'dark', momo: o.saved } };
  const writes: any[] = [];
  const live: any = {
    patchPrefs: (set: Record<string, unknown>) => {
      writes.push(set);
      if (o.save === false) return false;
      state = { ...state, prefs: { ...state.prefs, ...set } };
      return true;
    },
  };
  const allowed = { on: o.allowed ?? true };
  register({ handle: (ch: string, fn: any) => void handlers.set(ch, fn) }, { readState: () => state, live }, { allowed: () => allowed.on });
  const ask = (ch: string, ...args: any[]) => handlers.get(ch)!({}, ...args);
  return { handlers, ask, writes, allowed, live, momo: () => state.prefs.momo };
}

test('momoPrefs:set merges into what main has saved now, so two windows’ changes and the main chat’s brain all stay', () => {
  const h = setup({ saved: { brain: { main: MAIN } } });
  assert.deepEqual([...h.handlers.keys()], ['momoPrefs:set']);
  // two windows each change a key before either hears of the other's change
  assert.deepEqual(h.ask('momoPrefs:set', 'notify.needsAnswer', false), { value: true });
  assert.deepEqual(h.ask('momoPrefs:set', 'routines.proactivity', 'high'), { value: true });
  assert.deepEqual(h.momo(), { brain: { main: MAIN }, notify: { needsAnswer: false }, routines: { proactivity: 'high' } });
  assert.deepEqual(h.writes.at(-1), { momo: h.momo() }, 'only prefs.momo is written');
});

test('momoPrefs:set: no resume while a reset runs; pausing then, or resuming after, goes through', async () => {
  const { whileResetting } = require('../electron/momo/stores.cjs');
  const h = setup({ saved: { paused: true } });
  let release: () => void = () => {};
  const reset = whileResetting(() => new Promise<void>((r) => (release = r)));
  assert.deepEqual(h.ask('momoPrefs:set', 'paused', false), { error: { message: 'MoMo resumes once its reset is done.', code: 'busy' } });
  assert.deepEqual(h.ask('momoPrefs:set', 'paused', true), { value: true });
  assert.equal(h.momo().paused, true);
  release();
  await reset;
  assert.deepEqual(h.ask('momoPrefs:set', 'paused', false), { value: true });
  assert.equal(h.momo().paused, false);
});

test('momoPrefs: a bad key or value, a failed save, MoMo turned off: nothing written, the reason in the user’s words', () => {
  const h = setup({ saved: { paused: false } });
  assert.deepEqual(h.ask('momoPrefs:set', 'brain.main', MAIN), {
    error: { message: "Couldn't save MoMo's settings. Not a MoMo setting: brain.main", code: 'bad_args' },
  });
  assert.deepEqual(h.writes, []);
  h.allowed.on = false;
  assert.deepEqual(h.ask('momoPrefs:set', 'paused', true), { error: { message: 'MoMo is not available.', code: 'not_allowed' } });
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.momo(), { paused: false });

  const failed = setup({ save: false });
  assert.deepEqual(failed.ask('momoPrefs:set', 'paused', true), {
    error: { message: "Couldn't save MoMo's settings.", code: 'save_failed' },
  });
  // main before chats registered: no writer yet
  const early = setup();
  delete early.live.patchPrefs;
  assert.equal(early.ask('momoPrefs:set', 'paused', true).error.code, 'save_failed');
  // a disk error: its text and path go to the log, the user is told the save failed
  const disk = setup();
  disk.live.patchPrefs = () => {
    throw Object.assign(new Error("EACCES: permission denied, open '/Users/me/ui-state.json'"), { code: 'EACCES' });
  };
  assert.deepEqual(disk.ask('momoPrefs:set', 'paused', true), {
    error: { message: "Couldn't save MoMo's settings.", code: 'save_failed' },
  });
  assert.ok(recentIgnored().some((e: any) => e.context === "save MoMo's settings" && /EACCES/.test(e.message)));
  const odd = setup();
  odd.live.patchPrefs = () => {
    throw 'disk';
  };
  assert.equal(odd.ask('momoPrefs:set', 'paused', true).error.code, 'save_failed');
});

test('registered with main’s IPC deps, the gate decides by default', () => {
  const handlers = new Map<string, any>();
  register({ handle: (ch: string, fn: any) => void handlers.set(ch, fn) }, { readState: () => ({}), live: { patchPrefs: () => true } });
  // the real gate is closed in a test run (no account)
  assert.equal(handlers.get('momoPrefs:set')({}, 'paused', true).error.code, 'not_allowed');
});

test('a window’s prefs:patch that names prefs.momo is refused whole and logged; others go through, and main still writes it', (t) => {
  const { threads, ui } = tmp(t);
  const h = new Map<string, any>();
  const sent: any[] = [];
  const { patchPrefs } = registerChats(
    { handle: (ch: string, f: any) => h.set(ch, f) },
    { store: new ChatsStore(threads, { uiState: ui }), uiState: ui, broadcast: (...a: any[]) => sent.push(a) },
  );
  const momo = { brain: { main: MAIN } };
  assert.equal(patchPrefs({ momo }), true);
  const told = sent.length;
  // a window holding an older copy of MoMo's settings sends it with an unrelated change: not saved, and it is told so
  assert.equal(h.get('prefs:patch')({ sender: 'w1' }, { mobileRemoteOwner: 'forged', wrapCode: true }, []), false);
  assert.equal(h.get('prefs:patch')({ sender: 'w1' }, {}, ['mobileRemoteOwner']), false);
  assert.equal(h.get('prefs:patch')({ sender: 'w1' }, { momo: { paused: true }, wrapCode: true }, ['gone']), false);
  assert.equal(h.get('prefs:patch')({ sender: 'w1' }, { wrapCode: true }, ['momo']), false, 'removing it too');
  assert.equal(sent.length, told, 'no window hears of a change');
  flushPendingWrites();
  assert.deepEqual(JSON.parse(fs.readFileSync(ui, 'utf8')).prefs, { momo });
  assert.ok(recentIgnored().some((e: any) => e.context === 'save a window’s prefs' && /main owns momo/.test(e.message)));
  assert.equal(h.get('prefs:patch')({ sender: 'w1' }, { wrapCode: true }, ['gone']), true);
  assert.deepEqual(sent.at(-1), ['prefs:changed', 'w1', { set: { wrapCode: true }, unset: ['gone'] }]);
  flushPendingWrites();
  assert.deepEqual(JSON.parse(fs.readFileSync(ui, 'utf8')).prefs, { momo, wrapCode: true });
  // a patch that isn't a record or a list goes on as before
  assert.equal(h.get('prefs:patch')({ sender: 'w1' }, 'x', 'y'), true);
  assert.deepEqual(sent.at(-1)[2], { set: {}, unset: [] });
});

test('MoMo’s color is one of the five it offers (Clay by default) (#2607)', () => {
  const r = (momo: unknown) => readMomoPrefs(momo);
  assert.equal(r({ persona: { color: 'violet' } }).persona.color, 'violet');
  assert.equal(r({ persona: { color: 'pink' } }).persona.color, 'clay', 'a color it does not offer');
  assert.equal(r({ persona: { color: 3 } }).persona.color, 'clay');
  assert.deepEqual(setMomoPref({}, 'persona.color', 'ink'), { ok: true, momo: { persona: { color: 'ink' } } });
  assert.equal(setMomoPref({}, 'persona.color', 'pink').ok, false);
  assert.equal('greeting' in r({}), false, 'no first words are kept in the settings');
});

test('proactivity limits: routine runs a day per level, nothing else', () => {
  assert.deepEqual(MOMO_PROACTIVITY_LIMITS, { off: { runs: 0 }, low: { runs: 2 }, default: { runs: 6 }, high: { runs: 12 } });
  assert.ok(Object.isFrozen(MOMO_PROACTIVITY_LIMITS.low));
});

test('remote.brainChange is a yes/no setting, off unless saved on', () => {
  assert.equal(readMomoPrefs({}).remote.brainChange, false);
  assert.equal(readMomoPrefs({ remote: { brainChange: true } }).remote.brainChange, true);
  assert.equal(readMomoPrefs({ remote: { brainChange: 'yes' } }).remote.brainChange, false);
  const on = setMomoPref({}, 'remote.brainChange', true);
  assert.deepEqual(on.ok && on.momo.remote, { brainChange: true });
  assert.equal(setMomoPref({}, 'remote.brainChange', 'yes').ok, false);
});

test('notify.pushBody is a yes/no setting, off unless saved on', () => {
  assert.equal(readMomoPrefs({}).notify.pushBody, false);
  assert.equal(readMomoPrefs({ notify: { pushBody: true } }).notify.pushBody, true);
  assert.equal(readMomoPrefs({ notify: { pushBody: 'yes' } }).notify.pushBody, false);
  const on = setMomoPref({ notify: { needsAnswer: false } }, 'notify.pushBody', true);
  assert.deepEqual(on.ok && on.momo.notify, { needsAnswer: false, pushBody: true });
  assert.equal(setMomoPref({}, 'notify.pushBody', 'yes').ok, false);
});
