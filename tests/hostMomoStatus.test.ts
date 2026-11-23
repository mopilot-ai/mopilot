// MoMo's home on a Host, the wire (M1 slice S, shared/host/methods/momo.mjs, host/src/methods/momo.mjs): the `momo` feature both ends declare, the methods gated on it, and the veil: to a client that is not paired, or while no grant is live, every host.momo* is a request no Host knows and the hello does not name the feature. Through the real server: tests/hostMomoHome.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from '../shared/host/schema.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createGuard } from '../host/src/guard.mjs';

test('the momo feature is declared and the host.momo* methods are open to the server’s pairing gate and need it as they say', () => {
  assert.ok(S.FEATURES.includes('momo'));
  assert.deepEqual(S.REQUIRES['host.momoStatus'], ['momo']);
  assert.deepEqual(S.REQUIRES['host.momoHomeStart'], ['momo']);
  assert.equal(S.REQUIRES['host.momoGrant'], undefined, 'the grant comes before the feature is in the hello');
  assert.deepEqual(S.parseParams('host.momoStatus', { extra: 1 }), {});
  assert.ok(
    !S.FOLDER_PAIRED_ONLY.some((m: string) => m.startsWith('host.momo')),
    'the veil, not the pairing gate, answers an unpaired client',
  );
});

test('a veiled method is unknown to an unpaired client and without a grant, shown with one, and a hello names the feature only while a grant is live', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-wire-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }) };
  const home = { granted: () => live, status: () => ({ version: 1, home: null }) };
  let live = false;
  const open = async (extra: object, principal: unknown, hello: any = S.helloParams()) => {
    const conn = createProtocol({ runtime, epochs, guard, status: () => ({}), ...extra }).connection(
      () => undefined,
      () => null,
      { principal: () => principal as any },
    );
    const reply = await conn.call('host.hello', hello);
    return { conn, reply };
  };
  const said = (p: Promise<unknown>) =>
    p.then(
      () => 'answered',
      (e: any) => `${e.code}:${e.message}`,
    );
  const unknown = await said((await open({}, {})).conn.call('host.zzz', {}));
  assert.equal(unknown, 'invalid:Unknown request: host.zzz');
  const as = (method: string) => unknown.replace('host.zzz', method);
  // no home service at all, an unpaired client, a paired one without a grant: each gets the unknown answer, and the hello has no `momo` in it
  for (const [extra, principal] of [
    [{}, {}],
    [{ momo: home }, null],
    [{ momo: home }, {}],
  ] as const) {
    const { conn, reply } = await open(extra, principal);
    assert.equal(await said(conn.call('host.momoStatus', {})), as('host.momoStatus'));
    assert.doesNotMatch(JSON.stringify(reply), /momo/i);
  }
  live = true;
  const { conn, reply } = await open({ momo: home }, {});
  assert.ok(reply.features.includes('momo') && reply.agreed.features.includes('momo'));
  assert.deepEqual(await conn.call('host.momoStatus', {}), { version: 1, home: null });
  // a hello from an end that predates the feature: the granted client is told it lacks it, not that nothing exists
  const old = await open({ momo: home }, {}, { ...S.helloParams(), features: S.FEATURES.filter((f: string) => f !== 'momo') });
  await assert.rejects(old.conn.call('host.momoStatus', {}), (e: any) => e.code === 'feature_missing');
  // an unpaired client still sees nothing while the grant is live
  const stranger = await open({ momo: home }, null);
  assert.doesNotMatch(JSON.stringify(stranger.reply), /momo/i);
  assert.equal(await said(stranger.conn.call('host.momoStatus', {})), as('host.momoStatus'));
});

test('a hello that names chats the app moved away is answered with what the Host did about them, beside the features it shows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-hello-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }) };
  const continueHost = { acceptHello: async (moved: unknown[]) => ({ poisoned: moved.length }) };
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({}), continueHost } as any).connection(() => undefined);
  const moved = [{ chatId: 'claude:c1', epoch: 1, rev: 0, targetHostId: 'B' }];
  const reply = await conn.call('host.hello', { ...S.helloParams(), moved });
  assert.deepEqual(reply.continued, { poisoned: 1 });
  assert.doesNotMatch(JSON.stringify(reply), /momo/i);
});
