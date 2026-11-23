// MoMo inner send ids survive changed transport envelopes and share the remote send ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { momoRig, ok, HARNESSES } from './support/remote-momo-kit.ts';
import { fs, tempDir } from './support/remoteKit.ts';
import { waitFor } from './support/waitFor.ts';
import { setup, selectSegment } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { SendLedger } = require('../electron/remote/sendLedger.cjs');
const { ledgerOf, payloadOf, sendKey } = require('../electron/remote/sendIdentity.cjs');
const { parseParams } = require('../shared/remote/schema.mjs');
const call = (m: ReturnType<typeof momoRig>, method: string, params: any = {}, pair = 'p1') =>
  m.r.service.call(m.r.service.phones.get(pair).client, method, params);
const disk = (m: ReturnType<typeof momoRig>, file: string, storage = fs) => {
  const ledger = new SendLedger({ file, fs: storage });
  (m.r.link.mac as any).sendLedger = ledger;
  return ledger;
};

for (const harness of HARNESSES) {
  test(`${harness}: retrying MoMo with a new envelope returns the first receipt without sending again`, async () => {
    const m = momoRig({ harness });
    const phone = m.r.phone('p1');
    const params = { id: 'stable-inner', text: 'hello', expectedChatId: 'momo-main' };
    const first = ok(await phone.ask('momo.chat.send', params, 'envelope-1'));
    assert.deepEqual(ok(await phone.ask('momo.chat.send', params, 'envelope-2')), first);
    assert.equal(m.sent.length, 1);
  });
  test(`${harness}: the real controller admits one turn across duplicate requests, even after the harness changes`, async () => {
    const m = momoRig({ harness });
    const w = setup();
    selectSegment(w.c, w.chats, 'momo-main', [[harness, 'native-session']]);
    m.controller.send = w.c.send.bind(w.c);
    await call(m, 'momo.chat.send', { id: 'inner', text: 'hello', expectedChatId: 'momo-main' });
    selectSegment(w.c, w.chats, 'momo-main', [[harness === 'codex' ? 'claude' : 'codex', 'replacement-native']]);
    await call(m, 'momo.chat.send', { id: 'inner', text: 'hello', expectedChatId: 'momo-main' });
    assert.equal(w.execs.length, 1);
    assert.equal(w.state.get('momo-main').queue.length, 0);
  });
}

test('same canonical payload coalesces concurrently, survives restart and preserves the original warning', async () => {
  const m = momoRig();
  const file = path.join(tempDir(), 'sends.json');
  disk(m, file);
  let release!: () => void;
  let sends = 0;
  m.controller.send = async () => {
    sends++;
    await new Promise<void>((r) => {
      release = r;
    });
    return { id: 'inner', action: 'queued', error: 'Waiting for the harness.' } as any;
  };
  const first = call(m, 'momo.chat.send', { id: 'inner', text: ' hello ', expectedChatId: 'momo-main' });
  await waitFor(() => sends === 1, 'controller admission');
  const again = call(m, 'momo.chat.send', { followUp: 'queue', text: 'hello', id: 'inner', expectedChatId: 'momo-main' });
  release();
  const expected = { sent: true, warning: 'Waiting for the harness.' };
  assert.deepEqual(await Promise.all([first, again]), [expected, expected]);
  assert.equal(sends, 1);
  const restarted = momoRig();
  disk(restarted, file);
  assert.deepEqual(await call(restarted, 'momo.chat.send', { id: 'inner', text: 'hello', followUp: 'queue' }), expected);
  assert.equal(restarted.sent.length, 0);
  for (const change of [{ text: 'other' }, { text: 'hello', followUp: 'steer' }])
    await assert.rejects(call(restarted, 'momo.chat.send', { id: 'inner', ...change }), { code: 'send_conflict' });
});

test('MoMo ids are scoped to pair, method and exact main chat; ordinary ids never return a MoMo receipt', async () => {
  const m = momoRig();
  await call(m, 'momo.chat.send', { id: 'same-0001', text: 'one' });
  await call(m, 'momo.chat.send', { id: 'same-0001', text: 'two' }, 'p2');
  assert.equal(m.sent.length, 2);
  await assert.rejects(call(m, 'momo.chat.send', { id: 'same-0001', text: 'two' }), { code: 'send_conflict' });
  await call(m, 'chat.send', { chatId: 'c1', sendId: 'same-0001', text: 'ordinary' });
  assert.equal(m.r.calls.filter((c) => c[0] === 'send').length, 1);
  assert.notEqual(
    sendKey({ kind: 'phone', pairId: 'p:a' }, 'momo.chat.send', 'b', 'c'),
    sendKey({ kind: 'phone', pairId: 'p' }, 'momo.chat.send', 'a:b', 'c'),
  );
  assert.notEqual(
    sendKey({ kind: 'phone', pairId: 'p1' }, 'chat.send', 'c1', 'same-0001'),
    sendKey({ kind: 'phone', pairId: 'p1' }, 'momo.chat.send', 'c1', 'same-0001'),
  );
  assert.equal(payloadOf({ z: [{ b: 1, a: 2 }], a: 1 }), payloadOf({ a: 1, z: [{ a: 2, b: 1 }] }));
  assert.notEqual(payloadOf({ a: [1, 2] }), payloadOf({ a: [2, 1] }));
});

