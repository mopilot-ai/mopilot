// A login whose own /usage read says nothing is left is held back like one that refused a turn: a chat picks another login
// before the turn, instead of spending a turn on it first (identity/contract/loginMarks.cjs, harness/claude/usageSchedule.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-claude-unread-')));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'shared');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const require = createRequire(import.meta.url);
const { claudeLoginFor } = require('../electron/identity/contract/switch.cjs');
const { usageTextLimit } = require('../shared/claudeRateLimit.mjs');
const { LoginMarks } = require('../electron/identity/contract/loginMarks.cjs');
const { LIMIT_HOLD_MS } = require('../electron/identity/contract/switch.cjs');
const { fileMarksStore } = require('../electron/identity/contract/accountDirs.cjs');
const { createUsageSchedule } = require('../electron/harness/claude/usageSchedule.cjs');
const { UsageRefresh } = require('../electron/identity/contract/usageRefresh.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { ClaudeAccounts } = require('../electron/harness/claude/accounts.cjs');

const NOW = 10_000_000;
/** seen()'s measuredAt and now: a read the CLI measured a minute ago, and one measured eleven */
const FRESH: [number, number] = [NOW - 60_000, NOW];
const STALE: [number, number] = [NOW - 11 * 60_000, NOW];
const scope = { login: true };
const sub = (id: string) => ({ id, email: `${id}@example.test`, authMethod: 'claude.ai', loggedIn: true });
const view = { active: 'a', autoSwitch: true, accounts: [sub('a'), sub('b')] };

test('a fresh read with nothing left holds the login back, so a chat with or without a pick starts on the other one', () => {
  const marks = new LoginMarks();
  marks.seen(scope, 'a', 0, ...FRESH);
  assert.deepEqual(marks.get('a'), { left: 0, limitedUntil: NOW + LIMIT_HOLD_MS });
  assert.equal(claudeLoginFor('a', view, marks, NOW), 'b');
  assert.equal(claudeLoginFor(null, view, marks, NOW), 'b');
  // the hold ends on its own: with no newer read the login counts as full again
  assert.equal(claudeLoginFor('a', view, marks, NOW + LIMIT_HOLD_MS), 'a');
});

test('an old read, a read with no time, a key and a read with something left do not hold a login back', () => {
  const marks = new LoginMarks();
  marks.seen(scope, 'a', 0, ...STALE);
  marks.seen(scope, 'b', 0);
  marks.seen({ login: false }, 'c', 0, ...FRESH);
  marks.seen(scope, 'd', 3, ...FRESH);
  assert.deepEqual(marks.get('a'), { left: 0 });
  assert.deepEqual(marks.get('b'), { left: 0 });
  assert.equal(marks.get('c'), undefined);
  assert.deepEqual(marks.get('d'), { left: 3 });
  assert.equal(claudeLoginFor('a', view, marks, NOW), 'a');
});

test('a newer read with something left lifts the hold its own read put on; a limit a turn reported is not its to lift', () => {
  const marks = new LoginMarks();
  marks.seen(scope, 'a', 0, ...FRESH);
  marks.seen(scope, 'a', 40, ...FRESH);
  assert.deepEqual(marks.get('a'), { left: 40 });
  // an old read does not lift it
  marks.seen(scope, 'a', 0, ...FRESH);
  marks.seen(scope, 'a', 80, ...STALE);
  assert.equal(marks.get('a')?.limitedUntil, NOW + LIMIT_HOLD_MS);
  // a refused turn's reset is the login's own: neither a read of what is left nor of nothing left changes it
  marks.limited(scope, 'b', NOW, 5 * LIMIT_HOLD_MS);
  marks.seen(scope, 'b', 60, ...FRESH);
  marks.seen(scope, 'b', 0, ...FRESH);
  assert.equal(marks.get('b')?.limitedUntil, NOW + 5 * LIMIT_HOLD_MS);
  // and the turn's refusal takes over a hold a read put on
  marks.usage(scope, 'a', { status: 'rejected', utilization: 1, resetsAt: Math.floor((NOW + 2 * LIMIT_HOLD_MS) / 1000) }, NOW);
  marks.seen(scope, 'a', 50, ...FRESH);
  assert.equal(marks.get('a')?.limitedUntil, Math.floor((NOW + 2 * LIMIT_HOLD_MS) / 1000) * 1000);
});

test('a hold a read put on is not kept for the next run; a limit a turn reported is', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-marks-')), 'claude-login-marks.json');
  const first = new LoginMarks(fileMarksStore(file));
  first.seen(scope, 'a', 0, Date.now(), Date.now());
  first.limited(scope, 'b', Date.now(), 60_000);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['b']);
  // a limit reported for the login whose hold a read put on is kept
  first.limited(scope, 'a', Date.now(), 60_000);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['a', 'b']);
});

