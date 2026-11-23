// A Claude chat picks its login before the turn, not after the limit: a signed-in login that is held back (a limit seen,
// a lapse marked) is passed over for the usable one of its lane with the most left, a failed turn's switch ranks the
// same way, and what main has seen of each login survives a restart (identity/contract/switch.cjs, identity/contract/loginMarks.cjs, identity/contract/accountDirs.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { claudeLoginFor, decideClaudeSwitch } = require('../electron/identity/contract/switch.cjs');
const { LoginMarks } = require('../electron/identity/contract/loginMarks.cjs');
const { fileMarksStore } = require('../electron/identity/contract/accountDirs.cjs');
const { usageTextLeft } = require('../shared/claudeRateLimit.mjs');

const sub = (id: string, extra: any = {}) => ({ id, email: `${id}@example.test`, authMethod: 'claude.ai', loggedIn: true, ...extra });
const key = (id: string) => ({ id, authMethod: 'api_key', loggedIn: true });
const NOW = 10_000;

test('a signed-in pick that is out of usage is passed over for the login of its lane with the most left', () => {
  const view = { active: 'a', autoSwitch: true, accounts: [sub('a'), sub('b'), sub('c')] };
  const marks = new Map<string, any>([
    ['a', { limitedUntil: NOW + 1 }],
    ['b', { left: 20 }],
    ['c', { left: 70 }],
  ]);
  assert.equal(claudeLoginFor('a', view, marks, NOW), 'c');
  // no pick: the active login runs, and it is the one that is out
  assert.equal(claudeLoginFor(null, view, marks, NOW), 'c');
});

test('a limit that has ended, auto-switch off, and a lane with nothing usable all keep the pick', () => {
  const view = { active: 'a', autoSwitch: true, accounts: [sub('a'), sub('b')] };
  assert.equal(claudeLoginFor('a', view, new Map([['a', { limitedUntil: NOW }]]), NOW), 'a');
  assert.equal(claudeLoginFor('a', { ...view, autoSwitch: false }, new Map([['a', { limitedUntil: NOW + 1 }]]), NOW), 'a');
  const both = new Map<string, any>([
    ['a', { limitedUntil: NOW + 1 }],
    ['b', { expired: true }],
  ]);
  assert.equal(claudeLoginFor('a', view, both, NOW), 'a');
});

test('a pick marked lapsed while its status still reads signed in moves within the lane; another billing lane never does', () => {
  const view = { active: 'a', autoSwitch: true, accounts: [sub('a'), key('k'), sub('b')] };
  assert.equal(claudeLoginFor('a', view, new Map([['a', { expired: true }]]), NOW), 'b');
  const onlyKey = { active: 'a', autoSwitch: true, accounts: [sub('a'), key('k')] };
  assert.equal(claudeLoginFor('a', onlyKey, new Map([['a', { limitedUntil: NOW + 1 }]]), NOW), 'a');
});

test('what was left when a limit struck says nothing once it has ended: the login counts as full again', () => {
  const view = { active: 'a', autoSwitch: true, accounts: [sub('a'), sub('b'), sub('c')] };
  const marks = new Map<string, any>([
    ['a', { limitedUntil: NOW + 1 }],
    ['b', { left: 40 }],
    ['c', { left: 0, limitedUntil: NOW }],
  ]);
  assert.equal(claudeLoginFor('a', view, marks, NOW), 'c');
  assert.equal(claudeLoginFor('a', view, marks, NOW - 5), 'b');
});

test('a chat with no pick stays on the active login while its sign-in status is unread, and moves only for what is marked on it', () => {
  const view = { active: 'a', autoSwitch: true, accounts: [sub('a', { loggedIn: false }), sub('b')] };
  assert.equal(claudeLoginFor(null, view, new Map(), NOW), 'a');
  assert.equal(claudeLoginFor(null, view, new Map([['a', { limitedUntil: NOW + 1 }]]), NOW), 'b');
  assert.equal(claudeLoginFor(null, view, new Map([['a', { expired: true }]]), NOW), 'b');
  assert.equal(claudeLoginFor('a', view, new Map(), NOW), 'b');
  // marked, with no other login to take it: it stays on the active one
  const alone = { active: 'a', autoSwitch: true, accounts: [sub('a')] };
  assert.equal(claudeLoginFor(null, alone, new Map([['a', { limitedUntil: NOW + 1 }]]), NOW), 'a');
});

