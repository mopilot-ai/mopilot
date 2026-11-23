// When a Host's desktop tools are announced (electron/host/desktopAnnounce.cjs): at once when it gains a desktop, only after a lost one stays lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { desktopAnnounce } = createRequire(import.meta.url)('../electron/host/desktopAnnounce.cjs');

function rig(start: boolean) {
  const row = { has: start };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let resyncs = 0;
  const a = desktopAnnounce({
    has: () => row.has,
    resync: () => void resyncs++,
    goneMs: 100,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms, live: true }) && timers.at(-1),
    clearTimer: (t: any) => void (t.live = false),
  });
  const fire = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
  return { row, a, fire, timers, resyncs: () => resyncs };
}

test('a Host that gains a desktop is told at once; one that has it from the start is not told again', () => {
  const r = rig(false);
  assert.equal(r.a.announced(), false);
  r.row.has = true;
  r.a.onRow();
  assert.equal(r.a.announced(), true);
  assert.equal(r.resyncs(), 1);
  r.a.onRow();
  assert.equal(r.resyncs(), 1, 'nothing changed');
  assert.equal(rig(true).a.announced(), true);
});

test('a blip does not take the tools away: a desktop that comes back before the wait ends changes nothing, and one that stays lost is told once', () => {
  const r = rig(true);
  r.row.has = false;
  r.a.onRow();
  r.a.onRow();
  assert.equal(r.timers.length, 1, 'one wait however many readings');
  assert.equal(r.a.announced(), true, 'still announced while it may come back');
  r.row.has = true;
  r.a.onRow();
  r.fire();
  assert.equal(r.a.announced(), true);
  assert.equal(r.resyncs(), 0);
  r.row.has = false;
  r.a.onRow();
  r.fire();
  assert.equal(r.a.announced(), false);
  assert.equal(r.resyncs(), 1);
});
