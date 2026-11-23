// One chat, two spellings of its id (#5160): the app draws a Host chat as `acp:host-claude:<id>` while a Host knows it as `claude:<id>`. A continue's calls from the Mac (electron/host/hostContinue.cjs) carry the Host's spelling like every other chat call, and a Host (host/src/continueWiring.mjs) answers either one: the handoff, the owner and the epoch of a continued chat are kept under one id, over the real protocol of a fake Host process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { code, connect, key, req, world } from './support/hostServiceKit.ts';

/** The chat as the app draws it, and as the Host knows it. */
const APP = 'acp:host-claude:c1';
const HOST = 'claude:c1';
const fresh = () => {
  const w = world();
  w.ownership.set(APP, { hostId: 'local', ownerHostId: 'local', epoch: 0, folder: '/mac/app' });
  return w;
};

test('a chat the app draws as acp:host-claude:<id> arrives on the Host under its own id: the first message carries the handoff', async () => {
  const w = fresh();
  assert.deepEqual(await w.service.run(req({ chatId: APP })), { hostId: 'B', epoch: 1 });
  const { conn } = await connect(w.hosts.B);
  await conn.call('chat.send', { chatId: HOST, epoch: 1, key: key(), text: 'now?' });
  const first = w.hosts.B.sends[0];
  assert.match(first.text, /^<sage-handoff from="Claude Code"/);
  assert.match(first.text, /fix the login bug/);
  assert.ok(first.text.endsWith('\n\nnow?'));
  assert.equal(w.hosts.B.epochs.current(HOST), 1, 'the Host holds the chat at the new epoch under its own id');
  // the source Mac let go of the chat under the id the app uses
  assert.deepEqual(w.retired, [APP]);
});

test('the source lost: it returns, is told the chats the app moved by the app’s id, poisons its copy under its own, and the app hears them in its own spelling', async () => {
  const w = fresh();
  await w.service.run(req({ chatId: APP }));
  const b = await connect(w.hosts.B);
  await b.conn.call('chat.send', { chatId: HOST, epoch: 1, key: key(), text: 'last thing on B' });
  w.down.add('B');
  await w.service.run(req({ chatId: APP, targetHostId: 'C', cwd: '/work/c', lostHostConfirmed: true }));
  assert.equal(w.ownership.get(APP).lostHost.sourceHostId, 'B');
  w.down.delete('B');
  await w.service.hostReturned('B');
  assert.equal(w.hosts.B.epochs.current(HOST), 2);
  assert.equal(w.ownership.get(APP).lostHost, undefined);
  assert.equal(w.tails.read(APP)[0].hostId, 'B');
  // a poisoned chat takes no write under the Host's id either
  await assert.rejects(b.conn.call('chat.send', { chatId: HOST, epoch: 1, key: key(), text: 'again' }), code('chat_poisoned'));
});

test('a Host that answers a hello with a chat the app did not name hands it on unchanged, and a reply that is no list is left for the app to refuse', async () => {
  const w = fresh();
  w.ownership.set(APP, {
    hostId: 'C',
    ownerHostId: 'C',
    epoch: 1,
    folder: '/c',
    lostHost: { sourceHostId: 'B', targetHostId: 'C', epoch: 1, rev: 0 },
  });
  const answers: any[] = [
    { poisoned: [{ chatId: 'claude:other', epoch: 1 }, null], conflicts: [], agreed: [] },
    { poisoned: 'nonsense', conflicts: [], agreed: [] },
  ];
  for (const continued of answers) {
    const asked: any[] = [];
    const seen = world();
    seen.ownership.set(APP, w.ownership.get(APP));
    const realSession = seen.hosts.B.protocol.connection;
    seen.hosts.B.protocol.connection = ((emit: any) => {
      const conn = realSession(emit);
      return {
        ...conn,
        call: async (method: string, params: any) => {
          asked.push([method, params]);
          if (method !== 'host.hello') return conn.call(method, params);
          return { ...(await conn.call(method, params)), continued };
        },
      };
    }) as any;
    await seen.service.hostReturned('B');
    const hello = asked.find(([m]) => m === 'host.hello');
    assert.deepEqual(
      hello[1].moved.map((m: any) => m.chatId),
      [HOST],
      'the hello names the chat as the Host knows it',
    );
  }
});