test('a usable pick stays whatever the others have left, and ties go to the login in use', () => {
  const view = { active: 'b', autoSwitch: true, accounts: [sub('a'), sub('b'), sub('c')] };
  const marks = new Map<string, any>([['c', { left: 90 }]]);
  assert.equal(claudeLoginFor('a', view, marks, NOW), 'a');
  assert.equal(claudeLoginFor('a', view, new Map([['a', { limitedUntil: NOW + 1 }]]), NOW), 'b');
});

test('a message nothing names is the pick that sent it, held or not: only a signed-out pick has a stand-in', () => {
  const view = { active: 'a', autoSwitch: true, accounts: [sub('a'), sub('b'), sub('c', { loggedIn: false })] };
  const held = new Map<string, any>([['a', { limitedUntil: NOW + 1 }]]);
  assert.equal(claudeLoginFor('a', view, held, NOW, false), 'a');
  assert.equal(claudeLoginFor(null, view, held, NOW, false), 'a');
  assert.equal(claudeLoginFor('c', view, held, NOW, false), 'b');
  assert.equal(claudeLoginFor('c', { ...view, autoSwitch: false }, held, NOW, false), 'c');
});

test('the login a failed turn moves to is the one with the most left, the login in use only breaking a tie', () => {
  const view = { active: 'b', autoSwitch: true, accounts: [sub('a'), sub('b'), sub('c')] };
  const marks = new Map<string, any>([
    ['b', { left: 10 }],
    ['c', { left: 80 }],
  ]);
  const d = decideClaudeSwitch({ account: 'a', view, marks, now: NOW });
  assert.equal(d.action, 'switch');
  assert.equal(d.to, 'c');
  const tie = decideClaudeSwitch({ account: 'a', view, marks: new Map(), now: NOW });
  assert.equal(tie.to, 'b');
});

test('a limit still running is kept in a file for the next run; a lapse, a reading and a limit that has ended are not', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-marks-')), 'claude-login-marks.json');
  const first = new LoginMarks(fileMarksStore(file));
  first.limited({ login: true }, 'a', NOW, 60_000);
  first.limited({ login: true }, 'gone', 1, 1);
  first.seen({ login: true }, 'b', 35);
  first.expired({ login: true }, 'c');
  const again = new LoginMarks(fileMarksStore(file), NOW);
  assert.deepEqual(again.get('a'), { limitedUntil: NOW + 60_000 });
  for (const id of ['b', 'c', 'gone']) assert.equal(again.get(id), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: { limitedUntil: NOW + 60_000 }, gone: { limitedUntil: 1 + 1 } });
});

test('an unreadable or foreign marks file starts empty, and a write that fails is not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-marks-'));
  const bad = path.join(dir, 'bad.json');
  for (const text of ['{nope', '[]', '{"a":7,"b":{"left":"x","limitedUntil":"y","expired":1}}']) {
    fs.writeFileSync(bad, text);
    assert.equal(new LoginMarks(fileMarksStore(bad), NOW).get('a'), undefined);
  }
  fs.writeFileSync(path.join(dir, 'plain'), '');
  const blocked = new LoginMarks(fileMarksStore(path.join(dir, 'plain', 'marks.json')), NOW);
  blocked.seen({ login: true }, 'a', 5);
  blocked.limited({ login: true }, 'a', NOW, 5);
  assert.equal(blocked.get('a')?.left, 5);
  assert.equal(new LoginMarks(undefined, NOW).get('a'), undefined);
});

test('a reading of a login is not recorded for a key, and a login that works again is no longer lapsed', () => {
  const marks = new LoginMarks();
  marks.seen({ login: false }, 'a', 5);
  assert.equal(marks.get('a'), undefined);
  marks.expired({ login: true }, 'a');
  marks.seen({ login: true }, 'a', 40);
  assert.deepEqual(marks.get('a'), { expired: true, left: 40 });
  assert.equal(marks.works('a'), true);
  assert.deepEqual(marks.get('a'), { left: 40 });
});