test('expected main id validates as an equality guard; manual legacy sends still work', async () => {
  for (const expectedChatId of ['', ' ', null, 3, [], {}, 'x'.repeat(257)])
    assert.throws(() => parseParams('momo.chat.send', { id: 'i', text: 'hi', expectedChatId }), { code: 'invalid' });
  const m = momoRig();
  await assert.rejects(call(m, 'momo.chat.send', { id: 'i', text: 'hi', expectedChatId: 'another-chat' }), { code: 'stale' });
  assert.equal(m.sent.length, 0);
  assert.deepEqual(await call(m, 'momo.chat.send', { id: 'i', text: 'hi' }), { sent: true });
});

for (const invalidator of ['pair', 'permission', 'reset', 'replacement', 'stop']) {
  test(`a ${invalidator} during the reservation wait prevents controller admission and permits a proven-safe retry`, async () => {
    const m = momoRig();
    let writing = false;
    let release!: () => void;
    const paused = {
      ...fs,
      rename: async (...args: any[]) => {
        if (!writing) {
          writing = true;
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return (fs.rename as any)(...args);
      },
    };
    disk(m, path.join(tempDir(), 'sends.json'), paused);
    let stopped = false;
    m.r.ops.sendCheck = () => () => {
      if (stopped) throw new Error('stopped');
    };
    const params = { id: 'i', text: 'hi', expectedChatId: 'momo-main' };
    const pending = call(m, 'momo.chat.send', params);
    const rejected = assert.rejects(
      pending,
      invalidator === 'stop'
        ? /stopped/
        : invalidator === 'pair' || invalidator === 'permission'
          ? { code: 'forbidden' }
          : { code: 'stale' },
    );
    await waitFor(() => writing, 'reservation write');
    if (invalidator === 'pair') m.r.link.removePair('p1');
    if (invalidator === 'permission') {
      m.gate.allowed = false;
      m.r.service.momoAllowed = () => false;
    }
    if (invalidator === 'reset') m.main.exists = false;
    if (invalidator === 'replacement') m.mainChat.mainChatId = (() => 'replacement') as any;
    if (invalidator === 'stop') stopped = true;
    release();
    await rejected;
    assert.equal(m.sent.length, 0);
    m.gate.allowed = true;
    m.r.service.momoAllowed = () => true;
    m.main.exists = true;
    m.mainChat.mainChatId = () => 'momo-main';
    stopped = false;
    if (invalidator === 'pair') m.r.link.addPair('p1');
    assert.deepEqual(await call(m, 'momo.chat.send', params), { sent: true });
    assert.equal(m.sent.length, 1);
  });
}

test('hello capability requires disk readiness, disappears on failed probes and recovers; reservation still rechecks storage', async () => {
  const m = momoRig();
  assert.equal((await call(m, 'machine.hello')).capabilities.momoSendDedup, undefined);
  let broken = false;
  const storage = {
    ...fs,
    rename: async (...args: any[]) => {
      if (broken) throw new Error('disk unavailable');
      return (fs.rename as any)(...args);
    },
  };
  const ledger = disk(m, path.join(tempDir(), 'sends.json'), storage);
  assert.equal((await call(m, 'machine.hello')).capabilities.momoSendDedup, 1);
  broken = true;
  await assert.rejects(call(m, 'momo.chat.send', { id: 'i', text: 'hi' }), { code: 'send_unavailable' });
  assert.equal(m.sent.length, 0);
  assert.equal((await call(m, 'machine.hello')).capabilities.momoSendDedup, undefined);
  broken = false;
  assert.equal((await call(m, 'machine.hello')).capabilities.momoSendDedup, 1);
  assert.equal(ledgerOf(m.r.service), ledger);
  m.r.service.momoAllowed = () => false;
  assert.equal((await call(m, 'machine.hello')).capabilities.momoSendDedup, undefined);
});
