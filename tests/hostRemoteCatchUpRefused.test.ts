// A followed chat whose catch-up after a reconnect fails for a reason that is not the connection (#5404): the Mac must not go on showing the turn as running with the Host's end never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostWorld, onlineRemote, tick } from './support/host-wire-kit.ts';

test('a catch-up after a reconnect that fails with an invalid answer is told to the windows and tried again, not dropped in silence', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 2 }, patches: null });
  await host.subscribe('a');
  const closed: any[] = [];
  host.events.onClosed((p: any) => closed.push(p));
  const patches: number[] = [];
  host.events.onPatch((p: any) => patches.push(p.rev));
  const asked: any[] = [];
  let calls = 0;
  w.net.handlers.subscribe = (p) => {
    asked.push(p);
    if (++calls === 1)
      throw Object.assign(new Error('Too much live history arrived while opening this chat. Retry the chat.'), { code: 'invalid' });
    return {
      snapshot: { rev: 4 },
      patches: [
        { rev: 3, patch: { item: {} } },
        { rev: 4, patch: { item: {} } },
      ],
    };
  };
  w.children[0].die();
  w.clock.advance(1000);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(asked.length, 1, 'the first read failed');
  assert.deepEqual(closed, [], 'a read that may succeed next time is not a close');
  w.clock.advance(1000);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(asked.length, 2, 'the chat is read again');
  assert.deepEqual(patches, [3, 4], 'the Host’s end of the turn reaches the window once the Host answers');
});

test('a catch-up that keeps failing is read five more times, then the windows are told why and the chat is let go; an error with no code of its own is the Host’s', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 2 }, patches: null });
  await host.subscribe('a');
  await host.subscribe('b');
  const closed: any[] = [];
  host.events.onClosed((p: any) => closed.push([p.chatId, p.reason]));
  let calls = 0;
  w.net.handlers.subscribe = (p) => {
    calls++;
    if (p.chatId === 'b') throw new Error('no code of its own');
    throw Object.assign(new Error('still too much'), { code: 'invalid' });
  };
  w.children[0].die();
  w.clock.advance(1000);
  for (let i = 0; i < 4; i++) await tick();
  for (let n = 0; n < 6; n++) {
    w.clock.advance(1000 * 2 ** n);
    for (let i = 0; i < 4; i++) await tick();
  }
  assert.deepEqual(closed.sort(), [
    ['a', 'invalid'],
    ['b', 'host_error'],
  ]);
  assert.equal(calls, 12, 'the first try and five more for each chat');
});
