// The stream event for a message taken into the running turn (#5141): one shape from every adapter that steers, shown by the Mac in that turn as the item a This Mac steer leaves, and the row it kept for the message retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { steeredEvent } from '../host/src/steeredEvent.mjs';
// @ts-ignore: plain ESM without declarations
import { createTurnBridge } from '../host/src/turnBridge.mjs';
import { CHAT, ev, start, world } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { AcpItems } = require('../electron/harness/items/acp.cjs');

test('the event names the running turn and the message by its key, with what was written when no display input was kept', () => {
  assert.deepEqual(steeredEvent({ chatId: 'c', turnId: 't', clientId: 'k', text: 'hi' }), {
    kind: 'steered',
    key: 'c',
    turnId: 't',
    user: { id: 'u-k', clientId: 'k', messageKey: 'k', content: [{ type: 'text', text: 'hi' }] },
  });
  assert.deepEqual(steeredEvent({ chatId: 'c', turnId: 't', clientId: 'k' }).user.content, []);
  const kept = { id: 'u-k', clientId: 'k', messageKey: 'k', content: [{ type: 'image', url: 'x' }] };
  assert.equal(steeredEvent({ chatId: 'c', turnId: 't', clientId: 'k', text: 'ignored', user: kept }).user, kept);
});

test('the Claude bridge tells a steered message in the turn that is open, and says nothing when none is', () => {
  const told: any[] = [];
  const bridge = createTurnBridge({
    state: { get: () => ({ activeTurn: { id: 't1' } }) },
    emit: (e: any) => told.push(e),
    controller: () => ({ ref: () => ({ kind: 'claude' }), chatOf: (k: string) => k, resolveApproval: () => undefined }) as any,
    answer: () => true,
  });
  bridge.adapterEvent({ kind: 'steered', key: 'claude:c1', clientId: 'm1', text: 'early' });
  assert.deepEqual(told, [], 'no turn is open: nothing to tell');
  bridge.patched({ chatId: 'claude:c1', patch: { turn: 'running' } });
  told.length = 0;
  const user = { id: 'u-m1', clientId: 'm1', messageKey: 'm1', content: [{ type: 'text', text: 'shown' }] };
  bridge.noteUser('m1', 'shown', user);
  bridge.adapterEvent({ kind: 'steered', key: 'claude:c1', clientId: 'm1', text: 'shown' });
  assert.deepEqual(told, [{ kind: 'steered', key: 'claude:c1', turnId: 't1', user }]);
});

test('the Mac shows the steered message as a user item in the running turn, and only in one', () => {
  const shown: any[][] = [];
  const items = new AcpItems({
    emit: (...a: any[]) => shown.push(a),
    chatOf: () => 'chat',
    nativeOf: () => 'acp:host-claude:k',
    cwdOf: () => '',
    timers: { set: () => 0, clear: () => undefined },
    now: () => 0,
  });
  const key = 'acp:host-claude:k';
  const user = { id: 'u-m1', clientId: 'm1', messageKey: 'm1', content: [{ type: 'text', text: 'also this' }] };
  assert.equal(items.onEvent({ kind: 'steered', key, turnId: 't1', user }), null);
  assert.deepEqual(shown, [], 'no turn is open here: nothing is shown');
  items.onEvent({ kind: 'turnStart', key, turnId: 't1', user: { id: 'u-t1', clientId: 't1', content: [] } });
  shown.length = 0;
  items.onEvent({ kind: 'steered', key, turnId: 't1', user });
  const [, , method, params] = shown[0] as any[];
  assert.deepEqual(
    [method, params.turnId, params.item.type, params.item.content[0].text],
    ['item/completed', 't1', 'userMessage', 'also this'],
  );
});

test("the stream's steered event retires the Mac's row for the message by its key", async () => {
  const seen: any[][] = [];
  const w = world(undefined, undefined, {
    take: () => undefined,
    seen: (...a: any[]) => void seen.push(a),
    settleSteered: () => undefined,
  } as any);
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch(CHAT, 1, start());
  w.host.fire.patch(CHAT, 2, ev({ kind: 'steered', turnId: 't1', user: { id: 'u-m1', clientId: 'm1', messageKey: 'm1', content: [] } }));
  await w.chats.settled(CHAT);
  assert.deepEqual(
    seen.filter((a) => a[2] === 'm1'),
    [[CHAT, '', 'm1']],
  );
  assert.equal(
    w.emitted.some((e) => e.kind === 'steered'),
    true,
  );
});
