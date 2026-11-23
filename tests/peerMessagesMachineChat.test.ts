// A peer message to a chat that runs on another machine fails in the sender's record and starts nothing on this Mac (#4738).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { PeerMessageService } = require('../electron/session/peerMessages.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { createPeerGate } = require('../electron/session/peerGate.cjs');

test('a message to a chat that runs on another machine is blocked as running elsewhere, and nothing starts on this Mac', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-machine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map([
    ['A', { segments: [{ kind: 'codex', nativeId: 'native-A' }] }],
    ['B', { segments: [{ kind: 'acp:host-claude', nativeId: 'native-B' }] }],
  ]);
  const state = new SessionStore();
  const started: string[] = [];
  const startTurn = async (chatId: string) => (started.push(chatId), { started: true });
  let service: any;
  const controller = new ChatController({
    state,
    chats: { records, record: (id: string) => records.get(id) },
    codex: { startTurn, steer: startTurn, peerCapabilities: () => ({ steer: true }) },
    acpTurns: { startTurn, peerCapabilities: () => ({ steer: false }) },
    beforeDispatch: (e: any) => service.beforeDispatch(e),
    onDispatchResult: (e: any) => service.result(e),
    onFinished: (e: any) => service.finished(e),
  });
  controller.remote = { stop: () => null, owns: (chatId: string) => chatId === 'B' };
  service = new PeerMessageService({
    file: path.join(dir, 'journal.json'),
    controller,
    exists: (id: string) => records.has(id),
    authorize: () => true,
    // main's wiring (electron/app/sessions.cjs): the gate asks the controller whether the chat runs on a machine
    gate: createPeerGate({
      record: (id: string) => records.get(id),
      state: (id: string) => state.get(id),
      ref: () => ({ kind: 'acp:host-claude' }),
      availability: () => null,
      goalStatus: () => null,
      remote: controller.remote,
    }),
  });
  const m = await service.send('A', { targetChatId: 'B', requestId: 'request-1', body: 'Review the schema' });
  await tick();
  assert.equal(service.get('A', m.id).delivery, 'blocked');
  assert.equal(service.get('A', m.id).errorCode, 'running_elsewhere');
  assert.deepEqual(started, []);
  assert.deepEqual(state.get('B').queue, []);
});
