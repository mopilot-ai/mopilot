// The dev host's `gap` scenario: the Mac's send counter runs n frames ahead of the phone (scripts/mobile-dev-host/gap.mjs), alone with a fake channel and through the real host with a real phone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { toHex } from '../shared/remote/envelope.mjs';
import { advanceTx } from '../scripts/mobile-dev-host/gap.mjs';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';
import { startPhone, until } from './support/mobileStack.ts';

const require = createRequire(import.meta.url);
const crypto = createCrypto(require('../electron/platform/sodiumPrimitives.cjs').createSodiumPrimitives());
const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-gap-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function rig(pairs: string[] = ['p1']) {
  const sessions = new Map<string, any>();
  for (const pairId of pairs) {
    sessions.set(pairId, {
      device: { id: `d-${pairId}`, pairId },
      tx: crypto.createSender({ pair: pairId, dir: 'm2p', chain: new Uint8Array(32).fill(7), ctr: 10 }),
      savedTx: 10,
      sealed: { ctr: 10 },
      sending: Promise.resolve(),
    });
  }
  const updates: any[][] = [];
  const o = { fail: false };
  const devices = {
    update: async (...args: any[]) => {
      if (o.fail) throw new Error('disk full');
      updates.push(args);
    },
  };
  return { channel: { sessions, crypto }, devices, sessions, updates, o };
}

test('the counter moves exactly n on, is saved, and the next seal uses the counter after it', async () => {
  const r = rig();
  const s = r.sessions.get('p1');
  const expected = s.tx.peek(5000);
  assert.equal(
    await advanceTx({ channel: r.channel, devices: r.devices, n: 5000 }),
    "gap: advanced the Mac's counter for p1 by 5000 to 5010",
  );
  assert.equal(s.tx.state().ctr, 5010);
  assert.deepEqual(s.tx.state().chain, expected.chain);
  assert.equal(s.savedTx, 5010);
  assert.equal(s.sealed, null);
  assert.deepEqual(r.updates, [['d-p1', { tx: { ctr: 5010, chain: toHex(expected.chain) } }, 'p1']]);
  assert.equal(s.tx.seal(new Uint8Array([1])).ctr, 5011);
});

test('every paired phone moves, or only the one named; a pair that is not there is refused', async () => {
  const r = rig(['p1', 'p2']);
  const both = await advanceTx({ channel: r.channel, devices: r.devices, n: 3 });
  assert.equal(both, "gap: advanced the Mac's counter for p1 by 3 to 13; gap: advanced the Mac's counter for p2 by 3 to 13");
  await advanceTx({ channel: r.channel, devices: r.devices, n: 2, pairId: 'p2' });
  assert.deepEqual([r.sessions.get('p1').tx.state().ctr, r.sessions.get('p2').tx.state().ctr], [13, 15]);
  await assert.rejects(advanceTx({ channel: r.channel, devices: r.devices, n: 2, pairId: 'p9' }), /No paired phone has the pair id p9/);
});

test('with no phone paired, or Mobile Remote off, it is refused and nothing is saved', async () => {
  const r = rig([]);
  await assert.rejects(advanceTx({ channel: r.channel, devices: r.devices, n: 5 }), /No phone is paired/);
  await assert.rejects(advanceTx({ channel: null, devices: r.devices, n: 5 }), /Mobile Remote is not running/);
  await assert.rejects(advanceTx({ channel: r.channel, devices: null, n: 5 }), /Mobile Remote is not running/);
  assert.deepEqual(r.updates, []);
});

test('a seal in flight, and one queued behind it, finish before the counter is swapped', async () => {
  const r = rig();
  const s = r.sessions.get('p1');
  const order: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((resolve) => (release = resolve)).then(() => void order.push('first seal'));
  s.sending = first;
  const done = advanceTx({ channel: r.channel, devices: r.devices, n: 4 }).then(() => void order.push('advanced'));
  // another send queues behind the first one while the scenario waits
  s.sending = first.then(() => void order.push('queued seal'));
  release();
  await done;
  assert.deepEqual(order, ['first seal', 'queued seal', 'advanced']);
  assert.equal(s.tx.state().ctr, 14);
});

test('a failed save is reported and leaves the next seal to save the counter again', async () => {
  const r = rig();
  r.o.fail = true;
  await assert.rejects(advanceTx({ channel: r.channel, devices: r.devices, n: 5 }), /disk full/);
  assert.equal(r.sessions.get('p1').savedTx, 10, 'the old saved counter: the next seal checkpoints again');
});

test('run gap through the real host moves the Mac’s counter, and a phone that was connected catches up on the next frame', async () => {
  const host: any = await startHost({
    dir: scratch,
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
  });
  after(() => host.stop());
  await assert.rejects(async () => host.scenarios.run('gap', []), /No phone is paired/);
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  assert.equal((await phone.ask('machine.hello')).app, 'dev-host');
  const session = host.remote.channel.sessions.get(pairId);
  const before = session.tx.state().ctr;
  const said = await host.scenarios.run('gap', ['5000']);
  assert.match(said, new RegExp(`gap: advanced the Mac's counter for ${pairId} by 5000 to ${before + 5000}`));
  assert.equal(session.tx.state().ctr, before + 5000);
  assert.equal(host.remote.devices.list()[0].tx.ctr, before + 5000);
  // the next reply is 5000 frames on: the phone walks the chain, reads it, and reconnects to read everything again (the request in flight ends with the connection)
  await assert.rejects(phone.ask('machine.hello'), /Connection closed/);
  assert.ok(session.tx.state().ctr > before + 5000);
  let again: any;
  await until(async () => (again = await phone.ask('machine.hello').catch(() => null)), 'the phone to be reading the Mac again');
  assert.equal(again.app, 'dev-host');
});
