// A chat that runs on another machine keeps its queue for the machine: the controller's own drain never starts what shows there on this Mac (#4719).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { selectSegment, setup, tick } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { remoteRoutes } = require('../electron/host/wiring.cjs');

/** A machine chat's queue entry as remoteSendProjection shows one the Host has but the transcript does not yet: no waiting state. */
const sentBubble = { id: 'k1', text: 'Run the command', attachments: [], opts: {} };

test('a chat on a machine is not drained here: the sent bubble in its queue starts no turn on this Mac', async () => {
  const { c, chats, state, execs } = setup();
  selectSegment(c, chats, 'machine-chat', [['acp:host-claude', 'native']]);
  c.remote = { stop: () => null, owns: (chatId: string) => chatId === 'machine-chat' };
  state.patch('machine-chat', { queue: [sentBubble] });
  assert.equal(c.drain('machine-chat'), undefined);
  await tick();
  assert.equal(execs.length, 0, 'no turn started on this Mac');
  assert.deepEqual(
    state.get('machine-chat').queue.map((q: any) => q.id),
    ['k1'],
    'the bubble stays for the machine',
  );
});

test('a chat that runs here is drained as before, with or without a machine route', async () => {
  for (const remote of [undefined, { stop: () => null, owns: () => false }]) {
    const { c, chats, state, execs } = setup();
    selectSegment(c, chats, 'local-chat', [['acp:fake', 'native']]);
    if (remote) c.remote = remote;
    state.patch('local-chat', { queue: [sentBubble] });
    c.drain('local-chat');
    await tick();
    assert.equal(execs.length, 1, 'the queued message starts here');
    assert.equal(execs[0].kind, 'acp-turn');
  }
});

test('main answers whether a chat runs on a machine from the remote send service, false while Host is off', () => {
  const owned = remoteRoutes({ remoteSend: () => ({ owns: (chatId: string) => chatId === 'on-machine' }) });
  assert.equal(owned.owns('on-machine'), true);
  assert.equal(owned.owns('here'), false);
  assert.equal(remoteRoutes({}).owns('anything'), false);
  assert.equal(remoteRoutes({ remoteSend: () => ({ owns: () => undefined }) }).owns('x'), false);
});