test("the CLI's /usage text gives what is left of the most used window", () => {
  const text = 'Current session\n  ███ 8% used\n  Resets 3pm\nCurrent week (all models)\n  ██ 62% used\nExtra usage\n  99% used';
  assert.equal(usageTextLeft(text), 38);
  assert.equal(usageTextLeft('Current session: 100% used · resets Oct 9'), 0);
  assert.equal(usageTextLeft('Current week (Opus): 12.5% used'), 87);
  assert.equal(usageTextLeft('Nothing to see'), null);
  assert.equal(usageTextLeft('Current session: 140% used'), null);
});

// -- the usage schedule and the adapter carry the figures to the marks --------------------------------------------------
const { createUsageSchedule } = require('../electron/harness/claude/usageSchedule.cjs');
const { UsageRefresh } = require('../electron/identity/contract/usageRefresh.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { claudePreflight } = require('../electron/harness/claude/own.cjs');

function readsOf(text: string, configIdOf = (a: string | undefined) => a ?? 'cur', onLeft?: (login: string, left: number) => void) {
  const t = 1_000_000_000;
  return createUsageSchedule({
    read: async () => text,
    measuredAt: () => t,
    configIdOf,
    active: () => 'cur',
    policy: new UsageRefresh({ now: () => t }),
    now: () => t,
    onLeft,
  });
}

test("a login's own /usage read says what it has left; a key's, an unreadable one and a missing listener say nothing", async () => {
  const seen: [string, number][] = [];
  await readsOf('Current session: 30% used', undefined, (l, n) => seen.push([l, n])).usage('bin', 'a', 'now');
  assert.deepEqual(seen, [['a', 70]]);
  await readsOf(
    'Current session: 30% used',
    () => 'key-folder',
    (l, n) => seen.push([l, n]),
  ).usage('bin', 'a', 'now');
  await readsOf('no figures here', undefined, (l, n) => seen.push([l, n])).usage('bin', 'b', 'now');
  assert.equal(seen.length, 1);
  assert.equal((await readsOf('Current session: 30% used').usage('bin', 'a', 'now')).state, 'success');
});

function adapterWith(o: { marksFile?: string; accounts: any[]; active?: string; own?: Record<string, string>; keyMode?: boolean }) {
  let left = (_a: string, _n: number): void => {};
  const moved: any[] = [];
  const served: any[] = [];
  const events: any[] = [];
  const adapter = new ClaudeAdapter({
    api: {
      isLive: () => false,
      control: async () => {},
      accounts: () => ({ active: o.active ?? 'a', autoSwitch: true, accounts: o.accounts }),
      metered: () => false,
      keyMode: () => !!o.keyMode,
      onLoginLeft: (fn: typeof left) => (left = fn),
    },
    marksFile: o.marksFile,
    state: new SessionStore(),
    prefs: () => ({ permission: 'default' }),
    send: async () => ({ elsewhere: [] }),
    enqueue: () => {},
    chatOf: (k: string) => k,
    ref: (c: string) => ({ kind: 'claude', id: c, key: c }),
    emit: (e: any) => (events.push(e), false),
    moved: (chatId: string, m: any) => void moved.push({ chatId, ...m }),
    served: (chatId: string, account: string) => void served.push([chatId, account]),
    setGoal: () => {},
    notifyGoal: () => {},
    now: () => NOW,
  });
  for (const [chat, account] of Object.entries(o.own ?? {})) adapter.setOwn(chat, { account });
  return { adapter, moved, served, events, left: (a: string, n: number) => left(a, n) };
}

test('the saved limits and the usage reads decide the login a turn starts on, and the chat keeps it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-marks-')), 'marks.json');
  fs.writeFileSync(file, JSON.stringify({ a: { limitedUntil: Date.now() + 60_000 } }));
  const t = adapterWith({ marksFile: file, accounts: [sub('a'), sub('b'), sub('c')], own: { 'claude:x': 'a' } });
  t.left('c', 60);
  t.left('b', 20);
  // until a turn starts, the chat is on its pick
  assert.equal(t.adapter.accountOf('claude:x'), 'a');
  claudePreflight(t.adapter, 'claude:x', 'claude:x');
  assert.equal(t.adapter.accountOf('claude:x'), 'c');
  assert.equal(t.adapter.pickedLogin('claude:x'), 'c');
  assert.deepEqual(
    t.moved.map((m) => m.account),
    ['c'],
  );
  assert.deepEqual(
    t.events.map((e) => [e.kind, e.from, e.to]),
    [['accountSwitched', 'a', 'c']],
  );
  assert.match(t.moved[0].note.text, /a@example\.test.*c@example\.test/);
  // the figures move on: the chat does not follow them back and forth
  t.left('c', 5);
  t.left('b', 90);
  claudePreflight(t.adapter, 'claude:x', 'claude:x');
  assert.equal(t.adapter.accountOf('claude:x'), 'c');
  assert.equal(t.moved.length, 1);
  // only the limit that is running is kept for the next run, not what the reads said
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).c, undefined);
});

