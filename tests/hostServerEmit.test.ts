// What the Host's server writes to a client (host/src/server.mjs `emit`): a message over one wire frame is not sent (the Mac would refuse it and drop the connection), and a client that does not read is cut off instead of being buffered for without end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from '../host/src/paths.mjs';
import { MAX_UNSENT, startServer } from '../host/src/server.mjs';
import { MAX_FRAME } from '../shared/host/frames.mjs';

/** A server whose protocol hands each connection's `emit` to the test. */
async function world(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = createPaths({ dataDir: dir, env: {} });
  const emits: ((m: object) => unknown)[] = [];
  const protocol: any = {
    connection: (emit: (m: object) => unknown) => (emits.push(emit), { call: async () => ({}), close: () => undefined }),
  };
  const server = await startServer({ paths, protocol });
  t.after(() => server.close());
  const client = net.connect(paths.socketPath);
  t.after(() => client.destroy());
  await new Promise((resolve) => client.once('connect', resolve));
  // the server has made its connection once the client can be told anything
  while (emits.length === 0) await new Promise((r) => setTimeout(r, 5));
  return { emit: emits[0], client };
}

test('M4: a message over a wire frame is not sent, the next one is, and the connection stays', async (t) => {
  const { emit, client } = await world(t);
  const got: string[] = [];
  client.setEncoding('utf8').on('data', (d) => got.push(String(d)));
  assert.equal(emit({ event: 'browser', payload: 'x'.repeat(MAX_FRAME + 1) }), false);
  assert.equal(emit({ event: 'ok' }), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got.join(''), '{"event":"ok"}\n');
  assert.equal(client.destroyed, false);
});

test('M4: a client that never reads is cut off once too much waits for it; a closed one is simply not written to', async (t) => {
  const { emit, client } = await world(t);
  client.pause();
  const piece = { event: 'frame', payload: 'x'.repeat(MAX_FRAME - 100) };
  const closed = new Promise((resolve) => client.once('close', resolve));
  // write returns false from the first big message on (back-pressure); the cut comes when what waits passes the limit
  for (let i = 0; i < Math.ceil(MAX_UNSENT / (MAX_FRAME - 100)) + 8; i++) emit(piece);
  // a paused client sees the close only once it reads what already reached it
  client.resume();
  await closed;
  assert.equal(emit({ event: 'late' }), false, 'a socket that is gone is not written to');
});
