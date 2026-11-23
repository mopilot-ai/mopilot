// Tests worker-thread outcomes and the actual bounded gh boundary without contacting GitHub or launching the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createRepairGithub, REQUEST_MS } = require('../electron/platform/mainRepairGithub.cjs');
const { executeRepair } = require('../electron/platform/mainRepairGithubWorker.cjs');
test('worker replies, worker failures, startup refusal, exit and timeout never guess an ambiguous write succeeded', async (t) => {
  const clock = useFakeClock(t),
    workers: any[] = [];
  const factory = (_file: string, options: any) => {
    const w: any = new EventEmitter();
    w.unref = () => undefined;
    w.terminate = () => undefined;
    w.options = options;
    workers.push(w);
    return w;
  };
  const client = createRepairGithub({ makeWorker: factory, environment: () => ({ PATH: '/fixture' }) });
  const ok = client.request('read', { repo: 'o/r', issue: 5 });
  workers[0].emit('message', { ok: true, result: { state: 'unclaimed' } });
  assert.deepEqual(await ok, { state: 'unclaimed' });
  workers[0].emit('exit');
  assert.equal(workers[0].options.workerData.op, 'read');
  const refused = client.request('bind', { repo: 'o/r' });
  workers[1].emit('message', { ok: false, error: 'request refused' });
  await assert.rejects(refused, /request refused/);
  const error = client.request('reserve', { repo: 'o/r' });
  workers[2].emit('error', new Error('lost worker'));
  await assert.rejects(error, /lost worker/);
  const exit = client.request('reserve', { repo: 'o/r' });
  workers[3].emit('exit');
  await assert.rejects(exit, /unknown/);
  const timeout = client.request('reserve', { repo: 'o/r' });
  clock.advance(REQUEST_MS);
  await assert.rejects(timeout, /timed out/);
  const pending = client.request('read', { repo: 'o/r' });
  client.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(client.request('read', {}), /closed/);
  client.close();
  const broken = createRepairGithub({
    makeWorker: () => {
      throw new Error('cannot start');
    },
  });
  await assert.rejects(broken.request('read', {}), /cannot start/);
  broken.close();
});
test('named operations call gh without a shell and invalid operations cannot reach a command', () => {
  const calls: any[] = [];
  const result = executeRepair({ op: 'read', payload: { repo: 'o/r', issue: 5 }, environment: { PATH: '/fixture' } }, (...args: any[]) => {
    calls.push(args);
    throw Object.assign(new Error('HTTP 404'), { stderr: 'HTTP 404' });
  });
  assert.deepEqual(result, { state: 'unclaimed' });
  assert.equal(calls[0][0], 'gh');
  assert.equal(calls[0][2].timeout, 30_000);
  assert.equal(calls[0][2].encoding, 'utf8');
  assert.equal(calls[0][2].shell, undefined);
  assert.throws(() => executeRepair({ op: '__proto__', payload: { repo: 'o/r' }, environment: {} }), /Invalid main repair/);
  assert.throws(() => executeRepair({ op: 'read', payload: { repo: '../bad' }, environment: {} }), /Invalid main repair/);
});
test('the real worker publishes success and readable failure using an isolated fake gh executable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-gh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh: Not Found (HTTP 404)" >&2\nexit 1\n', { mode: 0o700 });
  const client = createRepairGithub({ environment: () => ({ ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }) });
  t.after(() => client.close());
  assert.deepEqual(await client.request('read', { repo: 'o/r', issue: 5 }), { state: 'unclaimed' });
  await assert.rejects(client.request('invalid', { repo: 'o/r' }), /Invalid main repair/);
});
