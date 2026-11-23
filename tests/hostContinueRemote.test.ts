// The remote proxy's part of a continue (electron/host/remote.cjs): the hello names the chats the app moved away, the Host's answer about them reaches the app, a request refused up front says it never left, and a refusal keeps its details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostWorld, onlineRemote, tick } from './support/host-wire-kit.ts';

const helloReply =
  (extra: object = {}) =>
  () => ({ protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'], ...extra });

test('the hello carries what the app moved away; the answer about it reaches the app', async (t) => {
  const w = hostWorld(t);
  const asked: any[] = [];
  const told: unknown[] = [];
  w.net.handlers['host.hello'] = (p) => (
    asked.push(p), helloReply({ continued: { poisoned: [{ chatId: 'a', epoch: 1 }], conflicts: [], agreed: [] } })()
  );
  await onlineRemote(w, {}, { movedOf: () => [{ chatId: 'a', epoch: 1, targetHostId: 'b' }], onHello: (r: unknown) => told.push(r) });
  assert.deepEqual(asked[0].moved, [{ chatId: 'a', epoch: 1, targetHostId: 'b' }]);
  assert.deepEqual(told, [{ poisoned: [{ chatId: 'a', epoch: 1 }], conflicts: [], agreed: [] }]);
});

test('an app that listens for nothing, or a listener that throws, does not fail the connection', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = helloReply({ continued: { poisoned: [] } });
  const { host } = await onlineRemote(w);
  assert.deepEqual(await host.chats(), ['a', 'b']);
  const w2 = hostWorld(t);
  w2.net.handlers['host.hello'] = helloReply({ continued: { poisoned: [] } });
  const { host: second } = await onlineRemote(
    w2,
    {},
    {
      onHello: () => {
        throw new Error('listener broke');
      },
    },
  );
  assert.deepEqual(await second.chats(), ['a', 'b']);
  assert.equal(await second.call('host.status', {}).then(() => 'ok'), 'ok');
});

test('a request refused because the connection is down says it never left; one the Host refuses keeps its code and details', async (t) => {
  const w = hostWorld(t);
  const { host, tun } = await onlineRemote(w);
  w.net.raw['chat.commitContinue'] = (id) => ({
    id,
    error: 'handed over',
    code: 'chat_released',
    details: { targetHostId: 'b', epoch: 2 },
  });
  const params = { chatId: 'a', expectedEpoch: 1, targetHostId: 'b', preparedId: 'prepared-0001' };
  await assert.rejects(host.call('chat.commitContinue', params), (e: any) => e.code === 'chat_released' && e.details.epoch === 2);
  await assert.rejects(host.call('chat.commitContinue', { chatId: 'a' }), (e: any) => e.code === 'invalid');
  host.dispose();
  await tick();
  const fresh = w.remote(tun);
  await assert.rejects(fresh.call('chat.commitContinue', params), (e: any) => e.code === 'host_unreachable' && e.notSent === true);
});
