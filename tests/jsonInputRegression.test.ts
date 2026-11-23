// Growing fragmented app-server messages must not repeatedly scan their already-read prefix.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AppServer } = require('../electron/harness/codexProcess.cjs');

test('a fragmented app-server record scans input linearly and delivers it exactly once', async () => {
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {}, write() {} });
  const proc = Object.assign(new EventEmitter(), { stdin: stream(), stdout: stream(), stderr: stream(), kill() {} });
  const server = new AppServer({ findBin: () => 'synthetic', env: () => ({}), spawn: () => proc });
  server.start();
  const payload = { id: 1, result: { text: 'x'.repeat(128 * 1024) } };
  const wire = JSON.stringify(payload) + '\n';
  const seen: unknown[] = [];
  let delivered!: () => void;
  const done = new Promise<void>((resolve) => (delivered = resolve));
  server.listeners.add((event: any) => {
    if (event.kind === 'message') {
      seen.push(event.msg);
      delivered();
    }
  });
  const nativeIndexOf = String.prototype.indexOf;
  let searched = 0;
  const spy = mock.method(String.prototype, 'indexOf', function (this: string, search: string, from = 0) {
    if (search === '\n') searched += this.length - from;
    return nativeIndexOf.call(this, search, from);
  });
  try {
    for (let offset = 0; offset < wire.length; offset += 1024) proc.stdout.emit('data', wire.slice(offset, offset + 1024));
  } finally {
    spy.mock.restore();
  }
  await done;
  assert.deepEqual(seen, [payload]);
  assert.ok(searched <= wire.length * 2, `newline searches examined ${searched} units for ${wire.length} input units`);
  server.stop();
});