test("the usage schedule says when a login's own read was measured", async () => {
  const t = 1_000_000_000;
  const seen: unknown[][] = [];
  const schedule = createUsageSchedule({
    read: async () => 'Current session: 100% used · resets Oct 9',
    measuredAt: () => t - 5_000,
    configIdOf: (a: string | undefined) => a ?? 'cur',
    active: () => 'cur',
    policy: new UsageRefresh({ now: () => t }),
    now: () => t,
    onLeft: (...args: unknown[]) => seen.push(args),
  });
  await schedule.usage('bin', 'a', 'now');
  assert.deepEqual(seen, [['a', 0, t - 5_000, null]]);
});

function adapterWith(accounts: any[], own: Record<string, string> = {}) {
  let left = (_a: string, _n: number, _at?: number): void => {};
  const events: any[] = [];
  const adapter = new ClaudeAdapter({
    api: {
      isLive: () => false,
      control: async () => {},
      accounts: () => ({ active: 'a', autoSwitch: true, accounts }),
      metered: () => false,
      keyMode: () => false,
      onLoginLeft: (fn: typeof left) => (left = fn),
    },
    state: new SessionStore(),
    prefs: () => ({ permission: 'default' }),
    send: async () => ({ elsewhere: [] }),
    enqueue: () => {},
    chatOf: (k: string) => k,
    ref: (c: string) => ({ kind: 'claude', id: c, key: c }),
    emit: (e: any) => (events.push(e), false),
    moved: () => {},
    setGoal: () => {},
    notifyGoal: () => {},
    now: () => NOW,
  });
  for (const [chat, account] of Object.entries(own)) adapter.setOwn(chat, { account });
  return { adapter, events, left: (a: string, n: number, at?: number) => left(a, n, at) };
}

test('a read that says nothing is left moves a chat off that login before its turn, and a read with no time does not', async () => {
  const t = adapterWith([sub('a'), sub('b')], { 'claude:x': 'a' });
  t.left('a', 0);
  await t.adapter.startTurn('claude:x', { kind: 'claude', id: 'claude:x', key: 'claude:x' }, { text: 'hi' });
  assert.equal(t.adapter.pickOf('claude:x'), 'a');
  t.left('a', 0, NOW - 1_000);
  await t.adapter.startTurn('claude:x', { kind: 'claude', id: 'claude:x', key: 'claude:x' }, { text: 'hi' });
  assert.equal(t.adapter.pickOf('claude:x'), 'b');
  assert.deepEqual(
    t.events.filter((e) => e.kind === 'accountSwitched').map((e) => [e.from, e.to]),
    [['a', 'b']],
  );
});