test('a usable chat, a temporary chat, a key and a lane with nowhere to go stay on their pick; a lapse is named as one', () => {
  const lapsed = adapterWith({ accounts: [sub('a'), sub('b')], own: { 'claude:l': 'a' } });
  lapsed.adapter.marks.expired({ login: true }, 'a');
  claudePreflight(lapsed.adapter, 'claude:l', 'claude:l');
  assert.equal(lapsed.adapter.accountOf('claude:l'), 'b');
  assert.match(lapsed.moved[0].note.text, /signed out|sign|expired/i);

  const fine = adapterWith({ accounts: [sub('a'), sub('b')], own: { 'claude:f': 'a' } });
  claudePreflight(fine.adapter, 'claude:f', 'claude:f');
  assert.equal(fine.moved.length, 0);

  const temp = adapterWith({ accounts: [sub('a'), sub('b')], own: { 'claude:t': 'a' } });
  temp.adapter.registerSession('claude:t', { ephemeral: true });
  temp.adapter.marks.limited({ login: true }, 'a', NOW, 1_000);
  claudePreflight(temp.adapter, 'claude:t', 'claude:t');
  assert.equal(temp.adapter.accountOf('claude:t'), 'a');

  const key = adapterWith({ accounts: [sub('a'), sub('b')], own: { 'claude:k': 'a' }, keyMode: true });
  key.adapter.marks.limited({ login: true }, 'a', NOW, 1_000);
  claudePreflight(key.adapter, 'claude:k', 'claude:k');
  assert.equal(key.adapter.accountOf('claude:k'), 'a');

  const alone = adapterWith({ accounts: [sub('a')], own: { 'claude:n': 'a' } });
  alone.adapter.marks.limited({ login: true }, 'a', NOW, 1_000);
  claudePreflight(alone.adapter, 'claude:n', 'claude:n');
  assert.equal(alone.adapter.accountOf('claude:n'), 'a');
  assert.equal(alone.moved.length, 0);
});

test('a login that is held but still runs the chat is the one a limit it reports is put on, not its stand-in', () => {
  const t = adapterWith({ accounts: [sub('a'), sub('b')], own: { 'claude:x': 'a' } });
  t.adapter.marks.limited({ login: true }, 'a', NOW, 1_000);
  assert.equal(t.adapter.accountOf('claude:x'), 'a');
});

test('starting a turn moves a chat off a held login before the turn runs', async () => {
  const t = adapterWith({ accounts: [sub('a'), sub('b')], own: { 'claude:x': 'a' } });
  t.adapter.marks.limited({ login: true }, 'a', NOW, 1_000);
  await t.adapter.startTurn('claude:x', { kind: 'claude', id: 'claude:x', key: 'claude:x' }, { text: 'hi' });
  assert.equal(t.adapter.pickOf('claude:x'), 'b');
  assert.deepEqual(
    t.events.filter((e) => e.kind === 'accountSwitched').map((e) => e.to),
    ['b'],
  );
  assert.equal(t.events.find((e) => e.kind === 'turnStarting')?.account, 'b');
  // main keeps the login the turn started on itself, after the move: no window has to echo it (#2538)
  assert.deepEqual(t.served, [['claude:x', 'b']]);
});
