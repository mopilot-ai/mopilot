// The tool relay (host/src/toolRelay.mjs, shared/host/toolRelay.mjs): a tool call of a Host-resident harness goes to the app that owns the chat and its answer comes back; nothing hangs when the app is absent, goes away, answers late or is stopped (W: wrong app, A: stop/timeout/disconnect, B: malformed requests, I: gates and pairing).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createPairing } from '../host/src/pairing.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { startServer } from '../host/src/server.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { createToolRelay } from '../host/src/toolRelay.mjs';
import { createHostTools } from '../host/src/tools.mjs';
import { timers } from './support/fake-chromium.ts';
import { line } from './support/host-line.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const S = require('../shared/host/schema.mjs');
const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-relay-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const quiet = { report: () => undefined };

const spec = (name: string, policy: 'observe' | 'act' | 'irreversible' = 'act') => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  policy,
});
const text = (t: string) => ({ type: 'text', text: t });

/** A relay over a real registry, with an app that records what it is sent. */
function world(o: { timeoutMs?: number } = {}) {
  const registry = new Registry();
  // the call's timeout is a fake timer that fires when a test says so, never because the machine was slow
  const clock = timers();
  const relay = createToolRelay({
    registry,
    timeoutMs: o.timeoutMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    newId: (() => {
      let n = 0;
      return () => `call-${++n}`;
    })(),
  });
  const app = (extra: { fail?: boolean } = {}) => {
    const sent: any[] = [];
    const conn = relay.attach(
      (m: any) => {
        if (extra.fail) throw new Error('socket closed');
        sent.push(m);
      },
      () => 7,
    );
    return { conn, sent };
  };
  return { registry, relay, app, clock };
}

