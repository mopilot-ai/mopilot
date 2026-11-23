// The Host socket server and a continue: an unpaired client can neither prepare, commit or release a chat nor poison this Host's copies with a hello (server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
// @ts-ignore
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

test('unpaired clients are refused the continue methods and a hello that names moved chats; a plain hello still works', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-server-'));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const runtime: any = { host: new EventEmitter(), send: async () => ({ turnId: 't' }) };
  const protocol = createProtocol({
    runtime,
    epochs,
    guard: createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) }),
    status: () => ({}),
  });
  const paths = { dataDir: dir, socketPath: path.join(dir, 's.sock'), lockPath: path.join(dir, 'l.lock') };
  const server = await startServer({ paths, runtime, protocol, pairing: {} as any });
  t.after(() => server.close());
  const chatId = 'claude:c1';
  for (const method of ['chat.prepareContinue', 'chat.commitContinue', 'chat.release'])
    assert.equal(((await callHost(paths.socketPath, method, { chatId }, { anonymous: true })) as any)?.code, 'unknown_client', method);
  const moved = [{ chatId, epoch: 1, targetHostId: 'b' }];
  assert.equal(
    ((await callHost(paths.socketPath, 'host.hello', { ...helloParams(), moved }, { anonymous: true })) as any)?.code,
    'unknown_client',
  );
  assert.ok((await callHost(paths.socketPath, 'host.hello', helloParams()))?.result?.agreed);
  assert.ok((await callHost(paths.socketPath, 'host.hello', { ...helloParams(), moved: [] }))?.result?.agreed);
});
