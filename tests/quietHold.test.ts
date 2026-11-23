// Notifications held through the Mac's quiet hours: a "needs you" waits for the window to end and is said once, also across midnight, a Mac that slept, a restart, a relay that was down and a check that overlaps itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createQuietHold, quietWindow, CHECK_MS, STALE_MS, KEEP } = require('../electron/platform/quietHold.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const at = (day: number, h: number, m = 0) => new Date(2030, 0, day, h, m).getTime();
const NIGHT = { start: '22:00', end: '07:00' };

function rig(o: { quiet?: unknown; start?: number; file?: string; deliver?: (h: any) => any; still?: (kind: string) => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-hold-'));
  const state = {
    now: o.start ?? at(1, 23),
    quiet: o.quiet === undefined ? NIGHT : o.quiet,
    said: [] as any[],
    timers: [] as (() => void)[],
    cancelled: 0,
  };
  const make = (file = o.file ?? path.join(dir, 'held.json')) =>
    createQuietHold({
      quietHours: () => state.quiet,
      deliver: (h: any) => (state.said.push(h), o.deliver ? o.deliver(h) : true),
      file,
      ...(o.still && { still: o.still }),
      now: () => state.now,
      schedule: (fn: () => void) => (state.timers.push(fn), state.timers.length),
      cancel: () => void state.cancelled++,
    });
  return { state, hold: make(), make, file: path.join(dir, 'held.json'), fire: () => state.timers.splice(0).forEach((f) => f()) };
}
const saved = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')).held.map((e: any) => e.chatId);

test('quietWindow reads two different clock times, and nothing else', () => {
  assert.deepEqual(quietWindow(NIGHT), { start: 22 * 60, end: 7 * 60 });
  for (const bad of [null, undefined, {}, { start: '22:00', end: '22:00' }, { start: '25:00', end: '07:00' }, 'x'])
    assert.equal(quietWindow(bad), null);
});

test('outside the window nothing is held; inside it a "needs you" is held and any other banner is dropped for good', () => {
  const r = rig({ start: at(1, 12) });
  assert.equal(r.hold.hold('c1', true), false);
  r.state.now = at(1, 23);
  assert.equal(r.hold.hold('done', false), true);
  assert.equal(r.hold.size, 0, 'a finished turn is not said later');
  assert.equal(r.hold.hold('c1', true), true);
  assert.equal(r.hold.size, 1);
});

test('no quiet hours set holds nothing at any time of night', () => {
  const r = rig({ quiet: null });
  assert.equal(r.hold.hold('c1', true), false);
  assert.equal(r.hold.size, 0);
});

test('quiet hours across midnight: held at 23:30 and 02:00, silent until 07:00, then said once for the newest chat', async () => {
  const r = rig({ start: at(1, 23, 30) });
  r.hold.hold('c1', true);
  r.state.now = at(2, 2);
  r.hold.hold('c2', true);
  assert.deepEqual(saved(r.file), ['c1', 'c2']);
  r.state.now = at(2, 6, 59);
  r.fire();
  await tick();
  assert.deepEqual(r.state.said, [], 'still quiet one minute before the end');
  assert.equal(r.state.timers.length, 1, 'and it looks again');
  r.state.now = at(2, 7);
  r.fire();
  await tick();
  assert.deepEqual(r.state.said, [{ chatId: 'c2', at: at(2, 2), count: 2 }]);
  assert.equal(r.hold.size, 0);
  assert.deepEqual(saved(r.file), []);
  r.fire();
  await tick();
  assert.equal(r.state.said.length, 1, 'never again');
});

test('a window inside one day (13:00 to 14:00) works as well', async () => {
  const r = rig({ quiet: { start: '13:00', end: '14:00' }, start: at(1, 13, 30) });
  r.hold.hold('c1', true);
  r.state.now = at(1, 14);
  r.fire();
  await tick();
  assert.deepEqual(r.state.said, [{ chatId: 'c1', at: at(1, 13, 30), count: 1 }]);
});

test('a Mac asleep through the window says it once at the first check after waking, whatever timers do', async () => {
  const r = rig({ start: at(1, 22, 30) });
  r.hold.hold('c1', true);
  // the Mac sleeps from 22:31 to 09:30: no timer fired meanwhile
  r.state.now = at(2, 9, 30);
  await r.hold.check();
  assert.deepEqual(r.state.said, [{ chatId: 'c1', at: at(1, 22, 30), count: 1 }]);
  assert.equal(r.state.cancelled, 1, 'the waiting timer was cancelled by the check');
  r.fire();
  await tick();
  assert.equal(r.state.said.length, 1, 'a timer that fires after the wake check says nothing more');
});

test('a restart keeps what waited: the next run loads it and says it once after the window', async () => {
  const r = rig({ start: at(1, 23) });
  r.hold.hold('c1', true);
  r.hold.hold('c2', true);
  // the app quits and starts again at 08:00
  r.state.now = at(2, 8);
  r.state.timers.length = 0;
  const again = r.make();
  assert.equal(again.size, 2);
  assert.equal(r.state.timers.length, 1, 'it looks as soon as it starts');
  r.fire();
  await tick();
  assert.deepEqual(r.state.said, [{ chatId: 'c2', at: at(1, 23), count: 2 }]);
  assert.equal(r.make().size, 0, 'and the next start finds nothing to say');
});

test('a restart inside the window keeps waiting', async () => {
  const r = rig({ start: at(1, 23) });
  r.hold.hold('c1', true);
  r.state.now = at(2, 1);
  r.make();
  r.fire();
  await tick();
  assert.deepEqual(r.state.said, []);
});

test('the relay is down: it is kept and said again at the next look, once it is taken', async () => {
  const answers = [false, new Error('boom'), true];
  const r = rig({
    deliver: () => {
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a;
    },
  });
  r.hold.hold('c1', true);
  r.state.now = at(2, 8);
  for (let i = 0; i < 3; i++) {
    r.fire();
    await tick();
  }
  assert.equal(r.state.said.length, 3);
  assert.equal(r.hold.size, 0);
  assert.ok(recentIgnored().some((e: any) => e.context.includes('say the notifications held')));
  r.fire();
  await tick();
  assert.equal(r.state.said.length, 3, 'taken once, said once');
});

test('looks that overlap say it once: a second check while one is being said waits', async () => {
  let release!: (v: boolean) => void;
  const r = rig({ deliver: () => new Promise<boolean>((resolve) => (release = resolve)) });
  r.hold.hold('c1', true);
  r.state.now = at(2, 8);
  r.state.timers.length = 0;
  const first = r.hold.check();
  const second = r.hold.check();
  await second;
  assert.equal(r.state.said.length, 1);
  assert.equal(r.state.timers.length, 1, 'the second one re-armed instead of saying it again');
  release(true);
  await first;
  assert.equal(r.hold.size, 0);
});

test('what came in while it was being said stays for the next window', async () => {
  let release!: (v: boolean) => void;
  const r = rig({ deliver: () => new Promise<boolean>((resolve) => (release = resolve)) });
  r.hold.hold('c1', true);
  r.state.now = at(2, 8);
  const pending = r.hold.check();
  r.state.now = at(2, 22, 30);
  r.hold.hold('c9', true);
  release(true);
  await pending;
  assert.deepEqual(saved(r.file), ['c9']);
});

test('a "needs you" older than a day is not said, and a chat that is answered is taken back', async () => {
  const r = rig({ start: at(1, 23) });
  r.hold.hold('old', true);
  r.hold.hold('gone', true);
  r.hold.retract('gone');
  r.hold.retract('never-held');
  assert.deepEqual(saved(r.file), ['old']);
  r.state.now = at(1, 23) + STALE_MS + 1;
  r.fire();
  await tick();
  assert.deepEqual(r.state.said, []);
  assert.equal(r.hold.size, 0);
  assert.deepEqual(saved(r.file), []);
  r.hold.hold('c', true);
  r.hold.retract('c');
  assert.equal(r.state.cancelled >= 1, true, 'nothing waits, so nothing is looked at');
});

test('the same chat held again moves to the newest, and no more than KEEP chats wait', () => {
  const r = rig();
  r.hold.hold('a', true);
  r.hold.hold('b', true);
  r.hold.hold('a', true);
  assert.deepEqual(saved(r.file), ['b', 'a']);
  for (let i = 0; i < KEEP + 5; i++) r.hold.hold(`n${i}`, true);
  assert.equal(r.hold.size, KEEP);
  assert.equal(saved(r.file).includes('b'), false);
});

test('turning quiet hours off ends them: what waited is said at the next check', async () => {
  const r = rig();
  r.hold.hold('c1', true);
  r.state.quiet = null;
  await r.hold.check();
  assert.deepEqual(r.state.said, [{ chatId: 'c1', at: at(1, 23), count: 1 }]);
});

test('a saved file that is damaged or holds odd entries reads as less, never as a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-hold-bad-'));
  const file = path.join(dir, 'held.json');
  fs.writeFileSync(file, '{not json');
  const r = rig({ file });
  assert.equal(r.make(file).size, 0);
  assert.ok(recentIgnored().some((e: any) => e.context.includes('read the notifications held')));
  fs.writeFileSync(
    file,
    JSON.stringify({ held: [{ chatId: 'ok', at: 5 }, { chatId: '', at: 5 }, { chatId: 'x', at: 'no' }, null, { at: 1 }] }),
  );
  assert.equal(r.make(file).size, 1);
  fs.writeFileSync(file, JSON.stringify({ held: 'nope' }));
  assert.equal(r.make(file).size, 0);
});

