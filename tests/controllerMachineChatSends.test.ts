// A chat that runs on another machine takes no message from a caller other than its window's route: the controller refuses it and starts nothing on this Mac (#4738, the siblings of #4719).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { selectSegment, setup, tick } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { sendRunMessage } = require('../electron/app/automations.cjs');

const message = (id = 'm1') => ({ id, text: 'Continue', attachments: [], opts: {} });
const onMachine = (c: any, chats: any) => {
  selectSegment(c, chats, 'machine-chat', [['acp:host-claude', 'native']]);
  c.remote = { stop: () => null, owns: (chatId: string) => chatId === 'machine-chat' };
};

test('send refuses a machine chat, with or without waiting, and nothing starts or queues here', async () => {
  const { c, chats, execs, state } = setup();
  onMachine(c, chats);
  const quick = c.send('machine-chat', message('m1'), null);
  assert.equal(quick.action, 'failed');
  assert.match(quick.error, /runs on another machine/);
  const waited = await c.send('machine-chat', message('m2'), null, true);
  assert.deepEqual([waited.action, waited.id], ['failed', 'm2']);
  await tick();
  assert.equal(execs.length, 0, 'no turn started on this Mac');
  assert.deepEqual(state.get('machine-chat').queue, [], 'no queue entry for the machine');
});

test('startOrKeep refuses a machine chat without queueing the message', async () => {
  const { c, chats, execs, state } = setup();
  onMachine(c, chats);
  const result = await c.startOrKeep('machine-chat', message());
  assert.equal(result.started, false);
  assert.match(result.error, /runs on another machine/);
  assert.equal(execs.length, 0);
  assert.deepEqual(state.get('machine-chat').queue, []);
});

test('a scheduled run into a machine chat is the run’s failure, not a start here', async () => {
  const { c, chats, execs } = setup();
  onMachine(c, chats);
  const result = await sendRunMessage(c, 'machine-chat', { text: 'Run it', attachments: [], opts: {} }, null);
  assert.equal(result.started, false);
  assert.match(result.error, /runs on another machine/);
  assert.equal(execs.length, 0);
});

test('a chat that runs here sends as before', async () => {
  const { c, chats, execs } = setup();
  selectSegment(c, chats, 'local-chat', [['acp:fake', 'native']]);
  c.remote = { stop: () => null, owns: () => false };
  assert.equal(c.send('local-chat', message(), null).action, 'started');
  await tick();
  assert.equal(execs.length, 1);
  assert.equal(execs[0].kind, 'acp-turn');
});

test('a refused send of an item with no id still answers with one', () => {
  const { c, chats } = setup();
  onMachine(c, chats);
  const refused = c.send('machine-chat', { text: 'Continue', attachments: [], opts: {} }, null);
  assert.equal(refused.action, 'failed');
  assert.match(refused.id, /^[0-9a-f-]{36}$/);
});
