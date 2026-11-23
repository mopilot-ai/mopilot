// An authenticated connection to a Host (electron/host/hostSession.cjs): the proof before any request, replies matched by id, events handed to the listener, and every way the connection can end (B1, B2, A3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { openSession } = require('../electron/host/hostSession.cjs');
const frames = require('../shared/host/frames.mjs');

const identity = { publicKey: 'pk', sign: (purpose: string, hostId: string, nonce: string) => `${purpose}:${hostId}:${nonce}` };

class Sock extends EventEmitter {
  written: any[] = [];
  destroyed = false;
  write(b: Buffer) {
    this.written.push(frames.createDecoder().push(b)[0].message);
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
  say(msg: object) {
    this.emit('data', frames.encodeControl(msg));
  }
}
const tick = () => new Promise((r) => setImmediate(r));

/** A session whose proof the Host accepts (`accept`) or refuses. */
async function connected(t: any, o: { accept?: boolean; onEvent?: any; report?: any; helloMs?: number; callMs?: number } = {}) {
  const clock = installFakeClock(t, 1_000);
  const sock = new Sock();
  const opened = openSession({ socketPath: '/h.sock', identity, connect: () => sock, ...o });
  sock.emit('connect');
  await tick();
  sock.say({ id: 1, result: { nonce: 'n1', hostId: 'abababababababababababababababab' } });
  await tick();
  if (o.accept === false) sock.say({ id: 2, error: { message: 'no', code: 'unknown_client' } });
  else sock.say({ id: 2, result: { ok: 1 } });
  return { clock, sock, opened };
}

test('the proof goes first: a challenge, then auth with the signature; requests follow on the same connection', async (t) => {
  const { sock, opened } = await connected(t);
  const session = await opened;
  assert.deepEqual(sock.written[0], { id: 1, method: 'host.challenge' });
  assert.deepEqual(sock.written[1], {
    id: 2,
    method: 'host.auth',
    params: { publicKey: 'pk', nonce: 'n1', signature: 'auth:abababababababababababababababab:n1' },
  });
  const p = session.call('fs.list', { path: '/a' });
  assert.deepEqual(sock.written[2], { id: 3, method: 'fs.list', params: { path: '/a' } });
  sock.say({ id: 3, result: { entries: [] } });
  assert.deepEqual(await p, { entries: [] });
  session.close();
  assert.ok(sock.destroyed);
});

test('a Host that does not know this install refuses the session with its code, and the connection is dropped (B2)', async (t) => {
  const { sock, opened } = await connected(t, { accept: false });
  await assert.rejects(opened, (e: any) => e.code === 'unknown_client' && e.message === 'No.');
  assert.ok(sock.destroyed);
});

test('events reach the listener; a listener that throws, an unknown reply id and a binary frame change nothing (B1)', async (t) => {
  const seen: any[] = [];
  const reported: any[] = [];
  const { sock, opened } = await connected(t, {
    report: (e: any) => reported.push(e.message),
    onEvent: (e: any) => {
      seen.push(e);
      throw new Error('listener failed');
    },
  });
  const session = await opened;
  const p = session.call('git.clone', { key: 'k' }, { timeoutMs: 0 });
  sock.say({ event: 'progress', key: 'k', phase: 'Receiving objects', percent: 45 });
  sock.say({ id: 99, result: 'nobody waits' });
  sock.emit('data', frames.encodeBinary({ k: 1 }, Buffer.from('x')));
  sock.say({ id: 3, result: { path: '/p', existed: false } });
  assert.deepEqual(await p, { path: '/p', existed: false });
  assert.deepEqual(seen, [{ event: 'progress', key: 'k', phase: 'Receiving objects', percent: 45 }]);
  assert.deepEqual(reported, ['listener failed'], 'a failing listener is reported, not dropped silently');
});

test('an error reply carries its message and code; a bare string, a code beside it and an empty error all read (B1)', async (t) => {
  const { sock, opened } = await connected(t);
  const session = await opened;
  const ask = (reply: object) => {
    const p = session.call('x');
    sock.say({ id: sock.written.length, ...reply });
    return p;
  };
  await assert.rejects(
    ask({ error: { message: 'outside', code: 'outside_roots' } }),
    (e: any) => e.message === 'Outside.' && e.code === 'outside_roots',
  );
  await assert.rejects(ask({ error: 'plain' }), (e: any) => e.message === 'Plain.' && e.code === undefined);
  await assert.rejects(ask({ error: 7, code: 'c' }), (e: any) => e.code === 'c');
  await assert.rejects(ask({ error: {} }), /The machine refused/);
});

test('a call that is not answered in time fails, and a late answer changes nothing; timeoutMs 0 waits (B2)', async (t) => {
  const { clock, sock, opened } = await connected(t, { callMs: 5_000 });
  const session = await opened;
  const slow = session.call('fs.list', {});
  clock.advance(5_000);
  await assert.rejects(slow, { message: /did not answer/, code: 'host_unreachable' });
  sock.say({ id: 3, result: 'late' });
  const patient = session.call('git.clone', {}, { timeoutMs: 0 });
  clock.advance(10 * 60_000);
  sock.say({ id: 4, result: 'done' });
  assert.equal(await patient, 'done');
});

test('a connection that drops fails every request waiting on it, and a call after that is refused (B2, A3)', async (t) => {
  const { sock, opened } = await connected(t);
  const session = await opened;
  const a = session.call('a');
  const b = session.call('b', {}, { timeoutMs: 0 });
  sock.emit('error', new Error('ECONNRESET'));
  await assert.rejects(a, /ECONNRESET/);
  await assert.rejects(b, /ECONNRESET/);
  await assert.rejects(session.call('c'), /connection to the machine is closed/);
  session.close();
});

test('close() ends the connection and what is waiting; a Host that closes first says so', async (t) => {
  let r = await connected(t);
  let session = await r.opened;
  const waiting = session.call('git.clone', {}, { timeoutMs: 0 });
  session.close();
  await assert.rejects(waiting, /connection was closed/);
  r = await connected(t);
  session = await r.opened;
  const other = session.call('x');
  r.sock.emit('close');
  await assert.rejects(other, /closed the connection/);
});

test('something that is not a frame ends the connection (B2); a write that fails rejects its call and leaves nothing pending', async (t) => {
  let r = await connected(t);
  let session = await r.opened;
  const p = session.call('x');
  r.sock.emit('data', Buffer.from('this is not json\n'));
  await assert.rejects(p, /cannot read/);
  r = await connected(t);
  session = await r.opened;
  r.sock.write = () => {
    throw new Error('EPIPE');
  };
  await assert.rejects(session.call('y'), /EPIPE/);
});

test('a Host that never answers the proof is given up on, and one that closes before connecting is too (B2)', async (t) => {
  const clock = installFakeClock(t, 1_000);
  let sock = new Sock();
  let opened = openSession({ socketPath: '/h.sock', identity, connect: () => sock, helloMs: 3_000 });
  clock.advance(3_000);
  await assert.rejects(opened, { message: /did not answer/, code: 'host_unreachable' });
  assert.ok(sock.destroyed);
  sock = new Sock();
  opened = openSession({ socketPath: '/h.sock', identity, connect: () => sock });
  sock.emit('error', new Error('ENOENT'));
  await assert.rejects(opened, /closed the connection|ENOENT/);
});

test('the default connect dials the socket path (no injected connect)', async (t) => {
  installFakeClock(t, 1_000);
  const opened = openSession({ socketPath: '/definitely/not/a/socket', identity });
  await assert.rejects(opened);
});

test('without a listener or a reporter an event, a throwing listener and a reply with no id change nothing', async (t) => {
  const { sock, opened } = await connected(t);
  const session = await opened;
  sock.say({ event: 'progress' });
  sock.say({ result: 'no id' });
  const p = session.call('x');
  sock.say({ id: 3, result: 1 });
  assert.equal(await p, 1);
  const thrown = await connected(t, {
    onEvent: () => {
      throw new Error('boom');
    },
  });
  const second = await thrown.opened;
  thrown.sock.say({ event: 'progress' });
  second.close();
});

test("a refusal keeps what the caller acts on: the chat's current epoch and where a handed-over chat went", async (t) => {
  const { sock, opened } = await connected(t);
  const session = await opened;
  const p = session.call('chat.commitContinue', {});
  sock.say({ id: 3, error: 'handed over', code: 'chat_released', details: { targetHostId: 'b', epoch: 2 }, current: 2 });
  await assert.rejects(p, (e: any) => e.code === 'chat_released' && e.details.epoch === 2 && e.current === 2);
  const q = session.call('chat.commitContinue', {});
  sock.say({ id: 4, error: 'plain', details: 'not an object', current: 'x' });
  await assert.rejects(q, (e: any) => e.details === undefined && e.current === undefined);
});