test("the CLI's own login says it has not been read until a read of it lands, whatever that read found", async () => {
  const userData = path.join(tmp, 'view');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'claude-accounts.json'),
    JSON.stringify({ active: 'default', accounts: [{ id: 'added', email: 'added@example.test', loggedIn: true }] }),
  );
  const answers: (string | Error)[] = [JSON.stringify({ loggedIn: true, email: 'cli@example.test' }), new Error('no CLI')];
  const m = new ClaudeAccounts({
    userData,
    broadcast: () => {},
    run: async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    },
  });
  const checked = () => m.view().accounts.map((a: any) => [a.id, a.checked, a.loggedIn]);
  // an added login is as it was last saved; the CLI's own has not been read
  assert.deepEqual(checked(), [
    ['default', false, false],
    ['added', true, true],
  ]);
  await m.refresh('bin');
  assert.equal(m.view().accounts[0].checked, true);
  assert.equal(m.view().accounts[0].loggedIn, true);
  // a read that fails is an answer too: the offer is not held back for good
  const failing = new ClaudeAccounts({
    userData: path.join(tmp, 'view2'),
    broadcast: () => {},
    run: async () => Promise.reject(new Error('no CLI')),
  });
  await failing.refresh('bin');
  assert.equal(failing.view().accounts[0].checked, true);
});

// What the CLI printed for a login whose week was used up (the text a real /usage gave for the meggie login, 2026-10-31).
const WEEK_FULL = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current week (all models): 100% used · resets Nov 1 at 10am (America/Los_Angeles)',
  'Current week (Fable): 9% used · resets Nov 1 at 9:59am (America/Los_Angeles)',
  '',
  "What's contributing to your limits usage?",
].join('\n');
const PRINTED = Date.UTC(2026, 9, 31, 18, 0); // Oct 31 11:00 in Los Angeles

test('the /usage text of a used-up login gives what is left and the reset it prints, in the zone it names', () => {
  const r = usageTextLimit(WEEK_FULL, PRINTED);
  assert.equal(r.left, 0);
  assert.equal(new Date(r.resetsAt).toISOString(), '2026-11-01T18:00:00.000Z');
  // only a used-up window has a reset to hold until; nothing printed is nothing known
  assert.deepEqual(usageTextLimit('Current session: 12% used · resets 5pm', PRINTED), { left: 88, resetsAt: null });
  assert.deepEqual(usageTextLimit('Current session: 100% used', PRINTED), { left: 0, resetsAt: null });
  assert.deepEqual(usageTextLimit('Current session: 100% used · resets someday', PRINTED), { left: 0, resetsAt: null });
  assert.equal(usageTextLimit('Nothing to see', PRINTED), null);
  // the latest reset of the windows that are used up
  const two = 'Current session: 100% used · resets 5pm (UTC)\nCurrent week (all models): 100% used · resets Nov 1 at 10am (UTC)';
  // (the bare 5pm is the next 5pm after the read, Nov 1 17:00Z, later than the week's 10:00Z)
  assert.equal(new Date(usageTextLimit(two, PRINTED).resetsAt).toISOString(), '2026-11-01T17:00:00.000Z');
});

test('a read that prints when the login starts over holds it back until then, however old the read and however idle the app', () => {
  const marks = new LoginMarks();
  const { left, resetsAt } = usageTextLimit(WEEK_FULL, PRINTED);
  // measured a day ago (the CLI's cache): the reset it printed is still ahead, so the login is still out
  marks.seen(scope, 'a', left, PRINTED - 24 * 3600_000, PRINTED, resetsAt);
  assert.equal(marks.get('a')?.limitedUntil, resetsAt);
  assert.equal(claudeLoginFor('a', view, marks, PRINTED + 20 * 3600_000), 'b');
  // the next fresh read of something left (an upgrade, extra usage) lifts it; the reset passing does too
  assert.equal(claudeLoginFor('a', view, marks, resetsAt), 'a');
  marks.seen(scope, 'a', 40, PRINTED, PRINTED);
  assert.deepEqual(marks.get('a'), { left: 40 });
  // a reset that has passed since the read holds nothing
  marks.seen(scope, 'b', 0, PRINTED, PRINTED, PRINTED - 1);
  assert.equal(marks.get('b')?.limitedUntil, PRINTED + LIMIT_HOLD_MS);
});
