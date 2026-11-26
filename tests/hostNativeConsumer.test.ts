// What native sessions do to the Host's own chat list and its connections (#5576, Phase 4, slice 1): a session the Host starts to run, the chat requests, who asks the discoverers for work, the three states of a row and what could not be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseParams, PARSERS } from '../shared/host/schema.mjs';
import { createChatIndex } from '../host/src/chatIndex.mjs';
import { createNativeIndex } from '../host/src/nativeIndex.mjs';
import { UUID, who, session, host, list } from './support/host/nativeKit.ts';

test('a session the Host starts to run after it was told of is told gone, and told of again when the Host chat goes', async () => {
  const h = host([{ chatId: 'claude:own', updatedAt: 1 }]);
  const got: any[] = [];
  await h.made.handlers['host.chats.watch']({ native: true }, 'x', who('desktop'), (m: any) => void got.push(m), new Set());
  h.native.upsert(session(1));
  h.native.upsert({ ...session(2), family: 'codex' });
  assert.deepEqual(
    got.map((m) => [m.op, m.chatId.slice(7, 13)]),
    [
      ['upsert', 'claude'],
      ['upsert', 'codex:'],
    ],
  );
  // the Host journals a chat with that Claude session id and with that Codex thread's bare id: both are the Host's now
  h.log.index.observe(`claude:${UUID(1)}`, { t: 'durable', item: { t: 'x' } });
  h.log.index.observe(UUID(2), { t: 'durable', item: { t: 'x' } });
  h.log.index.observe('acp:kimi:other', { t: 'durable', item: { t: 'x' } });
  await h.log.index.ready();
  assert.deepEqual(
    got.filter((m) => m.op === 'remove').map((m) => m.chatId),
    [`native:claude:${UUID(1)}`, `native:codex:${UUID(2)}`],
  );
  assert.equal((await list(h, { origin: 'native' }, 'desktop')).chats.length, 0, 'the list agrees with what was told');
  h.native.recheck('claude:never-heard-of');
  h.native.recheck('acp:kimi:other');
  // the Host's chat is deleted: the session is a native row again, told as new
  const before = got.length;
  h.log.index.observe(`claude:${UUID(1)}`, { t: 'removed' });
  assert.equal(got.length - before, 2, 'the removal of the Host chat, and the session told of again');
  assert.equal(got.at(-1).op, 'upsert');
  assert.equal((await list(h, { origin: 'native' }, 'desktop')).chats.length, 1);
  h.native.close();
});

test('no chat request may name a native session, and a native row whose state the agent cannot say is unknown', async () => {
  for (const method of ['chat.send', 'chat.start', 'chat.remove'])
    assert.throws(
      () =>
        parseParams(method, {
          chatId: `native:claude:${UUID(1)}`,
          epoch: 1,
          text: 'x',
          key: '11111111-1111-4111-8111-111111111111',
          harness: 'claude',
        }),
      /isn't in MoPilot/,
      method,
    );
  assert.ok(parseParams('chat.send', { chatId: `claude:${UUID(1)}`, epoch: 1, text: 'x', key: '11111111-1111-4111-8111-111111111111' }));
  const h = host();
  h.native.upsert(session(1, { running: null }));
  assert.equal((await list(h, { origin: 'native' }, 'desktop')).chats[0].state, 'unknown');
});

test('discoverers are asked for only when a client that may see native rows lists or watches, and rest when it stops', async () => {
  const calls: string[] = [];
  const stops: string[] = [];
  const consumer = {
    demand: async () => void calls.push('demand'),
    watching: () => (calls.push('watching'), () => void stops.push('stop')),
  };
  const h = host([], { consumer });
  await list(h, { origin: 'native' }, 'desktop');
  await list(h, { origin: 'all' }, 'controller');
  assert.deepEqual(calls, ['demand', 'demand']);
  await list(h, { origin: 'native' }, 'phone');
  await list(h, {}, 'desktop'); // a plain list of the Host's chats needs no scan
  await list(h, { origin: 'native' }, null);
  assert.deepEqual(calls, ['demand', 'demand'], 'a client that may not see them, or does not ask, costs nothing');
  const ends = new Set<() => void>();
  const watch = (kind: string, p: object, e = ends) => h.made.handlers['host.chats.watch'](p, 'x', who(kind), () => {}, e);
  await watch('phone', { native: true }, new Set());
  await watch('desktop', {}, new Set());
  assert.equal(calls.includes('watching'), false);
  await watch('desktop', { native: true });
  assert.equal(calls.filter((c) => c === 'watching').length, 1);
  await watch('desktop', { native: true }); // a second watch replaces the first
  assert.deepEqual(stops, ['stop']);
  assert.equal(calls.filter((c) => c === 'watching').length, 2);
  for (const end of [...ends]) end();
  assert.equal(stops.length, 2, 'ending the connection lets the discoverers rest');
  h.native.close();
});

