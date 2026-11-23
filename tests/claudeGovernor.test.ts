// electron/harness/claude/governor.cjs (#1830): when idle Claude Code CLIs end. The reaper's limits (an hour for a chat's CLI, ten
// minutes for one only warmed, never sooner for one holding the chat's Chrome pages), the cap the least recently active idle
// CLI makes room under, and eviction under memory pressure; only CLIs that may end, never one holding Chrome pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createClaudeGovernor,
  capFor,
  IDLE_MS,
  WARM_IDLE_MS,
  CHROME_IDLE_MS,
  MIN_VICTIM_IDLE_MS,
  WARNING_IDLE_MS,
  WARM_MAX,
} = require('../electron/harness/claude/governor.cjs');

const GB = 1024 ** 3;
const MIN = 60_000;

function setup({ totalmem = 18 * GB, t = 10 * IDLE_MS } = {}) {
  const sessions = new Map<string, any>();
  const retired: string[] = [];
  let now = t;
  const add = (key: string, idle: number, extra: any = {}) => sessions.set(key, { key, lastActive: now - idle, ...extra });
  const g = createClaudeGovernor({
    sessions: () => sessions,
    retirable: (s: any) => !s.busy,
    retire: (key: string) => (retired.push(key), sessions.delete(key)),
    held: (s: any) => !!s.linked,
    totalmem,
    now: () => now,
  });
  return { g, sessions, retired, add, setNow: (n: number) => (now = n), now: () => now };
}

const holding = { chrome: { holdsPages: () => true } };
const blank = { chrome: { holdsPages: () => false } };

test("the cap is Claude Desktop's: one CLI per 3 GB of memory, at least 6", () => {
  assert.equal(capFor(8 * GB), 6);
  assert.equal(capFor(64 * GB), 21);
  assert.equal(setup().g.cap, 6);
});

test("the reaper ends a chat's CLI after an hour, a warmed one never sent to after ten minutes, and one holding pages no sooner than any", () => {
  const { g, add, retired } = setup();
  assert.ok(WARM_IDLE_MS < IDLE_MS && CHROME_IDLE_MS <= IDLE_MS);
  add('used', IDLE_MS - MIN);
  add('used-old', IDLE_MS + MIN);
  add('warm', WARM_IDLE_MS - MIN, { warmOnly: true });
  add('warm-old', WARM_IDLE_MS + MIN, { warmOnly: true });
  add('pages', IDLE_MS - MIN, holding);
  add('pages-old', IDLE_MS + MIN, holding);
  add('blank-old', IDLE_MS + MIN, blank);
  add('busy-old', 2 * IDLE_MS, { busy: true });
  assert.equal(g.idleLimit({ warmOnly: true, ...holding }), IDLE_MS, 'pages outweigh a warm start');
  g.reap();
  assert.deepEqual(retired.sort(), ['blank-old', 'pages-old', 'used-old', 'warm-old']);
});

test('victims: CLIs that may end, idle at least so long, least recently active first; never one woken or (but for critical) holding pages', () => {
  const { g, add } = setup();
  add('b', 5 * MIN);
  add('a', 9 * MIN);
  add('fresh', MIN_VICTIM_IDLE_MS - 1);
  add('pages', 30 * MIN, holding);
  add('busy', 30 * MIN, { busy: true });
  add('woken', 30 * MIN, { woken: true });
  assert.deepEqual(
    g.victims(MIN_VICTIM_IDLE_MS).map((s: any) => s.key),
    ['a', 'b'],
  );
  assert.deepEqual(
    g.victims(MIN_VICTIM_IDLE_MS, undefined, { pages: true }).map((s: any) => s.key),
    ['pages', 'a', 'b'],
  );
});

test('browsing chats keeps at most WARM_MAX CLIs only warmed: the least recently opened ends before another starts', () => {
  const { g, add, retired } = setup({ totalmem: 64 * GB });
  assert.equal(WARM_MAX, 2);
  add('w-old', 3 * MIN, { warmOnly: true });
  add('w-new', 1 * MIN, { warmOnly: true });
  add('used', 30 * MIN);
  assert.equal(g.mayWarm(), true);
  assert.deepEqual(retired, ['w-old'], 'the one sent to stays; one warmed slot is left for the new start');
  // that warm started one; the next ends the older of the two
  add('w-started', 0, { warmOnly: true });
  assert.equal(g.mayWarm(), true);
  assert.deepEqual(retired, ['w-old', 'w-new']);
});

