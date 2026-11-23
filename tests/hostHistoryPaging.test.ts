// A second authenticated protocol client reads every committed item after restart through bounded pages, including text larger than a wire frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createChatLog } from '../host/src/chatLog.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { MAX_FRAME } from '../shared/host/frames.mjs';
const quiet = { report() {} };
function reopened(dataDir: string) {
  const bus: any = new EventEmitter();
  bus.cancel = () => undefined;
  const epochs = createEpochStore(path.join(dataDir, 'epochs.json'), quiet);
  const protocol = createProtocol({
    dataDir,
    runtime: { host: bus, send: async () => ({ turnId: 'unused' }), permit: () => true },
    epochs,
    guard: createGuard({ epochs, ledger: createLedger(path.join(dataDir, 'ledger'), quiet) }),
    status: () => ({}),
  });
  const frames: any[] = [];
  const conn = protocol.connection((m: any) => {
    if (m.frame) frames.push(m.frame);
  });
  return { conn, frames };
}
test('second device after Host restart reads all pages without clipping a large earlier message', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createChatLog({ dataDir: dir, epoch: () => 1 });
  const items = [
    { t: 'user', turnId: 't1', text: 'oldest 🦊 ' + 'x'.repeat(MAX_FRAME) },
    { t: 'assistant', turnId: 't1', text: 'last' },
  ];
  for (const item of items) log.finish('c', item);
  const { conn, frames } = reopened(dir);
  await conn.call('host.hello', helloParams());
  await conn.call('chat.subscribe', { chatId: 'c', epoch: 1 });
  const hello = frames[0];
  let cursor = { index: 0, offset: 0 },
    raw = '',
    pages = 0;
  do {
    const page = await conn.call('chat.history', { chatId: 'c', epoch: 1, generation: hello.generation, rev: hello.rev, ...cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < MAX_FRAME);
    raw += page.chunk;
    cursor = page.next;
    pages++;
  } while (cursor);
  assert.ok(pages > 1, 'full history must be paged rather than forced into one frame');
  assert.deepEqual(
    raw
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line)),
    items,
  );
  conn.close();
});
