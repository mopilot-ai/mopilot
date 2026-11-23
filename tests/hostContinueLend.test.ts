// What a chat continued on a machine lends with its first message (#4906): the agent it was continued on, not the one its id spells (electron/host/hostContinue.cjs `kept`, wiring.cjs `keepAgent`/`kindOfChat`, remoteCredentials.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CHAT, connect, key, req, world } from './support/hostServiceKit.ts';

const require = createRequire(import.meta.url);
const { withCredentials, NO_ORG } = require('../electron/host/remoteCredentials.cjs');
const { deliverRemote } = require('../electron/host/remoteSendDelivery.cjs');
const { keepAgent, kindOfChat } = require('../electron/host/wiring.cjs');

const ID = 'codex:3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c';
const KEYS: Record<string, string> = { codex: 'sk-openai-codex-00000000000000', gemini: 'AIza-gemini-0000000000000000' };

/** main's `live` as far as a chat's config and its kind go: the controller reads the chat by its id, the config is what `keepAgent` writes. */
function live() {
  const config: Record<string, any> = {};
  const broadcasts: any[] = [];
  const chats = {
    record: () => ({ meta: { config } }),
    get: () => ({ meta: { config } }),
    patchMeta: (_id: string, patch: any) => {
      if (config.hostAgent === patch.config.hostAgent) return false;
      Object.assign(config, patch.config);
      return true;
    },
  };
  return {
    deps: { live: { chats }, broadcastAll: (...a: any[]) => void broadcasts.push(a) },
    live: { chats, controller: { ref: () => ({ kind: 'codex' }) } },
    config,
    broadcasts,
  };
}

/** The first message of the continued chat, delivered as the outbox does, through the wrapped connection of the machine. */
async function firstMessage(kindOf: (chatId: string) => string | undefined) {
  const told: any[] = [];
  const remote: any = {
    modelKey: async (p: any) => void told.push(['modelKey', p.harness, p.key]),
    send: async (chatId: string, item: any) => (told.push(['send', chatId, item.lendAs]), { result: {} }),
    permit: async () => undefined,
  };
  const host = withCredentials(remote, { forHarness: (h: string) => KEYS[h] ?? null, hasFor: (h: string) => h in KEYS }, NO_ORG);
  const entry = {
    chatId: ID,
    key: 'key-lend-00000001',
    epoch: 1,
    state: 'queued',
    options: { item: { text: 'go', attachments: [], opts: {} } },
  };
  await deliverRemote(entry, { hostId: 'B', epoch: 1, folder: '/srv' }, host, {
    checks: { validate: async () => undefined },
    subscribed: async () => undefined,
    disposed: () => false,
    outbox: { pending: () => [{ key: entry.key, state: 'queued' }] },
    ownerOf: () => ({ hostId: 'B', epoch: 1, folder: '/srv' }),
    state: () => ({ get: () => undefined }),
    projection: { remember: () => undefined, forget: () => undefined },
    hostFor: () => host,
    kindOf,
  });
  return told;
}

test('A: a chat whose id spells Codex and that was continued on another agent lends that agent’s key with its first message', async () => {
  const l = live();
  const w = world({ harness: 'acp:gemini', kept: (chatId, harness) => keepAgent(l.deps, chatId, harness) });
  w.ownership.set(ID, { hostId: 'local', ownerHostId: 'local', epoch: 0, folder: '/mac/app' });
  assert.deepEqual(await w.service.run(req({ chatId: ID })), { hostId: 'B', epoch: 1 });
  assert.equal(kindOfChat(l.live, ID), 'acp:gemini');
  assert.deepEqual(
    (await firstMessage((id) => kindOfChat(l.live, id))).map((t) => t.slice(0, 3)),
    [
      ['modelKey', 'gemini', KEYS.gemini],
      ['send', ID, 'acp:gemini'],
    ],
  );
  assert.equal(l.broadcasts.length, 1, 'the windows are told, so the picker follows the agent');
  assert.deepEqual(l.broadcasts[0][0], 'chats:changed');
  // the same chat read without what the continue kept is the one the id spells
  assert.deepEqual((await firstMessage(() => 'codex')).map((t) => t[1]).slice(0, 1), ['codex']);
});

test('I: the agent is kept in the wire’s spelling, only for a chat that went to a machine, and a repeat tells no window', async () => {
  const l = live();
  const kept: string[][] = [];
  const mac = world({ harness: 'acp:gemini', kept: (c, h) => void kept.push([c, h]) });
  await mac.service.run(req());
  assert.deepEqual(kept, [[CHAT, 'acp:gemini']]);
  // continuing back to this Mac keeps nothing: the chat is no machine chat there
  const b = await connect(mac.hosts.B);
  await b.conn.call('chat.send', { chatId: CHAT, epoch: 1, key: key(), text: 'a question on B' });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-back-'));
  await mac.service.run(req({ targetHostId: 'local', cwd: folder }));
  assert.equal(kept.length, 1);
  // a record that cannot be written does not undo the continue
  const broken = world({
    harness: 'acp:gemini',
    kept: () => {
      throw new Error('no record');
    },
  });
  assert.deepEqual(await broken.service.run(req()), { hostId: 'B', epoch: 1 });
  assert.ok(broken.problems.some((p) => /could not be kept: no record/.test(p)));
  keepAgent(l.deps, ID, 'codex');
  keepAgent(l.deps, ID, 'codex');
  keepAgent({ live: {}, broadcastAll: () => undefined }, ID, 'codex');
  assert.equal(l.broadcasts.length, 1);
});