test('B: tool lists and results are checked before they reach the Host', () => {
  assert.ok(S.FEATURES.includes('tools'));
  assert.deepEqual(S.REQUIRES['host.toolsSync'], ['tools']);
  assert.deepEqual(S.REQUIRES['host.toolResult'], ['tools']);
  const sync = (tools: unknown) => S.parseParams('host.toolsSync', { tools });
  assert.deepEqual(sync([]), { tools: [] });
  assert.deepEqual(sync([{ name: 'browser_open', policy: 'act', extra: 1 }]).tools[0], {
    name: 'browser_open',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    policy: 'act',
  });
  const bad = (fn: () => unknown) => assert.throws(fn, (e: any) => e instanceof S.SchemaError);
  bad(() => S.parseParams('host.toolsSync', {}));
  bad(() => sync(Array.from({ length: 257 }, (_, i) => ({ name: `t${i}`, policy: 'act' }))));
  bad(() => sync(['x']));
  bad(() => sync([{ name: 'a b', policy: 'act' }]));
  bad(() => sync([{ name: 'a', policy: 'maybe' }]));
  bad(() =>
    sync([
      { name: 'a', policy: 'act' },
      { name: 'a', policy: 'act' },
    ]),
  );
  bad(() => sync([{ name: 'a', policy: 'act', description: 3 }]));
  bad(() => sync([{ name: 'a', policy: 'act', description: 'x'.repeat(9000) }]));
  bad(() => sync([{ name: 'a', policy: 'act', inputSchema: 'x' }]));
  bad(() => sync([{ name: 'a', policy: 'act', inputSchema: { big: 'x'.repeat(70000) } }]));

  const result = (r: object) => S.parseParams('host.toolResult', { chatId: 'acp:fake:a', epoch: 3, callId: 'c1', ...r });
  assert.deepEqual(
    result({ ok: true, content: [text('hi'), { type: 'image', data: 'AAAA', mimeType: 'image/png', extra: 1 }], endsTurn: true }),
    {
      chatId: 'acp:fake:a',
      epoch: 3,
      callId: 'c1',
      ok: true,
      content: [text('hi'), { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      endsTurn: true,
    },
  );
  assert.equal(result({ ok: true, content: [] }).endsTurn, undefined);
  assert.deepEqual(result({ ok: false, content: [], error: { code: 'denied', message: 'No.' }, endsTurn: true }).error, {
    code: 'denied',
    message: 'No.',
  });
  bad(() => S.parseParams('host.toolResult', { callId: 'c1', epoch: 3, ok: true, content: [] }));
  bad(() => S.parseParams('host.toolResult', { chatId: 'acp:fake:a', callId: 'c1', ok: true, content: [] }));
  bad(() => result({ callId: 'a b', ok: true, content: [] }));
  bad(() => result({ ok: 'yes', content: [] }));
  bad(() => result({ ok: true }));
  bad(() => result({ ok: true, content: Array.from({ length: 65 }, () => text('x')) }));
  bad(() => result({ ok: true, content: [{ type: 'video' }] }));
  // one result is at most a frame: a 2 MB screenshot passes, a result over the frame does not
  assert.equal(result({ ok: true, content: [{ type: 'image', data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' }] }).ok, true);
  bad(() => result({ ok: true, content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }] }));
  bad(() =>
    result({
      ok: true,
      content: [
        { type: 'text', text: 'x'.repeat(5 * 1024 * 1024) },
        { type: 'image', data: 'A'.repeat(4 * 1024 * 1024), mimeType: 'image/png' },
      ],
    }),
  );
  bad(() => result({ ok: true, content: [{ type: 'image', data: 'AA', mimeType: 'text/html' }] }));
  bad(() => result({ ok: false, content: [] }));
  bad(() => result({ ok: false, content: [], error: { code: '', message: 'x' } }));
  bad(() => result({ ok: false, content: [], error: { code: 'x', message: 3 } }));
});

test('an announced tool is a registry tool; a call goes to the chat’s app and its answer is the result', async () => {
  const w = world();
  const a = w.app();
  const c = a.conn;
  const synced = c.sync([spec('browser_open'), spec('browser_read', 'observe')]);
  assert.deepEqual(synced, { registered: ['browser_open', 'browser_read'], skipped: [] });
  assert.deepEqual(
    w.registry.list({ all: true }).map((t: any) => t.name),
    ['browser_open', 'browser_read'],
  );
  c.send('acp:fake:a');
  // an act tool runs without the Host asking anybody: the app runs its own policy
  const done = w.registry.invoke('acp:fake:a', 'seg1', 'browser_open', { url: 'https://example.com' });
  await until(() => a.sent.length);
  assert.deepEqual(a.sent[0], {
    event: 'tool',
    chatId: 'acp:fake:a',
    epoch: 7,
    segmentId: 'seg1',
    callId: 'call-1',
    name: 'browser_open',
    arguments: { url: 'https://example.com' },
  });
  assert.equal(w.relay.pending, 1);
  assert.deepEqual(c.result({ chatId: 'acp:fake:a', callId: 'call-1', ok: true, content: [text('opened')] }), { accepted: true });
  const res = await done;
  assert.deepEqual([res.ok, res.content], [true, [text('opened')]]);
  assert.equal(w.relay.pending, 0);
  // the answer that ends the agent's turn says so
  const ends = w.registry.invoke('acp:fake:a', 'seg1', 'browser_read', {});
  await until(() => a.sent.length === 2);
  c.result({ chatId: 'acp:fake:a', callId: 'call-2', ok: true, content: [text('done')], endsTurn: true });
  assert.equal((await ends).endsTurn, true);
  // an answer that arrives twice, or after the call ended, is acknowledged and changes nothing
  assert.deepEqual(c.result({ chatId: 'acp:fake:a', callId: 'call-2', ok: true, content: [] }), { accepted: false });
});

test('the app’s refusal keeps its code and message', async () => {
  const w = world();
  const a = w.app();
  a.conn.sync([spec('browser_open')]);
  a.conn.send('c1');
  const done = w.registry.invoke('c1', 's', 'browser_open', {});
  await until(() => a.sent.length);
  a.conn.result({
    chatId: 'c1',
    callId: 'call-1',
    ok: false,
    content: [],
    error: { code: 'denied', message: 'The user did not allow this action' },
  });
  const res = await done;
  assert.deepEqual([res.ok, res.error], [false, { code: 'denied', message: 'The user did not allow this action' }]);
});

test('A: with no app for the chat, or an app that went away, the call is refused at once, not left waiting', async () => {
  const w = world();
  const a = w.app();
  a.conn.sync([spec('browser_open')]);
  const none = await w.registry.invoke('nobody', 's', 'browser_open', {});
  assert.deepEqual([none.ok, none.error.code], [false, 'app_offline']);
  assert.match(none.error.message, /not connected/);
  // a connection that can no longer be written to
  const broken = w.app({ fail: true });
  broken.conn.send('c2');
  const lost = await w.registry.invoke('c2', 's', 'browser_open', {});
  assert.equal(lost.error.code, 'app_offline');
  assert.equal(w.relay.pending, 0);
  // the app disconnected: its chats are nobody's again and its tools go
  a.conn.send('c3');
  a.conn.detach();
  const gone = await w.registry.invoke('c3', 's', 'browser_open', {});
  assert.equal(gone.error.code, 'unknown_tool');
  assert.deepEqual(w.registry.list({ all: true }), []);
});

test('A: a call waiting for the app ends when the app disconnects, is stopped, or times out, and the app is told', async () => {
  const w = world({ timeoutMs: 80 });
  const a = w.app();
  a.conn.sync([spec('browser_open')]);
  a.conn.send('c1');

  const dropped = w.registry.invoke('c1', 's', 'browser_open', {});
  await until(() => a.sent.length === 1);
  const b = w.app();
  b.conn.sync([spec('browser_open')]);
  b.conn.send('c1');
  a.conn.detach();
  assert.equal((await dropped).error.code, 'app_offline');
  assert.match((await dropped).error.message, /disconnected/);

  // Stop: the registry aborts the chat's calls
  const stopped = w.registry.invoke('c1', 's', 'browser_open', {});
  await until(() => b.sent.length === 1);
  w.relay.abortChat('c1');
  assert.equal((await stopped).error.code, 'aborted');
  assert.deepEqual(b.sent[1], { event: 'toolCancel', chatId: 'c1', epoch: 7, callId: 'call-2' });

  // the harness cancelling that one call
  const ac = new AbortController();
  const cancelled = w.registry.invoke('c1', 's', 'browser_open', {}, { signal: ac.signal });
  await until(() => b.sent.length === 3);
  ac.abort();
  assert.equal((await cancelled).error.code, 'aborted');
  assert.equal(b.sent[3].event, 'toolCancel');

  // nobody answers: the call waits until its timer fires, and only that timer (the earlier calls' were cleared when they ended)
  const waiting = w.registry.invoke('c1', 's', 'browser_open', {});
  await until(() => b.sent.length === 5);
  assert.deepEqual(w.clock.pending(), [80]);
  w.clock.fire(80);
  const slow = await waiting;
  assert.equal(slow.error.code, 'timeout');
  assert.equal(b.sent.at(-1).event, 'toolCancel');
  assert.equal(w.relay.pending, 0);
  // the late answer is acknowledged and ignored
  assert.deepEqual(b.conn.result({ chatId: 'c1', callId: 'call-4', ok: true, content: [] }), { accepted: false });
});

test('W: only the app a call was sent to, for that chat, can answer it', async () => {
  const w = world();
  const a = w.app();
  const b = w.app();
  a.conn.sync([spec('browser_open')]);
  a.conn.send('c1');
  const done = w.registry.invoke('c1', 's', 'browser_open', {});
  await until(() => a.sent.length);
  const answer = { chatId: 'c1', callId: 'call-1', ok: true, content: [text('x')] };
  assert.throws(
    () => b.conn.result(answer),
    (e: any) => e.code === 'not_owned',
  );
  assert.throws(
    () => a.conn.result({ ...answer, chatId: 'other' }),
    (e: any) => e.code === 'not_owned',
  );
  assert.equal(w.relay.pending, 1, 'a refused answer leaves the call waiting');
  a.conn.result(answer);
  assert.equal((await done).ok, true);
});

test('tool lists: the Host’s own tools win, a changed spec is replaced, and a name two apps announce is the first one’s', async () => {
  const w = world();
  w.registry.register({ name: 'host_own', policy: 'observe', handler: () => 'own' });
  const a = w.app();
  const b = w.app();
  assert.deepEqual(a.conn.sync([spec('host_own'), spec('browser_open')]), { registered: ['browser_open'], skipped: ['host_own'] });
  assert.equal((await w.registry.invoke('c', 's', 'host_own', {})).content[0].text, 'own');
  // a changed description replaces the proxy
  a.conn.sync([{ ...spec('browser_open'), description: 'changed' }]);
  assert.equal(w.registry.list({ all: true }).find((t: any) => t.name === 'browser_open').description, 'changed');
  // the second app announcing the same name changes nothing; when the first leaves, the second's spec takes over
  b.conn.sync([{ ...spec('browser_open'), description: 'second' }]);
  assert.equal(w.registry.list({ all: true }).find((t: any) => t.name === 'browser_open').description, 'changed');
  a.conn.detach();
  assert.equal(w.registry.list({ all: true }).find((t: any) => t.name === 'browser_open').description, 'second');
  b.conn.sync([]);
  assert.deepEqual(
    w.registry.list({ all: true }).map((t: any) => t.name),
    ['host_own'],
  );
});

/** The protocol over a registry-backed relay, with a fake chat runtime. */
function protocolWorld() {
  const dir = fs.mkdtempSync(path.join(base, 'p-'));
  const registry = new Registry();
  const relay = createToolRelay({ registry });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: async () => undefined }), send: async () => ({ turnId: 't' }) };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), tools: relay });
  const connect = async (features = S.FEATURES) => {
    const sent: any[] = [];
    const conn = protocol.connection((m: any) => sent.push(m));
    await conn.call('host.hello', { protocol: S.PROTOCOL, features: [...features] });
    return { conn, sent };
  };
  return { dir, registry, relay, epochs, protocol, connect, runtime };
}

