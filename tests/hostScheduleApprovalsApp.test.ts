// The app's side of a scheduled run that stopped at a card (U3, electron/app/hostSchedulesWiring.cjs): the run is recorded as needing approval in the task's history, also for a time the app adopts for the first time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wireHostSchedules } = require('../electron/app/hostSchedulesWiring.cjs');

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-host-sched-approval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const task = {
  id: 'nightly',
  name: 'Nightly',
  prompt: 'run the tests',
  rrule: 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0',
  status: 'ACTIVE',
  harness: 'claude',
  host_id: 'box',
  cwds: ['/srv/app'],
  schedule_from: 100,
};
const ROW = { harnesses: [{ id: 'claude', detected: true, signedIn: true }] };
const fakeHost = (runs: any[]) => ({
  state: () => 'online',
  scheduleSync: async (p: any) => ({ held: p.tasks.length }),
  scheduleRuns: async ({ after }: { after: number }) => {
    const out = runs.filter((r) => r.seq > after);
    return { runs: out, next: out.at(-1)?.seq ?? after, store: 's1' };
  },
});

test('a run that stopped at a card is recorded as needing approval in the task history, and a Host that never told the start is still adopted (U3)', async (t) => {
  const dir = tmp(t);
  const runs = [
    { seq: 1, taskId: 'nightly', scheduledFor: 1000, status: 'started', harness: 'claude', cwd: '/srv/app', chatId: 'acp:host-claude:u1' },
    {
      seq: 2,
      taskId: 'nightly',
      scheduledFor: 1000,
      status: 'needs-approval',
      harness: 'claude',
      cwd: '/srv/app',
      chatId: 'acp:host-claude:u1',
    },
    { seq: 3, taskId: 'other', scheduledFor: 2000, status: 'needs-approval', harness: 'claude', cwd: '/srv/app' },
  ];
  const host = fakeHost(runs);
  let rows: any = null;
  const live = {
    machineChats: {
      hostFor: () => host,
      rowOf: () => ROW,
      adopt: async () => undefined,
      onRows: (fn: () => void) => ((rows = fn), () => (rows = null)),
    },
  };
  const claims = new Map<string, any>();
  const updates: any[] = [];
  const changes: any[] = [];
  const ledger = {
    latest: async () => 0,
    claim: async (id: string, due: number, fields: any) => {
      const k = `${id}@${due}`;
      if (claims.has(k)) return null;
      claims.set(k, fields);
      return fields;
    },
    update: async (id: string, due: number, patch: any) => void updates.push([id, due, patch]),
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const wired = wireHostSchedules({
    live,
    store: { list: async () => ({ tasks: [task] }) },
    ledger,
    dir,
    announce: () => undefined,
    notify: () => undefined,
    changed: (e: any) => changes.push(e),
  });
  const stop = wired.start();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(updates, [['nightly', 1000, { status: 'needs-approval', reason: 'approval' }]]);
  assert.equal(claims.get('other@2000').status, 'needs-approval');
  assert.ok(changes.length >= 2);
  stop();
});
