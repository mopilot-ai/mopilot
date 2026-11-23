// A restarted Host must serve the same durable chat history and cursor to a second device, without replaying live token deltas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { helloParams } from '../shared/host/schema.mjs';

function hostAt(dataDir: string) {
  const bus: any = new EventEmitter();
  bus.cancel = () => undefined;
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dataDir, 'epochs.json'), quiet);
  const protocol = createProtocol({
    runtime: { host: bus, send: async () => ({ turnId: 't1' }), permit: () => true },
    epochs,
    guard: createGuard({ epochs, ledger: createLedger(path.join(dataDir, 'ledger'), quiet) }),
    status: () => ({}),
    dataDir,
  } as any);
  const open = async (extra: object = {}, features = helloParams().features) => {
    const frames: any[] = [];
    const conn = protocol.connection((m: any) => {
      if (m.frame) frames.push(m.frame);
    });
    await conn.call('host.hello', { ...helloParams(), features });
    await conn.call('chat.subscribe', { chatId: 'acp:kimi:durable', epoch: 1, ...extra });
    return { frames, conn };
  };
  return { bus, open };
}

test('a second device after a restart reads committed history with a stable generation and a newer sequence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-durable-history-'));
  const first = hostAt(dir);
  const early = await first.open();
  first.bus.emit('event', { kind: 'turnStart', key: 'acp:kimi:durable', turnId: 't1' });
  first.bus.emit('event', { kind: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'kept' } } });
  first.bus.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  const before = (await first.open()).frames[0];
  const second = hostAt(dir);
  const after = (await second.open()).frames[0];
  assert.deepEqual(after.snapshot, before.snapshot, 'a restarted Host must not replace acknowledged history with an empty snapshot');
  assert.equal(after.generation, before.generation);
  assert.ok(after.seq >= early.frames.at(-1).seq);
  assert.deepEqual(after.inFlightEphemeral, []);
  const resumed = (await second.open({ fromRev: 0, generation: before.generation })).frames;
  assert.equal(resumed[0].snapshot, null);
  assert.deepEqual(
    resumed.slice(1).map((f: any) => f.item),
    before.snapshot.items,
  );
  assert.ok(resumed.slice(1).every((f: any) => f.t === 'durable'));
});

test('an older app reads the same persisted ACP history without stream2 metadata, and the current app still gets state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-journal-skew-'));
  const first = hostAt(dir);
  const legacy = await first.open(
    {},
    helloParams().features.filter((f: string) => !['stream2', 'family'].includes(f)),
  );
  first.bus.emit('event', { kind: 'threadName', key: 'acp:kimi:durable', name: 'Saved title' });
  first.bus.emit('event', { kind: 'turnStart', key: 'acp:kimi:durable', turnId: 't1' });
  first.bus.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  assert.ok(legacy.frames.every((f) => f.t !== 'state'));
  const restarted = hostAt(dir);
  const old = (
    await restarted.open(
      {},
      helloParams().features.filter((f: string) => f !== 'stream2'),
    )
  ).frames[0];
  assert.ok(old.snapshot.items.length > 0);
  assert.equal('chatState' in old, false);
  const modern = (await restarted.open()).frames[0];
  assert.equal(modern.chatState.title.name, 'Saved title');
  assert.equal(modern.generation, old.generation);
});
