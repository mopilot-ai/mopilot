// A machine whose Host still reads an agent as "checking" or "unsure" is asked again soon, backing off, until it answers with neither (#5177).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createRegistry, setupReason } = require('../electron/host/registry.cjs');

const caps = { iab: false, cu: false, bu: false, shell: true };
const box = { id: 'h1', name: 'Build box', address: 'me@build.example' };
const tick = () => new Promise((r) => setImmediate(r));

function world(t: any, answers: Record<string, unknown>[]) {
  const clock = installFakeClock(t, 1_000_000);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-recheck-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  let asked = 0;
  const registry = createRegistry({
    file: path.join(d, 'hosts.json'),
    status: async () => ({ capabilities: caps, harnesses: [answers[Math.min(asked++, answers.length - 1)]] }),
    report: () => undefined,
  });
  t.after(() => registry.dispose());
  registry.add(box);
  return { clock, registry, asked: () => asked };
}

test('a machine that answers "checking" is asked again after 5 s, then 10 s, and stops once it answers with neither', async (t) => {
  const w = world(t, [
    { id: 'codex', detected: true, signedIn: false, checking: true },
    { id: 'codex', detected: true, signedIn: false, checking: true },
    { id: 'codex', detected: true, signedIn: false, unsure: true },
    { id: 'codex', detected: true, signedIn: true },
  ]);
  await w.registry.check();
  assert.equal(w.asked(), 1);
  w.clock.advance(4999);
  await tick();
  assert.equal(w.asked(), 1, 'not before 5 s');
  w.clock.advance(1);
  await tick();
  await tick();
  assert.equal(w.asked(), 2);
  w.clock.advance(9999);
  await tick();
  assert.equal(w.asked(), 2, 'the second wait is 10 s');
  w.clock.advance(1);
  await tick();
  await tick();
  assert.equal(w.asked(), 3, 'an unsure agent is asked again too');
  w.clock.advance(20_000);
  await tick();
  await tick();
  assert.equal(w.asked(), 4);
  w.clock.advance(120_000 - 30_000);
  await tick();
  assert.equal(w.asked(), 4, 'a settled answer ends the retries (the 30 s heartbeat is not started here)');
});

test('stopping the heartbeat or disposing the registry drops a pending retry', async (t) => {
  const w = world(t, [{ id: 'codex', detected: true, signedIn: false, checking: true }]);
  await w.registry.check();
  w.registry.stop();
  w.clock.advance(60_000);
  await tick();
  assert.equal(w.asked(), 1, 'no retry after stop');
  await w.registry.check();
  w.registry.dispose();
  w.clock.advance(60_000);
  await tick();
  assert.equal(w.asked(), 2, 'no retry after dispose');
});

test('the retries ask only the machine that is checking, and stop after a few tries; a removed machine is never asked again', async (t) => {
  const clock = installFakeClock(t, 1_000_000);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-recheck-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const asked: string[] = [];
  const registry = createRegistry({
    file: path.join(d, 'hosts.json'),
    status: async (r: any) => (
      asked.push(r.id),
      {
        capabilities: caps,
        harnesses: [{ id: 'codex', detected: true, signedIn: false, ...(r.id === 'busy' ? { checking: true } : { signedIn: true }) }],
      }
    ),
    report: () => undefined,
  });
  t.after(() => registry.dispose());
  registry.add({ ...box, id: 'busy' });
  registry.add({ ...box, id: 'fine', address: 'me@other.example' });
  await registry.check();
  asked.length = 0;
  for (let i = 0; i < 12; i++) {
    clock.advance(30_000);
    await tick();
    await tick();
  }
  assert.deepEqual([...new Set(asked)], ['busy'], 'the settled machine is not asked on the retry path');
  assert.equal(asked.length, 8, 'eight retries after the first ask, then the heartbeat alone');
  registry.add({ ...box, id: 'gone', address: 'me@gone.example' });
  await registry.check();
  registry.remove('busy');
  asked.length = 0;
  clock.advance(60_000);
  await tick();
  assert.equal(asked.includes('busy'), false);
});

test('a machine whose only installed agent is still being checked, or could not be checked, is not one that needs a sign-in (#5177)', () => {
  const only = (h: object) => ({ capabilities: caps, harnesses: [{ id: 'codex', detected: true, signedIn: false, ...h }] });
  assert.equal(setupReason(only({ checking: true })), '');
  assert.equal(setupReason(only({ unsure: true })), '');
  assert.match(setupReason(only({})), /not signed in/);
});