test('I: over the protocol, the app that sent or subscribed to a chat gets its tool calls, and Stop ends them', async () => {
  const w = protocolWorld();
  const app = await w.connect();
  assert.deepEqual(await app.conn.call('host.toolsSync', { tools: [spec('browser_open')] }), { registered: ['browser_open'], skipped: [] });
  const chatId = 'acp:fake:a';
  const epoch = w.epochs.current(chatId);
  const send = { chatId, epoch, key: 'send-key-0001', text: 'hello' };
  await app.conn.call('chat.send', send);
  const call = w.registry.invoke(chatId, 's', 'browser_open', { url: 'u' });
  await until(() => app.sent.some((m) => m.event === 'tool'));
  const sentCall = app.sent.find((m) => m.event === 'tool');
  assert.deepEqual([sentCall.chatId, sentCall.epoch, sentCall.name, sentCall.arguments], [chatId, epoch, 'browser_open', { url: 'u' }]);
  assert.deepEqual(await app.conn.call('host.toolResult', { chatId, epoch, callId: sentCall.callId, ok: true, content: [text('ok')] }), {
    accepted: true,
  });
  assert.equal((await call).ok, true);
  // another app with tools that sends to the chat becomes its owner; Stop ends its waiting call
  const other = await w.connect();
  await other.conn.call('host.toolsSync', { tools: [spec('browser_open')] });
  await other.conn.call('chat.send', { chatId, epoch: w.epochs.current(chatId), key: 'send-key-0002', text: 'again' });
  const pending = w.registry.invoke(chatId, 's', 'browser_open', {});
  await until(() => other.sent.some((m) => m.event === 'tool'));
  // an answer for another epoch is refused, and never moves the chat's epoch
  const open = other.sent.find((m) => m.event === 'tool');
  for (const e of [epoch + 1, epoch - 1 < 0 ? 99 : epoch - 1])
    await assert.rejects(
      other.conn.call('host.toolResult', { chatId, epoch: e, callId: open.callId, ok: true, content: [] }),
      (err: any) => err.name === 'StaleEpochError',
    );
  assert.equal(w.epochs.current(chatId), epoch);
  assert.equal(w.relay.pending, 1);
  await other.conn.call('chat.stop', { chatId, epoch: w.epochs.current(chatId), key: 'stop-key-0001' });
  assert.equal((await pending).error.code, 'aborted');
  assert.ok(other.sent.some((m) => m.event === 'toolCancel'));
  // a connection that closes takes its tools along
  other.conn.close();
  app.conn.close();
  assert.deepEqual(w.registry.list({ all: true }), []);
});