test('at the cap a start makes room by ending the least recently active idle CLI, and is never refused', () => {
  const { g, add, retired, sessions } = setup();
  for (let i = 0; i < 5; i++) add(`c${i}`, (i + 2) * MIN);
  assert.equal(g.makeRoom(), null, 'under the cap');
  add('c5', 30 * 1000);
  assert.equal(g.makeRoom(), 'c4');
  assert.deepEqual(retired, ['c4']);
  // at the cap with nothing idle long enough: nothing ends, and the start still goes ahead
  sessions.clear();
  for (let i = 0; i < 6; i++) add(`n${i}`, 1000);
  assert.equal(g.makeRoom(), null);
  assert.equal(retired.length, 1);
});

test('a warm start runs only with no memory pressure, and under the cap or with room made', () => {
  const { g, add } = setup();
  let level: any = null;
  const unsub = g.watch({ level: () => level, subscribe: () => () => {} });
  assert.equal(typeof unsub, 'function');
  assert.equal(g.mayWarm(), true);
  level = 'warning';
  assert.equal(g.mayWarm(), false);
  level = null;
  for (let i = 0; i < 6; i++) add(`n${i}`, 1000);
  assert.equal(g.mayWarm(), false, 'at the cap with nothing to end');
  add('old', 30 * MIN);
  assert.equal(g.mayWarm(), true);
});

test('memory pressure: warning ends CLIs idle ten minutes, critical every one idle a minute; once a minute per level', () => {
  const { g, add, retired, setNow, now } = setup();
  let hear: (l: any) => void = () => {};
  g.watch({ level: () => null, subscribe: (fn: any) => ((hear = fn), () => {}) });
  add('old', WARNING_IDLE_MS + MIN);
  add('recent', 2 * MIN);
  add('just', 10 * 1000);
  add('pages', WARNING_IDLE_MS + MIN, holding);
  hear(null);
  assert.equal(g.onPressure(null), 0);
  assert.deepEqual(retired, []);
  hear('warning');
  assert.deepEqual(retired, ['old']);
  assert.equal(g.onPressure('warning'), 0, 'swept this minute already');
  assert.equal(g.onPressure('critical'), 2);
  assert.deepEqual(retired, ['old', 'pages', 'recent'], 'critical pressure ends a CLI holding pages too');
  setNow(now() + MIN);
  add('later', 20 * MIN);
  assert.equal(g.onPressure('warning'), 1);
});

test('a CLI whose Remote Control link is wanted is never idle for the reaper, the cap or warning pressure; only critical pressure ends it', () => {
  const { g, add, retired, setNow, now } = setup();
  let hear: (l: any) => void = () => {};
  g.watch({ level: () => null, subscribe: (fn: any) => ((hear = fn), () => {}) });
  add('linked', 3 * IDLE_MS, { linked: true });
  add('plain', IDLE_MS + MIN);
  g.reap();
  assert.deepEqual(retired, ['plain'], 'the reaper leaves the linked CLI be, however long it has been idle');
  assert.deepEqual(
    g.victims(MIN_VICTIM_IDLE_MS).map((s: any) => s.key),
    [],
  );
  assert.deepEqual(
    g.victims(MIN_VICTIM_IDLE_MS, undefined, { pages: true }).map((s: any) => s.key),
    ['linked'],
  );
  // at the cap the start makes room by ending another CLI, never the linked one
  for (let i = 0; i < 5; i++) add(`c${i}`, (i + 2) * MIN);
  assert.equal(g.makeRoom(), 'c4');
  setNow(now() + MIN);
  hear('warning');
  assert.ok(!retired.includes('linked'), 'warning pressure spares it');
  setNow(now() + MIN);
  hear('critical');
  assert.ok(retired.includes('linked'), 'critical pressure ends it; its saved bridge is reattached at the next start');
});
