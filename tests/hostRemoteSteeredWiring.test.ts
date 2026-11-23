// What the Host's stream says about a steered message and a turn's end reaches the send side through main's wiring (electron/host/wiring.cjs remoteChatsFor) when it is up, and is dropped while it is not (#5141).
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

const CHAT = 'acp:kimi:a';

function fakeHost() {
  const patch = new Set<any>();
  return {
    state: () => 'online',
    onState: () => () => undefined,
    connect: async () => undefined,
    subscribe: async () => ({ snapshot: { rev: 1, items: [] }, patches: null, generation: 'g', inflight: [] }),
    events: {
      onPatch: (fn: any) => (patch.add(fn), () => patch.delete(fn)),
      onFrame: () => () => undefined,
      onResync: () => () => undefined,
      onInflight: () => () => undefined,
    },
    fire: (p: any) => patch.forEach((f) => f(p)),
  };
}

const acpHostFake = () => ({
  questions: { openRemote: () => undefined, closeRemote: () => undefined },
  items: { append: () => undefined, readAsync: async () => [] },
  emitEvent: () => undefined,
});

test("the stream's steered message and turn end reach the send side when it is up, and are dropped while it is not", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steered-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set(CHAT, { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/a' });
  const host = fakeHost();
  const calls: any[][] = [];
  let up = false;
  const chats = remoteChatsFor({
    safeStorage: () => keySafe,
    dir,
    allowed: () => true,
    machines: () => ({ hostFor: () => host }),
    acpHost: () => acpHostFake(),
    sender: () =>
      up
        ? {
            sent: {
              take: () => undefined,
              seen: (...a: any[]) => calls.push(['seen', ...a]),
              settleSteered: (id: string) => calls.push(['settle', id]),
            },
          }
        : null,
  });
  chats.followAll();
  await chats.get()!.settled(CHAT);
  const fire = (rev: number, event: any) => host.fire({ chatId: CHAT, rev, patch: { item: { t: 'event', family: 'acp', event } } });
  fire(2, { kind: 'turnEnd', turnId: 't' });
  fire(3, { kind: 'steered', user: { messageKey: 'k0' } });
  await chats.get()!.settled(CHAT);
  assert.deepEqual(calls, []);
  up = true;
  fire(4, { kind: 'steered', user: { clientId: 'c1' } });
  fire(5, { kind: 'steered', user: { messageKey: 'k2', clientId: 'c2' } });
  fire(6, { kind: 'steered' });
  fire(7, { kind: 'turnEnd', turnId: 't' });
  await chats.get()!.settled(CHAT);
  assert.deepEqual(calls, [
    ['seen', CHAT, '', 'c1'],
    ['seen', CHAT, '', 'k2'],
    ['seen', CHAT, '', undefined],
    ['settle', CHAT],
  ]);
});