test('I: the tool methods need hello and the tools feature, and a Host without a relay refuses them', async () => {
  const w = protocolWorld();
  const early = w.protocol.connection(() => undefined);
  await assert.rejects(early.call('host.toolsSync', { tools: [] }), (e: any) => e.code === 'hello_required');
  const old = await w.connect(S.FEATURES.filter((f: string) => f !== 'tools'));
  await assert.rejects(old.conn.call('host.toolsSync', { tools: [] }), (e: any) => e.code === 'feature_missing');
  await assert.rejects(
    old.conn.call('host.toolResult', { chatId: 'c', epoch: 0, callId: 'x', ok: true, content: [] }),
    (e: any) => e.code === 'feature_missing',
  );
  const none = createProtocol({
    runtime: w.runtime,
    epochs: w.epochs,
    guard: createGuard({ epochs: w.epochs, ledger: createLedger(path.join(w.dir, 'l2'), quiet) }),
    status: () => ({ running: true }),
  });
  const conn = none.connection(() => undefined);
  await conn.call('host.hello', { protocol: S.PROTOCOL, features: [...S.FEATURES] });
  await assert.rejects(conn.call('host.toolsSync', { tools: [] }), (e: any) => e.code === 'unsupported');
  assert.equal(w.registry.list({ all: true }).length, 0);
});

