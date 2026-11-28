// Probe fixtures read published probe records without confusing the independent stall or renderer log for a launch sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expectCoreLoaded, launchSamples, probeFiles } from './e2e/fixtures/coreLoaded.ts';

const { createBoundedLog } = createRequire(import.meta.url)('../electron/perf/stalls.cjs');

function profile(t: import('node:test').TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const perf = path.join(dir, 'perf');
  fs.mkdirSync(perf);
  return { dir, perf, probe: path.join(perf, '2026-11-05T12-45-00-000Z-123.jsonl') };
}

test('a startup stall is not a probe sample, even when both files are present', async (t) => {
  const p = profile(t);
  const log = createBoundedLog(path.join(p.perf, 'stalls.jsonl'), { max: 1 });
  await log.append(JSON.stringify({ kind: 'stall', ms: 701 }));
  await log.append(JSON.stringify({ kind: 'stall', ms: 702 }));
  fs.writeFileSync(p.probe, '{"kind":"loop","coreLoaded":true}\n');
  assert.deepEqual(await launchSamples(p.dir), [{ kind: 'loop', coreLoaded: true }]);
});

test('the stall logger’s rotated file is also outside the launch probe stream', async (t) => {
  const p = profile(t);
  fs.writeFileSync(path.join(p.perf, 'stalls.1.jsonl'), '{"kind":"stall","ms":701}\n');
  fs.writeFileSync(p.probe, '{"kind":"loop","coreLoaded":true}\n');
  assert.deepEqual(await launchSamples(p.dir), [{ kind: 'loop', coreLoaded: true }]);
});

test('the renderer record, live or rotated, is not a probe sample either (#5790)', async (t) => {
  // written before the probe's first flush, its lines once stood in for the launch's samples and had no coreLoaded
  const p = profile(t);
  fs.writeFileSync(path.join(p.perf, 'renderer.jsonl'), '{"kind":"longtask","ms":80}\n{"kind":"slowInput","ms":120}\n');
  fs.writeFileSync(path.join(p.perf, 'renderer.1.jsonl'), '{"kind":"longtask","ms":90}\n');
  const pending = launchSamples(p.dir);
  fs.writeFileSync(p.probe, '{"kind":"loop","coreLoaded":true}\n');
  assert.deepEqual(await pending, [{ kind: 'loop', coreLoaded: true }]);
  assert.deepEqual(probeFiles(p.dir), [path.basename(p.probe)]);
});

test('a stall alone does not end the wait for this launch to publish its first probe record', async (t) => {
  const p = profile(t);
  fs.writeFileSync(path.join(p.perf, 'stalls.jsonl'), '{"kind":"stall","ms":701}\n');
  const pending = launchSamples(p.dir);
  const published = new Promise<void>((resolve) =>
    setImmediate(() => {
      fs.writeFileSync(p.probe, '{"kind":"loop","coreLoaded":true}\n');
      resolve();
    }),
  );
  const samples = await pending;
  await published;
  assert.deepEqual(samples, [{ kind: 'loop', coreLoaded: true }]);
});

test('a still-being-appended probe record is not parsed before its newline is published', async (t) => {
  const p = profile(t);
  fs.writeFileSync(p.probe, '{"kind":"loop","coreLoaded":true}\n{"kind":"cpu",');
  assert.deepEqual(await launchSamples(p.dir), [{ kind: 'loop', coreLoaded: true }]);
});

test('a probe record with missing core metadata remains visible to the core assertion', async (t) => {
  const p = profile(t);
  fs.writeFileSync(p.probe, '{"kind":"loop"}\n');
  const samples = await launchSamples(p.dir);
  assert.deepEqual(samples, [{ kind: 'loop' }]);
  assert.throws(() => expectCoreLoaded(samples), /boolean/);
});

test('probe discovery waits for the folder and ignores non-probe artifacts', (t) => {
  const p = profile(t);
  fs.writeFileSync(path.join(p.perf, 'stalls.jsonl'), '{}\n');
  fs.writeFileSync(path.join(p.perf, 'main.cpuprofile'), '{}');
  assert.deepEqual(probeFiles(p.dir), []);
  assert.deepEqual(probeFiles(path.join(p.dir, 'not-created')), []);
});

test('a malformed published probe record fails instead of silently disappearing', async (t) => {
  const p = profile(t);
  fs.writeFileSync(p.probe, '{broken}\n');
  await assert.rejects(launchSamples(p.dir), /JSON/);
});