test('a listener of the chat index that throws is reported and does not stop the others, and can be removed', async () => {
  const reported: string[] = [];
  const index = createChatIndex({ load: async () => [], epoch: () => 1, report: (m) => void reported.push(m) });
  await index.ready();
  const heard: string[] = [];
  index.onRow(() => {
    throw new Error('listener broke');
  });
  const stop = index.onRow((id) => void heard.push(id));
  index.observe('claude:a', { t: 'durable', item: { t: 'x' } });
  assert.deepEqual(heard, ['claude:a']);
  assert.match(reported.join(), /listener broke/);
  stop();
  index.observe('claude:b', { t: 'durable', item: { t: 'x' } });
  assert.deepEqual(heard, ['claude:a']);
});

test('idle, unknown and running are three states: a change between any two is applied and told, including idle to unknown', async () => {
  const h = host();
  const got: any[] = [];
  await h.made.handlers['host.chats.watch']({ native: true }, 'x', who('desktop'), (m: any) => void got.push(m), new Set());
  let clock = 0;
  const idx = createNativeIndex({ announce: (...a) => h.log.index.announce(...a), now: () => (clock += 3000) });
  for (const running of [false, null, true, null, false, undefined, false]) idx.upsert(session(1, { running }));
  assert.deepEqual(
    got.map((m) => m.chat.state),
    ['idle', 'unknown', 'running', 'unknown', 'idle'],
    'undefined is idle, so the last two are not changes',
  );
  h.native.close();
  idx.close();
});

test('no chat method takes a native id: every chat.* request either refuses it or does not carry a chat id at all', () => {
  const methods = Object.keys(PARSERS).filter((m) => m.startsWith('chat.'));
  assert.ok(methods.length >= 10, 'the check sees the chat methods');
  const params = {
    chatId: `native:claude:${UUID(1)}`,
    epoch: 1,
    key: '11111111-1111-4111-8111-111111111111',
    text: 'x',
    harness: 'claude',
    requestId: 'r1',
    value: 'a',
    preparedId: '22222222-2222-4222-8222-222222222222',
  };
  for (const method of methods) {
    let parsed: any;
    try {
      parsed = parseParams(method, params);
    } catch (error: any) {
      assert.ok(error instanceof Error, method);
      continue; // refused (for this id or for another reason: either way it is not served)
    }
    assert.notEqual(parsed?.chatId, params.chatId, `${method} would serve a native id`);
  }
  for (const method of ['chat.send', 'chat.start', 'chat.stop', 'chat.permit', 'chat.subscribe', 'chat.remove'])
    assert.throws(() => parseParams(method, params), /isn't in MoPilot/, method);
});

test('what could not be read comes with the rows, a family and why in words with the fix, and only when something could not be', async () => {
  let notes: any[] = [{ family: 'codex', reason: 'not_started', words: 'Start a Codex chat on this machine.' }];
  const h = host([], { consumer: { demand: async () => {}, watching: () => () => {}, notes: () => notes } });
  h.native.upsert(session(1));
  const answer = await list(h, { origin: 'native' }, 'desktop');
  assert.deepEqual(answer.native, { notes });
  assert.equal(answer.chats.length, 1);
  assert.equal((await list(h, { origin: 'all' }, 'controller')).native.notes.length, 1);
  assert.equal('native' in (await list(h, {}, 'desktop')), false, 'a plain list says nothing of them');
  assert.equal('native' in (await list(h, { origin: 'native' }, 'phone')), false, 'nor to a client that may not see them');
  notes = [];
  assert.equal('native' in (await list(h, { origin: 'native' }, 'desktop')), false);
  h.native.close();
});