test('I: the tool methods are for paired clients only', async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 's-'));
  const paths = createPaths({ dataDir: dir, env: {} });
  const w = protocolWorld();
  const server = await startServer({
    paths,
    runtime: { host: new EventEmitter() } as any,
    pairing: createPairing({ configDir: paths.configDir }),
    protocol: w.protocol,
  });
  t.after(() => server.close());
  const first = line(paths.socketPath);
  t.after(first.close);
  for (const m of ['host.toolsSync', 'host.toolResult']) {
    const r = await first.call(m, { tools: [], chatId: 'c', callId: 'x', ok: true, content: [] });
    assert.deepEqual([r.error, r.code], ['This client is not paired with the Host.', 'unknown_client']);
  }
});

test('a harness on the Host calls an app tool through sage-mcp: the call reaches the app and its answer is in the reply', {
  timeout: 90_000,
}, async () => {
  const tools = createHostTools();
  const dir = fs.mkdtempSync(path.join(base, 'e-'));
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({ fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 's') } } }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { tools: tools.mcp } });
  const sessions = createHostSessions({ paths, env: {}, runtime });
  try {
    const chatId = 'acp:fake:relay';
    const app = tools.relay!.attach(
      (m: any) => {
        // the app: runs the call and answers
        if (m.event === 'tool')
          queueMicrotask(() =>
            app.result({ chatId: m.chatId, callId: m.callId, ok: true, content: [text(`app ran ${m.name} on ${m.arguments.url}`)] }),
          );
      },
      () => 0,
    );
    app.sync([spec('browser_open')]);
    app.send(chatId);
    const events: any[] = [];
    // the end of the turn is awaited as an event, not polled for against a deadline: a loaded machine spawns the agent slowly, and the test's own timeout is the only backstop
    const ended = new Promise<void>((resolve) =>
      sessions.chatRuntime.host.on('event', (e: any) => {
        events.push(e);
        if (e.kind === 'turnEnd') resolve();
      }),
    );
    await sessions.chatRuntime.send({ key: chatId, text: 'MCPTOOL browser_open {"url":"https://example.com"}', cwd: dir });
    await ended;
    const reply = events
      .filter((e) => e.update?.sessionUpdate === 'agent_message_chunk')
      .map((e) => e.update.content.text)
      .join('');
    assert.match(reply, /app ran browser_open on https:\/\/example\.com/);
    app.detach();
  } finally {
    sessions.close();
    runtime.close();
    tools.close();
  }
});

test('I: a paired client may send a frame-sized tool result, a client that has not paired only a small line', {
  timeout: 60_000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 'big-'));
  const paths = createPaths({ dataDir: dir, env: {} });
  const w = protocolWorld();
  const pairing = createPairing({ configDir: paths.configDir });
  const server = await startServer({ paths, runtime: { host: new EventEmitter() } as any, pairing, protocol: w.protocol });
  t.after(() => server.close());
  const first = line(paths.socketPath);
  t.after(first.close);
  const { loadIdentity, pairWith } = require('../electron/host/pairingClient.cjs');
  await pairWith(first.request, loadIdentity(path.join(dir, 'app.json'), keySafe), pairing.issueCode());
  assert.ok((await first.call('host.hello', { protocol: S.PROTOCOL, features: [...S.FEATURES] })).result.agreed);
  // a 3 MB screenshot is one message
  const big = await first.call('host.toolResult', {
    chatId: 'acp:fake:a',
    epoch: 0,
    callId: 'gone-1',
    ok: true,
    content: [{ type: 'image', data: 'A'.repeat(3 * 1024 * 1024), mimeType: 'image/png' }],
  });
  assert.deepEqual(big.result, { accepted: false });
  // and a result larger than a frame is refused by the parser, not by cutting the connection
  const huge = await first.call('host.toolResult', {
    chatId: 'acp:fake:a',
    epoch: 0,
    callId: 'gone-2',
    ok: true,
    content: [{ type: 'image', data: 'A'.repeat(8 * 1024 * 1024 - 10 * 1024), mimeType: 'image/png' }],
  });
  assert.match(huge.error, /larger than one message can carry/);
  assert.equal((await first.call('ping')).result, 'pong');
  // before pairing a line over 1 MiB ends the connection
  const raw = (await import('node:net')).connect(paths.socketPath);
  const closed = new Promise((r) => raw.once('close', r));
  raw.on('error', () => undefined);
  raw.write('x'.repeat(1024 * 1024 + 10));
  await closed;
});
