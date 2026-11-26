// A machine whose Host refuses this app's proof on the live connection is not online (#5744, electron/host/proofWatch.cjs): main's list makes its row attention with the cause and its fix, asks the proof again on a timer, and puts the row back online once a proof is accepted, telling the windows each time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createMachines } from './support/hostKeySafe.ts';
import { hostWorld, tick } from './support/host-wire-kit.ts';
const require = createRequire(import.meta.url);
const { createRegistry } = require('../electron/host/registry.cjs');
const { createConnectionWatch, proofLine, PROOF_RETRY_MS } = require('../electron/host/proofWatch.cjs');

const ready = { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };

/** Main's service over one machine, Studio, whose Host answers the proof with `answer()` (a code to refuse with, or null to accept). */
async function studio(t: any, answer: () => string | null) {
  const w = hostWorld(t);
  const tun = w.tunnel();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-row-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const seed = createRegistry({ file: path.join(d, 'host-registry.json'), report: () => undefined });
  seed.add({ id: 'h1', name: 'Studio', address: 'me@studio', socketPath: '/run/host.sock' });
  seed.dispose();
  const auths: number[] = [];
  w.net.handlers['host.challenge'] = () => ({ nonce: 'n'.repeat(32), hostId: 'a'.repeat(32) });
  w.net.handlers['host.auth'] = () => {
    auths.push(w.clock.now());
    const code = answer();
    if (code) throw Object.assign(new Error('refused'), { code });
    return { fingerprint: 'f', name: 'app', kind: 'desktop' };
  };
  const changes: any[] = [];
  const machines = createMachines({
    dir: d,
    root: d,
    allowed: () => true,
    watch: () => () => undefined,
    call: async () => ready,
    onChange: (s: any) => changes.push(s),
    onStep: () => undefined,
    installer: { install: async () => ({ ok: false }) },
    pool: { get: () => tun, closeAll: () => undefined },
    connect: w.net.connect,
  });
  t.after(() => machines.dispose());
  await machines.check?.();
  const row = () => machines.list().machines[0];
  return { w, machines, changes, auths, row };
}

test('#5744: Allow connections off on the machine makes its row attention, saying where to turn it on; on again and the next proof puts it back online, the windows told each time', async (t) => {
  let code: string | null = 'connections_off';
  const s = await studio(t, () => code);
  assert.equal(s.row().status, 'online', 'the heartbeat answers: online before any connection');
  const host = s.machines.hostFor('h1');
  await host.connect();
  await tick();
  const refused = s.row();
  assert.equal(refused.status, 'attention');
  assert.equal(refused.note, 'Connections from other Macs are off on Studio. Turn on Allow connections in its Settings › Connections.');
  assert.equal(s.changes.at(-1).machines[0].status, 'attention', 'the windows were told');
  // still off: the timer asks again and the row stays (the heartbeat's own changes say attention too)
  const told = s.changes.length;
  s.w.clock.advance(PROOF_RETRY_MS);
  await tick();
  await tick();
  assert.equal(s.auths.length, 2, 'the proof was asked again on the timer');
  assert.equal(s.row().status, 'attention');
  assert.deepEqual(
    s.changes.slice(told).map((c) => c.machines[0].status),
    s.changes.slice(told).map(() => 'attention'),
  );
  // turned on: the next ask is accepted and the row is online again
  code = null;
  s.w.clock.advance(PROOF_RETRY_MS);
  await tick();
  await tick();
  assert.equal(s.auths.length, 3);
  assert.equal(s.row().status, 'online');
  assert.match(s.row().note, /Claude Code/);
  assert.equal(s.changes.at(-1).machines[0].status, 'online', 'the windows were told it is back');
  // accepted: no more asking
  s.w.clock.advance(PROOF_RETRY_MS * 3);
  await tick();
  assert.equal(s.auths.length, 3);
});

test('#5744: a pairing removed on the machine says so on the row; a machine whose connection ends goes back to what its heartbeat says', async (t) => {
  const s = await studio(t, () => 'unknown_client');
  await s.machines.hostFor('h1').connect();
  await tick();
  assert.equal(s.row().status, 'attention');
  assert.equal(s.row().note, 'Studio doesn’t know this Mac any more. Pair with it again in Settings › My machines.');
  s.machines.dispose();
  assert.equal(s.auths.length, 1);
  s.w.clock.advance(PROOF_RETRY_MS * 2);
  await tick();
  assert.equal(s.auths.length, 1, 'an ended connection is not asked again');
});

