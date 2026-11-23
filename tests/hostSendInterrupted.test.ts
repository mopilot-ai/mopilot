// A chat write the Host started and never settled before it restarted is not an answer (host/src/protocol.mjs, electron/host/remoteSend.cjs): the app keeps the message, marked, instead of taking it for delivered (B2, A5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

const quiet = { report: () => undefined };
const life = (dir: string, send: (p: any) => Promise<unknown>) => {
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: new EventEmitter(), send };
  return createProtocol({ runtime, epochs, guard, status: () => ({ running: true }) }).connection(() => undefined);
};

test('a send that started in an earlier life of the Host is refused as interrupted, never answered as done, and never run again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-interrupted-'));
  const params = { chatId: 'claude:c1', epoch: 1, key: 'key-00000001', text: 'hi' };
  const first = life(dir, () => new Promise(() => undefined));
  await first.call('host.hello', helloParams());
  void first.call('chat.send', params).catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  // the Host dies here; the next life opens the same files
  const sends: any[] = [];
  const second = life(dir, async (p) => (sends.push(p), { turnId: 't1' }));
  await second.call('host.hello', helloParams());
  await assert.rejects(second.call('chat.send', params), (e: any) => e.code === 'request_interrupted');
  assert.equal(sends.length, 0, 'not run again');
  // a new key is a new request
  assert.deepEqual((await second.call('chat.send', { ...params, key: 'key-00000002' })).result, { turnId: 't1' });
});
