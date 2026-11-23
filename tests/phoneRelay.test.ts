// Relay acknowledgements are correlated and retired sockets cannot deliver messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhoneRelay } from '../shared/remote/phoneRelay.mjs';

test('waits for hello, join and frame acknowledgements and ignores retired socket', async () => {
  const sockets: any[] = [],
    frames: any[] = [];
  const relay = createPhoneRelay({
    open: (_url, token) => {
      assert.equal(token, 'secret');
      const socket: any = {
        sent: [],
        send(text: string) {
          this.sent.push(JSON.parse(text));
        },
        close() {},
      };
      sockets.push(socket);
      return socket;
    },
    onFrame: (f) => frames.push(f),
    onEvent: () => {},
    onClose: () => {},
  });
  const connect = relay.connect('wss://relay.example/v1/ws', 'secret');
  const ws = sockets[0];
  ws.onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await connect;
  const auth = relay.authenticate('rotated');
  ws.onmessage({ data: JSON.stringify({ t: 'ok', rid: ws.sent[0].rid }) });
  await auth;
  const join = relay.join('p_12345678');
  ws.onmessage({ data: JSON.stringify({ t: 'ok', rid: ws.sent[1].rid }) });
  await join;
  const removed = relay.remove('p_12345678');
  assert.equal(ws.sent[2].t, 'pair.remove');
  ws.onmessage({ data: JSON.stringify({ t: 'ok', rid: ws.sent[2].rid }) });
  await removed;
  const send = relay.send({ pair: 'p_12345678', dir: 'p2m', ctr: 1 });
  ws.onmessage({ data: JSON.stringify({ t: 'ack', pair: 'p_12345678', dir: 'p2m', ctr: 1 }) });
  await send;
  relay.close();
  ws.onmessage({ data: JSON.stringify({ t: 'frame' }) });
  assert.deepEqual(frames, []);
});

test('relay close, failures, timeout and events retire pending operations', async () => {
  const sockets: any[] = [],
    events: any[] = [];
  let closed = 0;
  const relay = createPhoneRelay({
    timeoutMs: 5,
    open: () => {
      const ws: any = { send() {}, close() {} };
      sockets.push(ws);
      return ws;
    },
    onFrame: (v) => events.push(v),
    onEvent: (v) => events.push(v),
    onClose: () => {
      closed++;
    },
  });
  await assert.rejects(relay.join('p_12345678'), /disconnected/);
  const first = relay.connect('wss://example.com', 'token');
  relay.close();
  await assert.rejects(first, /disconnected/);
  const timed = relay.connect('wss://example.com', 'token');
  await assert.rejects(timed, /timed out/);
  const errored = relay.connect('wss://example.com', 'token');
  sockets.at(-1).onerror();
  await assert.rejects(errored, /failed/);
  const connected = relay.connect('wss://example.com', 'token');
  const ws = sockets.at(-1);
  ws.onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await connected;
  ws.onmessage({ data: 'bad json' });
  ws.onmessage({ data: JSON.stringify({ t: 'frame' }) });
  ws.onmessage({ data: JSON.stringify({ t: 'event' }) });
  assert.equal(events.length, 2);
  const pending = relay.send({ pair: 'p_12345678', dir: 'p2m', ctr: 1 });
  ws.onmessage({ data: JSON.stringify({ t: 'error', pair: 'p_12345678', ctr: 1, code: 'mailbox_full' }) });
  await assert.rejects(pending, /mailbox_full/);
  const redacted = relay.send({ pair: 'p_12345678', dir: 'p2m', ctr: 2 });
  ws.onmessage({ data: JSON.stringify({ t: 'error', pair: 'p_12345678', ctr: 2, code: 'secret-token' }) });
  await assert.rejects(redacted, /relay: error/);
  const timeout = relay.join('p_12345678');
  await assert.rejects(timeout, /timed out/);
  const pending2 = relay.join('p_12345678');
  ws.onclose();
  await assert.rejects(pending2, /disconnected/);
  assert.equal(closed, 1);
});

test('send failure and malformed oversized message are visible', async () => {
  let ws: any,
    closed = 0;
  const relay = createPhoneRelay({
    open: () =>
      (ws = {
        send() {
          throw new Error('send broke');
        },
        close() {},
      }),
    onFrame: () => {},
    onEvent: () => {},
    onClose: () => {
      closed++;
    },
  });
  const connected = relay.connect('wss://example.com', 'token');
  ws.onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await connected;
  await assert.rejects(relay.join('p_12345678'), /send broke/);
  ws.onmessage({ data: new Uint8Array() });
  assert.equal(closed, 1);
});

test('retired callbacks cannot close the replacement and early close rejects', async () => {
  const sockets: any[] = [];
  const relay = createPhoneRelay({
    open: () => {
      const ws = { close() {}, send() {} };
      sockets.push(ws);
      return ws;
    },
    onFrame: () => {},
    onEvent: () => {},
    onClose: () => {},
  });
  const old = relay.connect('wss://example.com', 'token');
  const newer = relay.connect('wss://example.com', 'token');
  await assert.rejects(old, /disconnected/);
  sockets[0].onerror();
  sockets[0].onclose();
  sockets[1].onclose();
  await assert.rejects(newer, /closed/);
});

test('push registration and removal ride the one authenticated socket and report whether it is open', async () => {
  const sockets: any[] = [];
  const relay = createPhoneRelay({
    open: () => {
      const socket: any = {
        sent: [] as any[],
        send(text: string) {
          this.sent.push(JSON.parse(text));
        },
        close() {},
      };
      sockets.push(socket);
      return socket;
    },
    onFrame: () => {},
    onEvent: () => {},
    onClose: () => {},
  });
  assert.equal(relay.connected(), false);
  const connect = relay.connect('wss://relay.example/v1/ws', 'secret');
  sockets[0].onmessage({ data: JSON.stringify({ t: 'hello' }) });
  await connect;
  assert.equal(relay.connected(), true);
  const register = relay.registerPush('fcm', 'tok');
  assert.deepEqual(sockets[0].sent[0], { t: 'push.register', platform: 'fcm', token: 'tok', rid: sockets[0].sent[0].rid });
  sockets[0].onmessage({ data: JSON.stringify({ t: 'ok', op: 'push.register', rid: sockets[0].sent[0].rid }) });
  await register;
  const unregister = relay.unregisterPush();
  assert.equal(sockets[0].sent[1].t, 'push.unregister');
  sockets[0].onmessage({ data: JSON.stringify({ t: 'error', code: 'forbidden', rid: sockets[0].sent[1].rid }) });
  await assert.rejects(unregister, /relay: forbidden/);
  const activity = relay.registerActivity('ab'.repeat(32));
  assert.deepEqual(sockets[0].sent[2], { t: 'activity.register', token: 'ab'.repeat(32), rid: sockets[0].sent[2].rid });
  sockets[0].onmessage({ data: JSON.stringify({ t: 'ok', op: 'activity.register', rid: sockets[0].sent[2].rid }) });
  await activity;
  const gone = relay.unregisterActivity();
  assert.equal(sockets[0].sent[3].t, 'activity.unregister');
  sockets[0].onmessage({ data: JSON.stringify({ t: 'error', code: 'forbidden', rid: sockets[0].sent[3].rid }) });
  await assert.rejects(gone, /relay: forbidden/);
  relay.close();
  assert.equal(relay.connected(), false);
});