test('#5744 sweep: a one-off session (a chat list, an update) refused at its proof makes the row attention too; one accepted puts it back; a session that fails otherwise says nothing of the proof', async (t) => {
  let code: string | null = 'connections_off';
  const s = await studio(t, () => code);
  await assert.rejects(s.machines.session('h1'), (e: any) => e.code === 'connections_off');
  assert.equal(s.row().status, 'attention');
  assert.match(s.row().note, /^Connections from other Macs are off on Studio\./);
  code = null;
  const session = await s.machines.session('h1');
  session.close();
  assert.equal(s.row().status, 'online');
  code = 'host_busy';
  await assert.rejects(s.machines.session('h1'), (e: any) => e.code === 'host_busy');
  assert.equal(s.row().status, 'online', 'a failure that is not a proof refusal leaves the row');
});

/** A connection that says its state and its proof answers by hand. */
function fakeHost() {
  const fns = new Set<(e: any) => void>();
  let asked = 0;
  return {
    state: () => 'online',
    onState: () => () => undefined,
    onRefused: (fn: (e: any) => void) => (fns.add(fn), () => void fns.delete(fn)),
    status: async () => {
      asked++;
      throw new Error('still refused');
    },
    answer: (code: string | null) => [...fns].forEach((fn) => fn(code ? { code } : null)),
    asked: () => asked,
    listeners: () => fns.size,
  };
}

test('#5744: the row words name the machine for each refusal; an offline machine stays offline; another machine is untouched; ending the watch stops the timer', async (t) => {
  const w = hostWorld(t);
  let told = 0;
  const watch = createConnectionWatch({ onChange: () => told++ });
  const host = fakeHost();
  const off = watch.watch('h1', host);
  const rows = (status: string) => [
    { id: 'h1', name: 'Studio', status, note: 'Via relay' },
    { id: 'h2', name: 'Box', status: 'online', note: 'Via SSH' },
  ];
  assert.deepEqual(watch.rows(rows('online')), rows('online'), 'nothing heard yet: rows as they are');
  host.answer('key_unreadable');
  assert.equal(told, 1);
  assert.deepEqual(watch.rows(rows('online')), [
    { id: 'h1', name: 'Studio', status: 'attention', note: 'This Mac can’t read its key for Studio. Unlock the keychain.' },
    rows('online')[1],
  ]);
  assert.deepEqual(watch.rows(rows('offline')), rows('offline'), 'an offline machine is offline, whatever its last proof answer');
  host.answer('bad_proof');
  assert.equal(told, 2, 'a different refusal is told');
  assert.equal(
    watch.rows(rows('needs-setup'))[0].note,
    'Studio didn’t accept this Mac’s key. Pair with it again in Settings › My machines.',
  );
  assert.equal(
    proofLine('connections_off', 'Box'),
    'Connections from other Macs are off on Box. Turn on Allow connections in its Settings › Connections.',
  );
  w.clock.advance(PROOF_RETRY_MS);
  await tick();
  assert.equal(host.asked(), 1, 'a refused proof is asked again, and a failed ask is not thrown');
  off();
  assert.equal(host.listeners(), 0);
  w.clock.advance(PROOF_RETRY_MS * 2);
  await tick();
  assert.equal(host.asked(), 1, 'ending the watch stops the timer');
  assert.deepEqual(watch.rows(rows('online')), rows('online'));
  assert.equal(watch.droppedAt('h1'), undefined);
  // a one-off session's answers write the same slot: refused, then accepted, then a failure that is not the proof
  const [opened, failed] = watch.session('h2', (x: string) => `${x}!`);
  assert.throws(() => failed(Object.assign(new Error('off'), { code: 'unknown_client' })), /off/);
  assert.equal(watch.rows(rows('online'))[1].status, 'attention');
  assert.throws(() => failed(new Error('socket closed')), /socket closed/);
  assert.throws(
    () => failed(undefined),
    (e: unknown) => e === undefined,
  );
  assert.equal(watch.rows(rows('online'))[1].status, 'attention', 'a failure that is not a proof answer changes nothing');
  assert.equal(opened('s'), 's!');
  assert.deepEqual(watch.rows(rows('online')), rows('online'));
});
