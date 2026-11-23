// electron/platform/scheduler.cjs edge cases: the interval timer and its first check, defaults, a failing list,
// and the rule helpers it exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { Scheduler, nextRun, TICK_MS } = require('../electron/platform/scheduler.cjs');
const { RunLedger } = require('../electron/platform/runLedger.cjs');

function ledger(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, '.baseline'), '1');
  return new RunLedger({ dir: d });
}
const sessions = () => ({ all: () => [], has: () => false, get: () => null, patch: () => {} });

test('nextRun: the shared rule reading', () => {
  const at = new Date(Date.UTC(2030, 0, 1, 9, 0, 30));
  assert.ok(nextRun('FREQ=MINUTELY', at)!.getTime() > at.getTime());
  assert.equal(nextRun('NOT A RULE', at), null);
});

test('defaults: 30 s ticks, real clock, no-op notify, log and before, no native apps', async (t) => {
  const s = new Scheduler({
    enabled: () => true,
    list: async () => [{ id: 'x', status: 'ACTIVE', rrule: 'FREQ=MINUTELY', native_app: 'codex-app' }],
    run: async () => 'chat',
    sessions: sessions(),
    ledger: ledger(t),
  });
  assert.equal(s.tickMs, TICK_MS);
  await s.tick();
  const f = new Scheduler({
    enabled: () => true,
    list: async () => [{ id: 'x', status: 'ACTIVE', rrule: 'FREQ=MINUTELY' }],
    run: async () => {
      throw new Error('no');
    },
    sessions: sessions(),
    ledger: ledger(t),
  });
  await f.tick();
  assert.ok(Math.abs(f.now() - Date.now()) < 5000);
});

test('start checks at once (catching up), then on an interval (once); stop ends it', async (t) => {
  const logs: string[] = [];
  let ticks = 0;
  const s = new Scheduler({
    enabled: () => true,
    list: async () => (ticks++, [{ id: 't', status: 'ACTIVE', rrule: 'FREQ=MINUTELY' }]),
    run: async () => {
      throw 'plain';
    },
    sessions: sessions(),
    ledger: ledger(t),
    tickMs: 5,
    log: (m: string) => logs.push(m),
  });
  s.start();
  const timer = s.timer;
  s.start();
  assert.equal(s.timer, timer);
  // the first check at once, then the interval's (a loaded machine may take a while)
  await waitFor(() => ticks >= 2, 'two scheduler checks');
  s.stop();
  assert.equal(s.timer, null);
  assert.ok(ticks >= 2);
  assert.ok(logs.some((l) => l === 'scheduled task t did not start: plain'));
  // tickMs 0: no timer and no check (a test moves the clock)
  const quiet = new Scheduler({
    enabled: () => true,
    list: async () => (ticks++, []),
    run: async () => '',
    sessions: sessions(),
    ledger: ledger(t),
    tickMs: 0,
  });
  const before = ticks;
  quiet.start();
  assert.equal(quiet.timer, null);
  assert.equal(ticks, before);
});

test('a throwing list is swallowed by the interval tick and reported to a caller', async (t) => {
  const s = new Scheduler({
    enabled: () => true,
    list: async () => {
      throw new Error('io');
    },
    run: async () => '',
    sessions: sessions(),
    ledger: ledger(t),
    tickMs: 5,
  });
  s.start();
  await new Promise((r) => setTimeout(r, 20));
  s.stop();
  await assert.rejects(s.tick(), /io/);
  // the interval logs a failed check, whatever was thrown
  const logs: string[] = [];
  const raw = new Scheduler({
    enabled: () => true,
    list: async () => {
      throw 'offline';
    },
    run: async () => '',
    sessions: sessions(),
    ledger: ledger(t),
    tickMs: 5,
    log: (m: string) => logs.push(m),
  });
  raw.start();
  await waitFor(() => logs.length, 'the failure to be logged');
  raw.stop();
  assert.equal(logs[0], 'scheduled tasks: a check failed: offline');
});
