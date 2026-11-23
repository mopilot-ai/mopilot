// The small parts of the remote service: who may answer, the ledger, the session view, the permission cap, the gate and the live-event chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMemoryLink } from '../shared/remote/transport.mjs';
import { fakeOps } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { windowAnswerer, deviceAnswerer, mayAnswer, REFUSED } = require('../shared/answerOwner.mjs');
const { shownBy } = require('../electron/session/viewing.cjs');
const { CardLedger } = require('../electron/remote/cardLedger.cjs');
const { viewOf, changesCards } = require('../electron/remote/sessionView.cjs');
const { capPermission } = require('../electron/remote/permissionCap.cjs');
const { gateRemote } = require('../electron/remote/gate.cjs');
const { liveChatOf } = require('../electron/remote/liveChat.cjs');
const { stateOf } = require('../electron/remote/chatState.cjs');
const { RemoteService } = require('../electron/remote/service.cjs');
const { RemoteError, CODES } = require('../electron/remote/serviceErrors.cjs');

test('a window answers the chats its panes show; a device the chats it follows; one rule for both', () => {
  const viewedBy = new Map([[7, { visible: ['c1'], primary: 'c1', focused: 'c1' }]]);
  assert.equal(
    mayAnswer(
      windowAnswerer((c: string) => shownBy(viewedBy, 7, c)),
      'c1',
    ),
    true,
  );
  assert.equal(
    mayAnswer(
      windowAnswerer((c: string) => shownBy(viewedBy, 7, c)),
      'c2',
    ),
    false,
  );
  assert.equal(
    mayAnswer(
      windowAnswerer((c: string) => shownBy(viewedBy, 8, c)),
      'c1',
    ),
    false,
  );
  const follows = new Set(['c1']);
  assert.equal(mayAnswer(deviceAnswerer(follows), 'c1'), true);
  assert.equal(mayAnswer(deviceAnswerer(follows), 'c2'), false);
  assert.equal(mayAnswer(deviceAnswerer(follows), 5), false);
  assert.equal(windowAnswerer((c: string) => shownBy(viewedBy, 7, c)).kind, 'window');
  assert.equal(deviceAnswerer(follows).kind, 'device');
  assert.match(REFUSED.window, /main chat/);
  assert.match(REFUSED.device, /Follow this chat/);
});

test('the card ledger keeps the first rev a card was seen at and forgets cards that went', () => {
  const l = new CardLedger();
  l.seen('c', ['v1'], 4);
  l.seen('c', ['v1', 'v2'], 9);
  assert.equal(l.revOf('c', 'v1'), 4);
  assert.equal(l.revOf('c', 'v2'), 9);
  l.seen('c', ['v2'], 10);
  assert.equal(l.revOf('c', 'v1'), undefined);
  l.note('c', 'v3', 11);
  l.note('c', 'v3', 12);
  assert.equal(l.revOf('c', 'v3'), 11);
  l.note('fresh', 'v1', 2);
  assert.equal(l.revOf('fresh', 'v1'), 2);
  l.seen('c', [], 13);
  assert.equal(l.revOf('c', 'v2'), undefined);
  l.forget('fresh');
  assert.equal(l.revOf('fresh', 'v1'), undefined);
});

test('a session view passes what the app shows, summarizes the queue and drops tool arguments', () => {
  const view = viewOf({
    turn: 'running',
    plan: true,
    queue: [{ id: 'q', text: 'next', attachments: ['/x'], opts: { a: 1 } }, null],
    approvals: [{ id: 'a', params: { secret: 1 } }],
    questions: [{ id: 'q1' }],
    tasks: [{ id: 't' }],
    acp: { configOptions: [] },
  });
  assert.deepEqual(view, {
    turn: 'running',
    plan: true,
    queue: [
      { id: 'q', text: 'next', mine: true, attached: 1 },
      { id: '', text: '', mine: false, attached: 0 },
    ],
  });
  assert.deepEqual(viewOf({ queue: 'x' }), { queue: [] });
  assert.deepEqual(viewOf({}), {});
  const goal = { text: 'g' };
  const copy = viewOf({ goal }).goal;
  assert.deepEqual(copy, goal);
  assert.notEqual(copy, goal);
  assert.equal(changesCards({ approvals: [] }), true);
  assert.equal(changesCards({ questions: [] }), true);
  assert.equal(changesCards({ turn: 'idle' }), false);
});

