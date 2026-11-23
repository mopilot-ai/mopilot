// electron/session/peerRuntime.cjs adds its controller hooks beside the ones already there: the turn-end ledger's
// onFinished kept running after the peer service started (it used to be replaced), and a Stop whose pause can't be
// saved still reaches the controller as a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { PeerRuntime } = require('../electron/session/peerRuntime.cjs');

function setup(t: any, write?: () => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const order: string[] = [];
  const controller: any = {
    rt: () => ({ token: null }),
    state: { get: () => ({ turn: 'idle', queue: [] }) },
    send: () => ({ action: 'queued' }),
    peerCapabilities: () => ({ messaging: true, read: true, steer: false }),
    removeQueued: () => {},
    // the turn-end ledger's hooks, set when the controller is made (electron/app/sessions.cjs)
    onFinished: (e: any) => order.push(`ledger finished ${e.chatId}`),
    onStopped: (id: string) => order.push(`ledger stopped ${id}`),
    beforeDispatch: async () => order.push('earlier dispatch'),
    onDispatchResult: async () => order.push('earlier result'),
  };
  const runtime = new PeerRuntime({
    file: path.join(dir, 'journal.json'),
    controller,
    chats: { records: new Map([['A', { segments: [{ kind: 'codex', nativeId: 'A' }], meta: {} }]]) },
    registry: new Registry(),
    sourceWindow: () => null,
    gate: () => null,
    title: () => null,
    read: () => ({}),
    publish: () => {},
  });
  if (write) runtime.service.write = write;
  return { runtime, controller, order };
}

test('the turn-end ledger’s onFinished and onStopped still run once the peer service has added its own', async (t) => {
  const { controller, order, runtime } = setup(t);
  await controller.onFinished({ chatId: 'A', inputToken: null, turnId: null, text: null, completed: false });
  controller.onStopped('A');
  assert.deepEqual(order, ['ledger finished A', 'ledger stopped A']);
  assert.ok(runtime.paused.has('A'), 'the peer service paused the stopped chat too');
  await controller.beforeDispatch({ chatId: 'A', kind: 'turn', item: { id: 'x', opts: {} }, ref: {} });
  await controller.onDispatchResult({ chatId: 'A', item: { id: 'x', opts: {} }, result: { started: true } });
  assert.deepEqual(order.slice(2), ['earlier dispatch', 'earlier result']);
});

test('a Stop whose pause can’t be saved is still reported to the controller after the ledger ran', (t) => {
  const { controller, order } = setup(t, () => {
    throw new Error('disk full');
  });
  assert.throws(() => controller.onStopped('A'), /disk full/);
  assert.deepEqual(order, ['ledger stopped A']);
});
