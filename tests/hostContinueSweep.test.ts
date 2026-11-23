// The Host reclaims a continue preparation that never became the owner (host/src/continueWiring.mjs): the time limit is only a promise until something sweeps (B5, A5).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createContinueWiring } from '../host/src/continueWiring.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';

// the Host's runtime and files, as far as the continue wiring reads them
const runtimeOf = (ids: string[] = []): any => ({
  host: { ids, chats: new Map(), starting: new Set(), close: async () => undefined },
});
const make = (extra: Record<string, unknown> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sweep-'));
  const problems: string[] = [];
  const report = (p: string) => problems.push(p);
  const wiring = createContinueWiring({
    dataDir: dir,
    runtime: runtimeOf(),
    hostFs: { existingDirectory: async (p: any) => p } as any,
    epochs: createEpochStore(path.join(dir, 'epochs.json'), { report }),
    ledger: createLedger(path.join(dir, 'ledger'), { report }),
    report,
    sweepMs: 1000,
    ttlMs: 5000,
    ...extra,
  });
  return { dir, problems, wiring };
};
const prepared = (wiring: any) =>
  wiring.continueHost.prepare({
    chatId: 'claude:c1',
    epoch: 1,
    key: 'prep-key-0001',
    harness: 'acp:gemini',
    cwd: '/w',
    handoff: 'history',
  });

test('a preparation nobody commits is reclaimed by the Host itself once its time limit passed, and its handoff goes with it', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.after(() => mock.timers.reset());
  const { dir, wiring } = make({
    runtime: { host: { ids: ['gemini'], chats: new Map(), starting: new Set(), close: async () => undefined } },
  });
  t.after(() => wiring.close());
  await prepared(wiring);
  const owners = path.join(dir, 'owners.json');
  assert.equal(JSON.parse(fs.readFileSync(owners, 'utf8'))['claude:c1'].state, 'prepared');
  assert.equal(fs.readdirSync(path.join(dir, 'continue', 'stash')).length, 1);
  mock.timers.tick(4000);
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.parse(fs.readFileSync(owners, 'utf8'))['claude:c1'].state, 'prepared', 'inside the limit it stays');
  mock.timers.tick(3000);
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.parse(fs.readFileSync(owners, 'utf8'))['claude:c1'], undefined);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'continue', 'stash')), []);
});

test('a sweep that fails is reported and the next one runs; close stops the timer', async (t) => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.after(() => mock.timers.reset());
  const { dir, problems, wiring } = make();
  fs.writeFileSync(path.join(dir, 'owners.json'), '{bad');
  mock.timers.tick(1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not swept/);
  wiring.close();
  mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(problems.length, 1, 'closed: no more sweeps');
});