test('a file that cannot be written is noted and the hold still works in memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-hold-ro-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file where a folder should be');
  const r = rig({ file: path.join(blocker, 'held.json') });
  const hold = r.make(path.join(blocker, 'held.json'));
  assert.equal(hold.hold('c1', true), true);
  assert.equal(hold.size, 1);
  assert.ok(recentIgnored().some((e: any) => e.context.includes('save the notifications held')));
});

test('the real timers are used by default and do not keep the app alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-hold-real-'));
  const hold = createQuietHold({ quietHours: () => NIGHT, deliver: () => true, file: path.join(dir, 'h.json'), now: () => at(1, 23) });
  hold.hold('c1', true);
  hold.retract('c1');
  assert.equal(CHECK_MS, 60_000);
});

test('a kind that no longer notifies when the hours end is dropped, not said', async () => {
  const off = new Set<string>();
  const r = rig({ still: (kind) => !off.has(kind) });
  r.hold.hold('auth-chat', true, 'auth');
  r.hold.hold('approval-chat', true, 'approval');
  off.add('approval');
  r.state.now = at(2, 8);
  await r.hold.check();
  assert.deepEqual(r.state.said, [{ chatId: 'auth-chat', at: at(1, 23), count: 1 }]);
  assert.deepEqual(saved(r.file), [], 'the dropped one is gone from the file too');
});

test('a chat held again while it is being said stays for the next window', async () => {
  let release!: (v: boolean) => void;
  const r = rig({ deliver: () => new Promise<boolean>((resolve) => (release = resolve)) });
  r.hold.hold('c1', true);
  r.state.now = at(2, 8);
  const pending = r.hold.check();
  r.state.now = at(2, 22, 30);
  r.hold.hold('c1', true);
  release(true);
  await pending;
  assert.deepEqual(saved(r.file), ['c1'], 'the new hold of the same chat is not the one that was said');
});

test('nothing held writes no file, and a time in the future counts from now', async () => {
  const r = rig({ start: at(1, 12) });
  await r.hold.check();
  assert.equal(fs.existsSync(r.file), false);
  fs.writeFileSync(r.file, JSON.stringify({ held: [{ chatId: 'future', at: at(1, 12) + 5 * STALE_MS, kind: 'goal' }] }));
  const again = r.make();
  r.state.now = at(1, 12) + STALE_MS + 1;
  await again.check();
  assert.equal(again.size, 0, 'it went stale as any other would');
});
