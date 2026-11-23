// What becomes of work on a followed chat that failed (electron/host/remoteJournalFaults.cjs, #5404): read again unless the machine is away or the fault is the machine's storage, one round at a time, and said when it cannot be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeClock } from './support/ports/clock.ts';
import { tick } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { installClock } = require('../electron/platform/ports/clock.cjs');
const { createRemoteJournalFaults } = require('../electron/host/remoteJournalFaults.cjs');

const setup = (t: any, host: any = { state: () => 'online' }) => {
  const clock = fakeClock();
  t.after(installClock(clock));
  const emitted: any[] = [];
  const reported: any[] = [];
  const faults = createRemoteJournalFaults({ emit: (e: any) => emitted.push(e), state: () => null, report: (e: any) => reported.push(e) });
  const f: any = { chatId: 'c', gone: false, shown: new Map(), host, synced: true };
  return { clock, emitted, faults, f, reported };
};

test('a machine that is away, or a storage fault, is not read again; any other failure is', async (t) => {
  const { clock, faults, f } = setup(t);
  let reads = 0;
  const resync = async () => void (reads++, (f.synced = true));
  faults.failed(f, Object.assign(new Error('x'), { code: 'host_unreachable' }), resync);
  faults.failed(f, Object.assign(new Error('x'), { code: 'session_journal_busy' }), resync);
  clock.advance(1000);
  await tick();
  assert.equal(reads, 0);
  faults.failed(f, new Error('plain'), resync);
  clock.advance(1000);
  await tick();
  assert.equal(reads, 1);
});

test('a failure while a round is under way starts no second round, and a chat let go or a machine gone away ends the round', async (t) => {
  const { clock, emitted, faults, f } = setup(t);
  let reads = 0;
  const resync = async () => void (reads++, (f.synced = false));
  faults.failed(f, new Error('a'), resync);
  faults.failed(f, new Error('b'), resync);
  for (const ms of [1000, 4000, 15000]) {
    clock.advance(ms);
    for (let i = 0; i < 4; i++) await tick();
  }
  assert.equal(reads, 3, 'one round of three reads, not two');
  assert.equal(emitted.length, 0, 'no turn was running to end');
  // offline: the round ends and a later failure may start another
  f.host = { state: () => 'offline' };
  faults.failed(f, new Error('c'), resync);
  clock.advance(1000);
  await tick();
  assert.equal(reads, 3);
  f.host = { state: () => 'online' };
  faults.failed(f, new Error('d'), resync);
  f.gone = true;
  clock.advance(1000);
  await tick();
  assert.equal(reads, 3);
});

test('a read that itself fails counts as a round that did not catch up: the next one follows, and nothing is left unhandled', async (t) => {
  const { clock, faults, f, reported } = setup(t);
  let reads = 0;
  const resync = async () => {
    reads++;
    throw new Error('read refused');
  };
  const unhandled: unknown[] = [];
  const seen = (e: unknown) => void unhandled.push(e);
  process.on('unhandledRejection', seen);
  t.after(() => void process.off('unhandledRejection', seen));
  f.synced = false;
  faults.failed(f, new Error('a'), resync);
  for (const ms of [1000, 4000, 15000]) {
    clock.advance(ms);
    for (let i = 0; i < 4; i++) await tick();
  }
  assert.equal(reads, 3);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(
    reported.map((e: Error) => e.message),
    ['read refused', 'read refused', 'read refused'],
    'each failed read is reported',
  );
});

test('a wait to read again never keeps the process alive: a real timer is let go, a fake one has nothing to let go', () => {
  const { later } = require('../electron/host/catchUpRetries.cjs');
  installClock(null);
  let unref = 0;
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const timer = real(fn, ms);
    const original = timer.unref.bind(timer);
    timer.unref = () => (unref++, original());
    return timer;
  }) as any;
  try {
    later(() => {}, 1);
  } finally {
    globalThis.setTimeout = real;
  }
  assert.equal(unref, 1);
});
