// The end of an authenticated Host connection (electron/host/hostSession.cjs) is told to its event listener once, however it ended, so a listener that keeps something from the connection (the chat index) learns it is gone; a listener that throws is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const { openSession } = require('../electron/host/hostSession.cjs');
const frames = require('../shared/host/frames.mjs');

const identity = { publicKey: 'pk', sign: () => 'sig' };
class Sock extends EventEmitter {
  written: any[] = [];
  write(b: Buffer) {
    this.written.push(frames.createDecoder().push(b)[0].message);
  }
  destroy() {
    this.emit('close');
  }
  say(msg: object) {
    this.emit('data', frames.encodeControl(msg));
  }
}
async function open(onEvent: (e: any) => void, report?: (e: unknown) => void) {
  const sock = new Sock();
  const opened = openSession({ socketPath: '/h.sock', identity, connect: () => sock, onEvent, ...(report ? { report } : {}) });
  sock.emit('connect');
  await waitFor(() => sock.written.length === 1, 'the challenge');
  sock.say({ id: 1, result: { nonce: 'n', hostId: 'abababababababababababababababab' } });
  await waitFor(() => sock.written.length === 2, 'the proof');
  sock.say({ id: 2, result: { ok: 1 } });
  return { sock, session: await opened };
}

test('a connection the Host drops, and one the caller closes, each tell the listener once; other events still arrive', async () => {
  const heard: any[] = [];
  const dropped = await open((e) => heard.push(e));
  dropped.sock.say({ event: 'chats', seq: 1 });
  dropped.sock.destroy();
  dropped.sock.destroy();
  assert.deepEqual(heard, [
    { event: 'chats', seq: 1 },
    { event: 'connection.closed', reason: 'The machine closed the connection.' },
  ]);
  const closing: any[] = [];
  const closed = await open((e) => closing.push(e));
  closed.session.close();
  assert.deepEqual(closing, [{ event: 'connection.closed', reason: 'The connection was closed.' }]);
});

test('a listener that throws when the connection ends is reported, not thrown', async () => {
  const reported: unknown[] = [];
  const { session } = await open(
    () => {
      throw new Error('listener broke');
    },
    (e) => reported.push(e),
  );
  session.close();
  assert.equal((reported[0] as Error).message, 'listener broke');
});
