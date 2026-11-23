// The relay connection's JWT renewal and request/answer handling (electron/remote/relayClient.cjs) against a fake relay socket and mocked timers: the open socket gets a fresh token every 10 minutes, and pair.register / pair.remove resolve on ok and reject on a refusal, a silence, a lost socket or a closed one.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { R, RelayClient, rig, withTimers } from './support/remote-relay-kit.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { FakeSocket } from './support/remoteSocket.ts';

test('renewal: the open socket gets a fresh JWT every 10 minutes; none to give, or a socket replaced meanwhile, sends nothing', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig({ tokens: ['jwt-1', 'jwt-2', null, 'jwt-4'] });
    client.start();
    await tick();
    sockets[0].hello();
    mock.timers.tick(R.RENEW_MS);
    await tick();
    assert.deepEqual(sockets[0].sentOf('auth'), [{ t: 'auth', token: 'jwt-2' }]);
    mock.timers.tick(R.RENEW_MS);
    await tick();
    assert.equal(sockets[0].sentOf('auth').length, 1, 'no token, no auth message');
    mock.timers.tick(R.RENEW_MS);
    await tick();
    assert.deepEqual(sockets[0].sentOf('auth').at(-1), { t: 'auth', token: 'jwt-4' });
    client.stop();
  });
});

test('renewal: a socket that closed while the token was read is not sent the token', async () => {
  await withTimers(async () => {
    const gate = deferred<string>();
    let calls = 0;
    const sockets: FakeSocket[] = [];
    const client = new RelayClient({
      url: () => 'wss://x',
      getToken: () => (++calls === 1 ? Promise.resolve('t1') : gate.promise),
      createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
      random: () => 1,
    });
    client.start();
    await tick();
    sockets[0].hello();
    mock.timers.tick(R.RENEW_MS);
    await tick();
    sockets[0].serverClose(1006);
    gate.resolve('t2');
    await tick();
    assert.equal(sockets[0].sentOf('auth').length, 0);
    client.stop();
  });
});

test('renewal: a timer firing after the socket went away does nothing', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.start();
    await tick();
    sockets[0].hello();
    client.stop();
    mock.timers.tick(R.RENEW_MS * 2);
    await tick();
    assert.equal(sockets[0].sentOf('auth').length, 0);
  });
});

test('requests: pair.register and pair.remove carry a request id and resolve on ok', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    client.start();
    await tick();
    sockets[0].hello();
    const reg = client.registerPair('p_abcdefgh');
    const rem = client.removePair('p_abcdefgh');
    const [a, b] = sockets[0].sent.slice(-2);
    assert.deepEqual([a.t, a.pair, b.t, b.pair], ['pair.register', 'p_abcdefgh', 'pair.remove', 'p_abcdefgh']);
    assert.notEqual(a.rid, b.rid);
    sockets[0].recv({ t: 'ok', op: 'pair.remove', rid: b.rid });
    sockets[0].recv({ t: 'ok', op: 'pair.register', rid: a.rid, pair: 'p_abcdefgh' });
    await Promise.all([reg, rem]);
    client.stop();
  });
});

test('requests: a refusal rejects with its code; no answer times out; a lost socket rejects; not connected rejects', async () => {
  await withTimers(async () => {
    const { client, sockets } = rig();
    await assert.rejects(client.registerPair('p_abcdefgh'), /not connected/);
    client.start();
    await tick();
    sockets[0].hello();
    const refused = client.registerPair('p_abcdefgh');
    sockets[0].recv({ t: 'error', code: 'pair_exists', rid: sockets[0].sent.at(-1).rid });
    await assert.rejects(refused, { code: 'pair_exists' });
    const slow = client.registerPair('p_abcdefgh');
    mock.timers.tick(R.REQUEST_TIMEOUT_MS);
    await assert.rejects(slow, /did not answer/);
    const lost = client.registerPair('p_abcdefgh');
    sockets[0].serverClose(1006);
    await assert.rejects(lost, /connection was lost/);
    mock.timers.tick(1000);
    await tick();
    sockets[1].hello();
    sockets[1].throwOnSend = true;
    await assert.rejects(client.removePair('p_abcdefgh'), /not connected/);
    sockets[1].recv({ t: 'ok', rid: 'never-asked' });
    client.stop();
  });
});
