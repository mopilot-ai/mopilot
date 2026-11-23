// A durable message is authoritative over the deltas drawn of it (electron/host/remoteChats.cjs, #3525): when a delta was lost (a reconnect), the Host's whole text replaces what was drawn, and the window ends with the full reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, start, text, end, world } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { AcpTranslator } = require('../electron/harness/items/acpTranslator.cjs');

const KEY = 't1:agent_message_chunk:';
const head = { turnId: 't1', sessionUpdate: 'agent_message_chunk' };

/** What a window shows of the mirror's events: the translator's items, folded the way the store applies them (src/store/notifications.ts). */
function windowText(events: any[]) {
  const items = new Map<string, any>();
  const tr = new AcpTranslator(CHAT, '', (method: string, p: any) => {
    if (method === 'item/started' || method === 'item/completed') items.set(p.item.id, { ...p.item });
    else if (method === 'item/agentMessage/delta') items.get(p.itemId).text += p.delta;
  });
  for (const e of events) {
    if (e.kind === 'turnStart') tr.beginTurn(e.turnId, e.user);
    else if (e.kind === 'update') tr.onUpdate(e.update, e.turnId, e.replaces);
    else if (e.kind === 'turnEnd') tr.endTurn(e.stopReason, null);
  }
  return [...items.values()].filter((i) => i.type === 'agentMessage').map((i) => i.text);
}

async function online() {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch(CHAT, 1, start());
  return w;
}

test('a caught-up image-only input settles by its durable message key', async () => {
  const accepted: unknown[] = [];
  const w = world(undefined, undefined, {
    take: () => undefined,
    seen: (...args) => accepted.push(args),
    settleSteered: () => undefined,
  });
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch(CHAT, 1, start());
  w.host.fire.patch(CHAT, 2, {
    t: 'user',
    turnId: 't1',
    text: '',
    messageKey: 'saved-first',
    user: { id: 'saved-first', content: [{ type: 'image', url: 'host-image:sha' }] },
  });
  await w.chats.settled(CHAT);
  assert.deepEqual(accepted, [[CHAT, undefined, 'saved-first']]);
});

test('the first delta lost on a reconnect: the durable whole text replaces the drawn part, in the window and the transcript', async () => {
  const w = await online();
  // "fake-host: " went to nobody; only the second half arrives live
  w.host.fire.delta(CHAT, KEY, { ...head, text: 'while away' });
  w.host.fire.patch(CHAT, 2, text('fake-host: while away'), KEY);
  w.host.fire.patch(CHAT, 3, end());
  await w.chats.settled(CHAT);
  const replaced = w.emitted.find((e) => e.replaces !== undefined);
  assert.deepEqual(replaced, {
    kind: 'update',
    key: CHAT,
    turnId: 't1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fake-host: while away' } },
    replaces: 'while away',
  });
  assert.deepEqual(windowText(w.emitted), ['fake-host: while away']);
  assert.equal(w.items.records.find((r) => r.t === 'update').update.content.text, 'fake-host: while away');
});

test('deltas that the durable text continues are not replaced: only the rest is drawn', async () => {
  const w = await online();
  w.host.fire.delta(CHAT, KEY, { ...head, text: 'fake-host: ' });
  w.host.fire.patch(CHAT, 2, text('fake-host: hello'), KEY);
  w.host.fire.patch(CHAT, 3, end());
  await w.chats.settled(CHAT);
  assert.equal(
    w.emitted.some((e) => e.replaces !== undefined),
    false,
  );
  assert.deepEqual(windowText(w.emitted), ['fake-host: hello']);
});

test('deltas that drew more than the durable text are replaced too, and a durable equal to them draws nothing more', async () => {
  const w = await online();
  w.host.fire.delta(CHAT, KEY, { ...head, text: 'abc', messageId: 'm1' });
  w.host.fire.patch(CHAT, 2, text('ab', 't1', { messageId: 'm1' }), KEY);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.emitted.at(-1).replaces, 'abc');
  assert.equal(w.emitted.at(-1).update.messageId, 'm1');
  const n = w.emitted.length;
  w.host.fire.delta(CHAT, 'k2', { ...head, text: 'same' });
  w.host.fire.patch(CHAT, 3, text('same'), 'k2');
  w.host.fire.patch(CHAT, 4, end());
  await w.chats.settled(CHAT);
  assert.deepEqual(
    w.emitted.slice(n).map((e) => [e.kind, e.replaces]),
    [
      ['update', undefined],
      ['turnEnd', undefined],
    ],
  );
});