test('the permission cap refuses Full access, anything above the ceiling, and passes the rest', () => {
  assert.throws(
    () => capPermission('full-access', 'auto-review'),
    (e: any) => e.code === 'forbidden' && /Full access/.test(e.message),
  );
  assert.throws(() => capPermission('bypassPermissions', 'auto-review'), /Full access/);
  assert.throws(() => capPermission('auto-review', 'default'), /above what this Mac allows/);
  assert.throws(() => capPermission('auto', 'read-only'), /above/);
  capPermission('default', 'default');
  capPermission('acceptEdits', 'default');
  capPermission('read-only', 'default');
  capPermission('plan', 'read-only');
  assert.throws(
    () => capPermission('some-acp-mode', 'read-only'),
    (e: any) => e.code === 'forbidden' && /on your Mac/.test(e.message),
  );
});

test('the gate serves a transport only while remote.enabled is on', () => {
  const { ops } = fakeOps();
  const service = new RemoteService({ ops });
  const link = createMemoryLink();
  let on = false;
  const gate = gateRemote({ service, transport: link.mac, enabled: () => on });
  assert.equal(service.attached, false, 'off by default');
  on = true;
  assert.equal(gate.apply(), true);
  assert.equal(service.attached, true);
  assert.equal(gate.apply(), true, 'applying again keeps the same attachment');
  on = false;
  assert.equal(gate.apply(), false);
  assert.equal(service.attached, false);
});

test('the chat of a raw event comes from its chat id, its thread or its session key', () => {
  const chatOf = (k: string) => `chat-of-${k}`;
  assert.equal(liveChatOf('claude', { chatId: 'c9' }, chatOf), 'c9');
  assert.equal(liveChatOf('codex', { method: 'm', params: { threadId: 't1' } }, chatOf), 'chat-of-t1');
  assert.equal(liveChatOf('codex', { method: 'm', params: {} }, chatOf), null);
  assert.equal(liveChatOf('codex', undefined, chatOf), null);
  assert.equal(liveChatOf('claude', { kind: 'message', key: 'k' }, chatOf), 'chat-of-k');
  assert.equal(liveChatOf('acp', { kind: 'update', key: '' }, chatOf), null);
  assert.equal(liveChatOf('acp', {}, chatOf), null);
});

test('state chips and error codes', () => {
  assert.equal(stateOf('running'), 'running');
  assert.equal(stateOf('awaitingUser'), 'waiting');
  assert.equal(stateOf('idle'), 'idle');
  assert.equal(stateOf(undefined), 'idle');
  assert.equal(stateOf('constructor'), 'idle');
  const e = new RemoteError('stale', 'gone');
  assert.equal(e.code, CODES.stale);
  assert.equal(e instanceof Error, true);
});

test('a service with no options says no to MoMo, has no ceiling set, and a method may return nothing', async () => {
  const { ops } = fakeOps({ attach: () => undefined });
  const service = new RemoteService({ ops });
  const hello = await service.call({ kind: 'panel' }, 'machine.hello', {});
  assert.equal(hello.capabilities.momo, undefined, 'no MoMo field, not even false');
  assert.equal(hello.app, '');
  const link = createMemoryLink();
  link.addPair('p');
  service.attach(link.mac);
  const replies: any[] = [];
  link.phone('p').onMessage((m: any) => replies.push(m));
  await link.phone('p').send({ id: 'a', t: 1, kind: 'request', method: 'chat.attach', params: { dataUrl: 'data:x,y' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(replies[0].result, {});
  assert.equal(typeof replies[0].t, 'number');
});
