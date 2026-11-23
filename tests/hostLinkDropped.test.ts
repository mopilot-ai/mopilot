// A link that dropped inside the 90 s window (Remote Run audit chat:C22): the registry dates the drop by the last answer while the machine still counts as online, and main's list carries it, so the chat says "Reconnecting" in place of nothing or "offline".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { createMachines } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { createRegistry } = require('../electron/host/registry.cjs');

const ready = {
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  capabilities: { iab: false, cu: false, bu: false, shell: true },
};
const dir = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'link-drop-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const world = (t: any, status: (r: any) => Promise<unknown> = async () => ready) => {
  const clock = installFakeClock(t, 1_000_000);
  const registry = createRegistry({ file: path.join(dir(t), 'hosts.json'), status, report: () => undefined });
  t.after(() => registry.dispose());
  return { clock, registry };
};
const box = { id: 'h1', name: 'Build box', address: 'me@build.example' };
const tick = () => new Promise((r) => setImmediate(r));

test('a failed ask while the last answer is still inside the 90 s window is a link that dropped; an answer or the window ending clears it (chat C22)', async (t) => {
  let up = true;
  const w = world(t, async () => {
    if (!up) throw new Error('tunnel down');
    return ready;
  });
  w.registry.add(box);
  w.registry.start();
  await w.registry.check();
  const answered = w.registry.list()[0];
  assert.equal(answered.linkDroppedAt, null, 'a machine that answers has not dropped');
  up = false;
  w.clock.advance(30_000);
  await new Promise((r) => setImmediate(r));
  const [dropped] = w.registry.list();
  assert.equal(dropped.status, 'online', 'still inside the window');
  assert.equal(dropped.linkDroppedAt, answered.lastHeartbeat, 'the drop is dated by the last answer');
  w.clock.advance(60_000);
  await new Promise((r) => setImmediate(r));
  const [gone] = w.registry.list();
  assert.equal(gone.status, 'offline');
  assert.equal(gone.linkDroppedAt, null, 'an offline machine is offline, not reconnecting');
  up = true;
  await w.registry.check();
  assert.equal(w.registry.list()[0].linkDroppedAt, null, 'an answer clears it');
});

test('a machine whose ask went unanswered inside the window carries when its link dropped, and not once it is offline (chat C22)', async (t) => {
  let up = true;
  const w = world(t, async () => {
    if (!up) throw new Error('tunnel down');
    return ready;
  });
  const d = dir(t);
  const machines = createMachines({
    dir: d,
    root: d,
    allowed: () => true,
    watch: () => () => undefined,
    call: async () => ready,
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({ ok: false }) },
    registry: w.registry,
  });
  t.after(() => machines.dispose());
  w.registry.add({ id: 'h1', name: 'build-box', address: 'me@box', socketPath: '/h/host.sock' });
  w.clock.advance(30_000);
  await tick();
  assert.equal('linkDroppedAt' in machines.list().machines[0], false, 'a machine that answers has not dropped');
  up = false;
  w.clock.advance(30_000);
  await tick();
  const [dropped] = machines.list().machines;
  assert.equal(dropped.status, 'online');
  assert.equal(dropped.linkDroppedAt, dropped.lastSeen);
  w.clock.advance(60_000);
  await tick();
  const [gone] = machines.list().machines;
  assert.equal(gone.status, 'offline');
  assert.equal('linkDroppedAt' in gone, false);
});
