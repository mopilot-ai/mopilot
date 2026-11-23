// The push kinds agree across the relay, the Host and the phone: one list, one fixed text each, only "done" may claim a chat finished, and the lock-screen buttons the relay asks for are ones the phone registers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUSH_KINDS } from '../relay/src/frames.mjs';
import { TITLES } from '../relay/src/notifier.mjs';
import { apnsBody } from '../relay/src/pushPayload.mjs';
import { createPushNotifier } from '../host/src/pushNotifier.mjs';
import { PUSH_TITLES } from '../mobile/src/push/kinds';
import { CATEGORY_SPECS } from '../mobile/src/push/actions';

const sorted = (xs: string[]) => [...xs].sort();
const message = (kind: string) =>
  ({ platform: 'apns', token: 't', kind, title: TITLES[kind as keyof typeof TITLES], count: 1, collapseId: 'c', ref: 'r' }) as any;

test('the relay accepts exactly the kinds it has a fixed text for, and the phone knows the same kinds with the same words', () => {
  assert.deepEqual(sorted(PUSH_KINDS), sorted(Object.keys(TITLES)));
  assert.deepEqual(sorted(Object.keys(PUSH_TITLES)), sorted(PUSH_KINDS));
  for (const kind of PUSH_KINDS) assert.equal(PUSH_TITLES[kind as keyof typeof PUSH_TITLES], TITLES[kind as keyof typeof TITLES], kind);
});

test('only a done push may say a chat finished', () => {
  for (const kind of PUSH_KINDS.filter((k: string) => k !== 'done'))
    assert.doesNotMatch(TITLES[kind as keyof typeof TITLES], /finish|done|complete/i, kind);
});

test('every lock-screen category the relay names is one the phone registers, and the kinds without one are the quiet ones', () => {
  const registered = new Set(CATEGORY_SPECS.map((c) => c.id));
  const without: string[] = [];
  for (const kind of PUSH_KINDS) {
    const { category } = (apnsBody(message(kind)) as any).aps;
    if (category === undefined) without.push(kind);
    else assert.ok(registered.has(category), `${kind}: ${category} is not registered on the phone`);
  }
  assert.deepEqual(sorted(without), ['cleared', 'machineOffline']);
});

test('every kind the Host sends is one the relay accepts', async () => {
  const sent = new Set<string>();
  const n = createPushNotifier({
    targets: () => [{ hostId: 'h1', pairId: 'p_pair00001', root: new Uint8Array(32).fill(3) }],
    send: async (_h: string, req: any) => (sent.add(req.kind), 'sent'),
    machineName: () => 'box',
  });
  const card = { requestId: 'q', rev: 0, cardKind: 'permission', summary: { tool: 'execute' } };
  for (const kind of ['needsYou', 'reminder', 'paused', 'cleared', 'blocked']) await n.notify({ kind, chatId: 'c', card });
  n.close();
  assert.ok(sent.size > 0);
  for (const kind of sent) assert.ok(PUSH_KINDS.includes(kind), kind);
  assert.ok(!sent.has('done'), 'a Host clears with its own kind; it sends done only when a turn ends');
});
