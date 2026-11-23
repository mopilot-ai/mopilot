// Main's wiring hands a machine chat's turn start the pictures the messages service kept (electron/host/wiring.cjs remoteChatsFor sent.attached).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { remoteChatsFor } = require('../electron/host/wiring.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

test('a turn start of a message this Mac sent reaches the bus with the image files the service kept for it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-bubble-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('acp:kimi:a', {
    hostId: 'box',
    ownerHostId: 'box',
    epoch: 0,
    folder: '/srv/a',
  });
  const events: any[] = [];
  const patches = new Set<any>();
  const host: any = {
    state: () => 'online',
    onState: () => () => undefined,
    connect: async () => undefined,
    subscribe: async () => ({ snapshot: { rev: 1, items: [] }, patches: null, generation: 'g', inflight: [] }),
    events: {
      onPatch: (fn: any) => (patches.add(fn), () => patches.delete(fn)),
      onFrame: () => () => undefined,
      onResync: () => () => undefined,
      onInflight: () => () => undefined,
    },
  };
  const asked: any[] = [];
  const seen: any[] = [];
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => host }),
    acpHost: () => ({
      questions: { openRemote: () => undefined, closeRemote: () => undefined },
      items: { append: () => undefined, readAsync: async () => [] },
      emitEvent: (e: any) => events.push(e),
    }),
    sender: () => ({
      sent: {
        take: () => undefined,
        seen: (...a: any[]) => seen.push(a),
        attached: (...a: any[]) => (asked.push(a), [{ kind: 'image', path: '/Users/me/one.png' }]),
      },
    }),
    report: (e: Error) => assert.fail(e.message),
  });
  chats.followAll();
  await chats.get()!.settled('acp:kimi:a');
  const user = { id: 'u-k', clientId: 'k', messageKey: 'k', content: [{ type: 'text', text: 'look' }] };
  const event = { kind: 'turnStart', turnId: 't', user };
  patches.forEach((f) => f({ chatId: 'acp:kimi:a', rev: 2, patch: { item: { t: 'event', family: 'acp', event } } }));
  await chats.get()!.settled('acp:kimi:a');
  assert.deepEqual(asked, [['acp:kimi:a', 'k']]);
  assert.deepEqual(events[0].user.content, [
    { type: 'text', text: 'look' },
    { type: 'localImage', path: '/Users/me/one.png' },
  ]);
  assert.deepEqual(seen, [['acp:kimi:a', 'look', 'k']]);
});
