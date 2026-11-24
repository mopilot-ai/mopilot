// The Host's protocol dispatcher and its server routing (host/src/protocol.mjs, server.mjs): hello and the feature gates, chat requests through the epoch and ledger, and the session stream from runtime events (A2, B1-B3, B7).
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol, wireError, UnsupportedError } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { startServer } from '../host/src/server.mjs';
import { readJsonLines } from './support/jsonLineReader.ts';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
import { SIDE_CHAT_FEATURE } from '../shared/host/sideChats.mjs';

const quiet = { report: () => undefined };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-wire-'));

function setup() {
  const dir = tmp();
  const host: any = new EventEmitter();
  const cancelled: string[] = [];
  host.cancel = (key: string) => cancelled.push(key);
  const sends: any[] = [];
  const runtime: any = {
    host,
    send: async (p: any) => (sends.push(p), { turnId: `t${sends.length}` }),
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }) });
  const out: any[] = [];
  const conn = protocol.connection((m: object) => out.push(m));
  return { dir, host, runtime, sends, cancelled, protocol, conn, out, epochs };
}
const key = (n = 1) => `key-${String(n).padStart(8, '0')}`;
const scope = { chatId: 'claude:c1', epoch: 1 };
const send = (n = 1, extra = {}) => ({ ...scope, key: key(n), text: 'hi', ...extra });
const hello = async (conn: any) => conn.call('host.hello', helloParams());

test("a chat request before hello is refused; hello answers with this Host's version and the features both speak", async () => {
  const { conn } = setup();
  await assert.rejects(conn.call('chat.send', send()), (e: any) => e.code === 'hello_required');
  const res = await hello(conn);
  assert.deepEqual(
    res.agreed.features,
    helloParams({ switching: false, continueFamilies: false }).features.filter(
      (f) =>
        ![
          'journalLifecycle',
          'historyPages',
          'momo',
          'momoHome',
          'momoLook',
          'chatList',
          'chatPaging',
          'chatEvents',
          'commands',
          SIDE_CHAT_FEATURE,
        ].includes(f),
    ),
  );
  assert.equal(res.features.includes('switch'), false, 'a runtime that cannot settle a switch does not offer one');
  assert.equal(res.features.includes('momo'), false, 'MoMo is named only to a client a live grant lets see it');
  assert.equal(res.features.includes('journalLifecycle'), false, 'an in-memory embedder cannot promise durable deletion');
  assert.equal(res.features.includes(SIDE_CHAT_FEATURE), false, 'an in-memory embedder cannot retire a persisted side chat');
  assert.equal(res.features.includes('historyPages'), false, 'an in-memory embedder cannot page a persisted journal');
  await assert.rejects(
    conn.call('chat.history', { ...scope, generation: 'g', rev: 0, index: 0, offset: 0 }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('historyPages'),
  );
  assert.equal(res.features.includes('chatList'), false, 'an in-memory embedder has no chats on disk to list');
  await assert.rejects(conn.call('host.chats', {}), (e: any) => e.code === 'feature_missing' && e.missing.includes('chatList'));
  assert.equal(res.features.includes('commands'), false, 'a Host with no source for the / menu does not offer its list');
  await assert.rejects(
    conn.call('host.commands', { harness: 'claude' }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('commands'),
  );
  assert.deepEqual(await conn.call('host.status', {}), { running: true });
});

test('a peer without a safety feature is refused instead of served degraded', async () => {
  const { conn, sends } = setup();
  await conn.call('host.hello', { protocol: helloParams().protocol, features: ['dedupe', 'lanes', 'isolation'] });
  await assert.rejects(conn.call('chat.send', send()), (e: any) => e.code === 'feature_missing' && e.missing.includes('epoch'));
  assert.equal(sends.length, 0);
  const old = setup();
  await assert.rejects(
    old.conn.call('host.hello', { protocol: { minor: 0, floor: 0 }, features: [] }),
    (e: any) => e.code === 'version_refused',
  );
});

test('B7: chat.send twice with one key runs once; both callers get the first result', async () => {
  const { conn, sends } = setup();
  await hello(conn);
  const [a, b] = await Promise.all(
    [
      conn.call('chat.start', { ...send(), chatId: 'acp:kimi:c1', harness: 'acp:kimi' }),
      conn.call('chat.send', { ...send(), chatId: 'acp:kimi:c1' }),
    ].map((p, i) => (i ? p.catch((e: any) => e) : p)),
  );
  assert.equal(a.replayed, false);
  assert.deepEqual(a.result, { turnId: 't1' });
  // the same key under another method is a client bug, not a replay
  assert.equal(b.code, 'key_reused');
  const again = await conn.call('chat.send', { ...send(2) });
  const dup = await conn.call('chat.send', { ...send(2) });
  assert.deepEqual([again.replayed, dup.replayed, dup.result], [false, true, again.result]);
  assert.equal(sends.length, 2);
});

test('A2: a request from an older epoch is refused with the current one and runs nothing', async () => {
  const { conn, sends } = setup();
  await hello(conn);
  await conn.call('chat.send', { ...send(1), epoch: 3 });
  const e: any = await conn.call('chat.send', { ...send(2), epoch: 2 }).catch((x: any) => x);
  assert.equal(e.code, 'stale_epoch');
  assert.deepEqual(wireError(e), { error: e.message, code: 'stale_epoch', current: 3 });
  assert.equal(sends.length, 1);
  const sub: any = await conn.call('chat.subscribe', { ...scope, epoch: 2 }).catch((x: any) => x);
  assert.equal(sub.code, 'stale_epoch');
});

test('B1: a malformed request is refused before it can reach the runtime', async () => {
  const { conn, sends } = setup();
  await hello(conn);
  for (const bad of [{}, { ...send(), epoch: undefined }, { ...send(), key: undefined }, { ...send(), text: '' }])
    await assert.rejects(conn.call('chat.send', bad), (e: any) => e.code === 'invalid');
  await assert.rejects(conn.call('chat.nope', {}), (e: any) => e.code === 'invalid');
  assert.equal(sends.length, 0);
});

test("chat.stop cancels the chat's turn once per key; chat.permit says it is unsupported", async () => {
  const { conn, cancelled } = setup();
  await hello(conn);
  const stop = { ...scope, key: key(5) };
  assert.deepEqual((await conn.call('chat.stop', stop)).result, { stopped: true });
  await conn.call('chat.stop', stop);
  assert.deepEqual(cancelled, ['claude:c1']);
  const e: any = await conn.call('chat.permit', { ...scope, key: key(6), value: 'auto' }).catch((x: any) => x);
  assert.ok(e instanceof UnsupportedError);
  assert.equal(wireError(e).code, 'unsupported');
  assert.deepEqual(wireError('plain'), { error: 'plain' });
});

test("a Stop that names a turn that already ended stops nothing: a queued message's turn is not the one the button showed", async () => {
  const { conn, host, cancelled } = setup();
  await hello(conn);
  const say = (e: object) => host.emit('event', { key: 'claude:c1', ...e });
  say({ kind: 'turnStart', turnId: 'a1' });
  say({ kind: 'turnEnd', turnId: 'a1' });
  say({ kind: 'turnStart', turnId: 'b1' });
  // the late Stop for a1 changes nothing; one for b1, or with no id, stops the running turn
  assert.deepEqual((await conn.call('chat.stop', { ...scope, key: key(7), turnId: 'a1' })).result, { stopped: false, retired: true });
  assert.deepEqual(cancelled, []);
  assert.deepEqual((await conn.call('chat.stop', { ...scope, key: key(8), turnId: 'b1' })).result, { stopped: true });
  assert.deepEqual(cancelled, ['claude:c1']);
  // a turn that was interrupted by a restart is ended too
  const { conn: c2, protocol, cancelled: cancelled2 } = setup();
  await hello(c2);
  protocol.interrupted([['x1', 'claude:c1']]);
  assert.equal((await c2.call('chat.stop', { ...scope, key: key(9), turnId: 'x1' })).result.retired, true);
  assert.deepEqual(cancelled2, []);
});

const chunk = (text: string, extra: object = {}, turnId = 't1') => ({
  kind: 'update',
  turnId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...extra },
});

test('the stream: runtime events are durable records, a message streams as deltas and is recorded once, and the turn leaves its summary', async () => {
  const { conn, host, out } = setup();
  await hello(conn);
  await conn.call('chat.send', send());
  host.emit('event', { kind: 'turnStart', turnId: 't1', key: 'claude:c1', user: { id: 'u-1' } });
  host.emit('event', chunk('he'));
  host.emit('event', { kind: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'llo' } } });
  // a chunk of a turn this Host never started names no chat: nothing to show
  host.emit('event', chunk('lost', {}, 'unknown'));
  assert.deepEqual(await conn.call('chat.subscribe', scope), { subscribed: true });
  const first = out[0].frame;
  assert.deepEqual([first.t, first.rev, first.epoch, first.snapshot.items.length], ['hello', 2, 1, 2]);
  assert.deepEqual(first.snapshot.items[1], { t: 'event', family: 'acp', event: { kind: 'turnStart', turnId: 't1', user: { id: 'u-1' } } });
  assert.deepEqual(first.inFlightEphemeral, [
    {
      key: 't1:agent_message_chunk:',
      deltas: [
        { turnId: 't1', sessionUpdate: 'agent_message_chunk', text: 'he' },
        { turnId: 't1', sessionUpdate: 'agent_message_chunk', text: 'llo' },
      ],
      truncated: false,
    },
  ]);
  // another kind of update ends the message: one durable update with the whole text replaces the deltas, then the update itself follows
  host.emit('event', { kind: 'update', turnId: 't1', update: { sessionUpdate: 'tool_call', toolCallId: 'c1' } });
  host.emit('event', chunk('!'));
  host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  const frames = out.slice(1).map((m) => m.frame);
  assert.deepEqual(
    frames.map((f) => f.t),
    ['durable', 'durable', 'delta', 'durable', 'durable', 'durable'],
  );
  assert.deepEqual(frames[0].item.event, {
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
  });
  assert.equal(frames[0].promotes, 't1:agent_message_chunk:');
  assert.equal(frames[1].item.event.update.sessionUpdate, 'tool_call');
  assert.equal(frames[2].key, 't1:agent_message_chunk:');
  assert.equal(frames[3].item.event.update.content.text, '!');
  assert.deepEqual(frames[4].item.event, { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  assert.deepEqual(frames[5].item, { t: 'assistant', turnId: 't1', text: 'hello!', stopReason: 'end_turn', error: null });
  host.emit('event', { kind: 'turnStart', turnId: 't2', key: 'claude:c1' });
  host.emit('event', { kind: 'turnEnd', turnId: 't2', error: { message: 'boom' } });
  assert.equal(out.at(-1).frame.item.error, 'boom');
  assert.equal(out.at(-1).frame.item.stopReason, null);
});

test('a new message, another kind of text or a block that is not text starts its own record', async () => {
  const { conn, host, out } = setup();
  await hello(conn);
  await conn.call('chat.subscribe', scope);
  host.emit('event', { kind: 'turnStart', turnId: 't1', key: 'claude:c1' });
  host.emit('event', chunk('a', { messageId: 'm1' }));
  host.emit('event', chunk('b', { messageId: 'm2' }));
  host.emit('event', {
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } },
  });
  host.emit('event', {
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } },
  });
  host.emit('event', { kind: 'turnEnd', turnId: 't1' });
  const durable = out.map((m) => m.frame).filter((f) => f.t === 'durable' && f.item.event?.kind === 'update');
  assert.deepEqual(
    durable.map((f) => [f.item.event.update.sessionUpdate, f.item.event.update.messageId, f.item.event.update.content.type, f.promotes]),
    [
      ['agent_message_chunk', 'm1', 'text', 't1:agent_message_chunk:m1'],
      ['agent_message_chunk', 'm2', 'text', 't1:agent_message_chunk:m2'],
      ['agent_thought_chunk', undefined, 'text', 't1:agent_thought_chunk:'],
      ['agent_message_chunk', undefined, 'image', undefined],
    ],
  );
});

test('permission cards, a quit harness and unattended work reach the stream; the Host-only events do not', async () => {
  const { conn, host, out } = setup();
  await hello(conn);
  await conn.call('chat.subscribe', scope);
  host.emit('event', { kind: 'turnStart', turnId: 't1', key: 'claude:c1' });
  host.emit('event', {
    kind: 'permission',
    key: 'claude:c1',
    turnId: 't1',
    requestId: 'p1',
    toolCall: { title: 'rm' },
    options: [{ optionId: 'allow' }],
  });
  host.emit('event', { kind: 'permissionCancelled', key: 'claude:c1', turnId: 't1', requestId: 'p1' });
  host.emit('event', { kind: 'unattended', key: 'claude:c1', reason: 'permission' });
  host.emit('event', { kind: 'closed', key: 'claude:c1', error: 'gone' });
  host.emit('event', { kind: 'session', key: 'claude:c1', sessionId: 's' });
  host.emit('event', { kind: 'transcriptError', key: 'claude:c1', error: 'disk' });
  const kinds = out
    .map((m) => m.frame)
    .filter((f) => f.t === 'durable')
    .map((f) => f.item.event?.kind);
  assert.deepEqual(kinds, ['turnStart', 'permission', 'permissionCancelled', 'unattended', 'closed']);
  const card = out.map((m) => m.frame).find((f) => f.item?.event?.kind === 'permission');
  assert.equal(card.item.event.requestId, 'p1');
  assert.equal('key' in card.item.event, false);
});

test('chat.start runs the first message on the harness the chat id names, once per key; anything else is refused before it runs', async () => {
  const { conn, sends } = setup();
  await hello(conn);
  const start = { chatId: 'acp:kimi:c1', epoch: 0, key: key(7), harness: 'acp:kimi', text: 'hi', projectId: null, cwd: '/work/a' };
  assert.deepEqual((await conn.call('chat.start', start)).result, { turnId: 't1' });
  assert.equal((await conn.call('chat.start', start)).replayed, true);
  assert.deepEqual(sends, [{ key: 'acp:kimi:c1', clientId: key(7), text: 'hi', cwd: '/work/a' }]);
  const other = await conn.call('chat.start', { ...start, key: key(8), harness: 'acp:gemini' }).catch((e: any) => e);
  assert.equal(other.code, 'invalid');
  const claude = await conn.call('chat.start', { ...start, chatId: 'claude:c1', key: key(9), harness: 'claude' }).catch((e: any) => e);
  assert.ok(claude instanceof UnsupportedError);
  assert.equal(sends.length, 1);
});

test('chat.start refuses a Claude chat id that is not claude:<uuid> with a typed error, instead of accepting a start that goes nowhere (#4537)', async () => {
  const { conn, runtime, sends } = setup();
  runtime.prepare = async () => undefined;
  await hello(conn);
  const start = {
    chatId: 'claude:accept11-zs0vwJ',
    epoch: 0,
    key: key(11),
    harness: 'claude',
    text: 'hi',
    projectId: null,
    cwd: '/work/a',
  };
  const bad = await conn.call('chat.start', start).catch((e: any) => e);
  assert.equal(bad.code, 'invalid');
  assert.match(bad.message, /UUID/);
  assert.equal(sends.length, 0);
  const ok = await conn.call('chat.start', { ...start, key: key(12), chatId: 'claude:0F9A1C2E-1b2c-4d3e-8f4a-5b6c7d8e9f01' });
  assert.ok(ok.result);
});

test("chat.answer gives a card's answer to the harness once per key and says whether the card was still there", async () => {
  const { conn, runtime, out } = setup();
  const asked: any[] = [];
  runtime.permit = (p: any) => (asked.push(p), p.requestId === 'p1');
  await hello(conn);
  await conn.call('chat.subscribe', scope);
  const answer = { ...scope, key: key(10), requestId: 'p1', optionId: 'allow' };
  assert.deepEqual((await conn.call('chat.answer', answer)).result, { answered: true });
  await conn.call('chat.answer', answer);
  assert.deepEqual((await conn.call('chat.answer', { ...scope, key: key(11), requestId: 'gone' })).result, { answered: false });
  // a form card's answer (#4001) goes to the harness as it came
  await conn.call('chat.answer', { ...scope, key: key(12), requestId: 'p1', form: { action: 'accept', content: { name: 'Ada' } } });
  assert.deepEqual(asked, [
    { requestId: 'p1', optionId: 'allow' },
    { requestId: 'gone', optionId: undefined },
    { requestId: 'p1', optionId: undefined, form: { action: 'accept', content: { name: 'Ada' } } },
  ]);
  // an answered card is closed in the log, once; one that was already gone leaves nothing
  const closed = out.map((m) => m.frame).filter((f) => f.t === 'durable' && f.item.event?.kind === 'permissionCancelled');
  assert.deepEqual(
    closed.map((f) => ({ ...f.item.event, at: 0 })),
    [
      { kind: 'permissionCancelled', requestId: 'p1', reason: 'answered', optionKind: 'other', at: 0 },
      { kind: 'permissionCancelled', requestId: 'p1', reason: 'answered', optionKind: 'other', at: 0 },
    ],
  );
});

test('a reconnect resumes from its rev with durable frames only; a second subscribe replaces the first quietly', async () => {
  const { protocol, conn, out } = setup();
  await hello(conn);
  for (let n = 1; n <= 3; n++) await conn.call('chat.send', send(n));
  const again: any[] = [];
  const next = protocol.connection((m: object) => again.push(m));
  await hello(next);
  await next.call('chat.subscribe', { ...scope, fromRev: 1 });
  assert.deepEqual(
    again.map((m) => m.frame.t),
    ['hello', 'durable', 'durable'],
  );
  assert.equal(again[0].frame.snapshot, null);
  await next.call('chat.subscribe', scope);
  assert.deepEqual(
    again.slice(3).map((m) => m.frame.t),
    ['hello'],
  );
  assert.equal(
    again.some((m) => m.event === 'closed'),
    false,
  );
  await conn.call('chat.subscribe', scope);
  next.close();
  conn.close();
  const n = out.length;
  await conn.call('chat.send', send(9));
  assert.equal(out.length, n);
});

test('closing a connection ends its subscriptions and tells the client why', async () => {
  const { protocol } = setup();
  const msgs: any[] = [];
  const c = protocol.connection((m: object) => msgs.push(m));
  await hello(c);
  await c.call('chat.subscribe', scope);
  c.close();
  assert.deepEqual(
    msgs.map((m) => m.event),
    ['frame', 'closed'],
  );
  assert.equal(msgs[1].reason, 'unsubscribed');
});

test("the server routes host.* and chat.* to a connection's session, closes it with the socket, and keeps the line protocol", async () => {
  const dir = tmp();
  const { runtime, protocol } = (() => {
    const s = setup();
    return s;
  })();
  const paths = { dataDir: dir, socketPath: path.join(dir, 's.sock'), lockPath: path.join(dir, 'l.lock') };
  const server = await startServer({ paths, runtime, protocol });
  const socket = net.connect(paths.socketPath);
  const lines = readJsonLines(socket);
  const ask = async (id: number, method: string, params: object) => {
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return lines.find((l) => l.id === id);
  };
  assert.equal((await ask(1, 'chat.send', send())).code, 'hello_required');
  assert.ok((await ask(2, 'host.hello', helloParams())).result.agreed);
  assert.equal((await ask(3, 'chat.subscribe', scope)).result.subscribed, true);
  assert.equal((await lines.find((l) => l.event === 'frame')).frame.t, 'hello');
  assert.equal((await ask(4, 'ping', {})).result, 'pong');
  socket.destroy();
  await server.close();
});

test('wireError carries the missing features of a gate, and nothing for a version refusal', async () => {
  const { conn } = setup();
  const noEpoch = await conn.call('host.hello', { protocol: helloParams().protocol, features: ['dedupe', 'lanes', 'isolation'] });
  assert.ok(noEpoch.agreed);
  const gate: any = await conn.call('chat.send', send()).catch((x: any) => x);
  assert.deepEqual(wireError(gate).missing, ['epoch']);
  const old: any = await setup()
    .conn.call('host.hello', { protocol: { minor: 0, floor: 0 }, features: [] })
    .catch((x: any) => x);
  assert.equal('missing' in wireError(old), false);
});

test('a chat keeps its newest 2000 records; a cwd, a reply chunk without text and an error given as text all pass through', async () => {
  const { conn, host, sends, out } = setup();
  await hello(conn);
  await conn.call('chat.start', send(1, { cwd: '/work', chatId: 'acp:kimi:c1', harness: 'acp:kimi' }));
  assert.equal(sends[0].cwd, '/work');
  host.emit('event', { kind: 'turnStart', turnId: 'x', key: 'claude:c1' });
  host.emit('event', { kind: 'update', turnId: 'x', update: { sessionUpdate: 'agent_message_chunk' } });
  host.emit('event', { kind: 'turnEnd', turnId: 'x', error: 'plain failure' });
  for (let i = 0; i < 1001; i++) {
    host.emit('event', { kind: 'turnStart', turnId: `m${i}`, key: 'claude:c1' });
    host.emit('event', { kind: 'turnEnd', turnId: `m${i}` });
  }
  await conn.call('chat.subscribe', scope);
  const snap = out.at(-1).frame;
  assert.equal(snap.snapshot.items.length, 2000);
  assert.equal(snap.rev, 4 + 3 * 1001);
});

test('serve wires the protocol: a real Host process answers host.hello and host.status', async () => {
  const dir = tmp();
  const { main } = await import('../host/src/cli.mjs' as string);
  const signals = new EventEmitter();
  const lines: string[] = [];
  const done = main(['serve', '--data-dir', dir], {
    out: (l: string) => lines.push(l),
    err: () => undefined,
    env: { ...process.env, MOPILOT_HOST_DATA: dir },
    signals,
  });
  const socketPath = path.join(dir, 'host.sock');
  await waitFor(() => fs.existsSync(socketPath), 'the host socket');
  const socket = net.connect(socketPath);
  const reader = readJsonLines(socket);
  socket.write(
    `${JSON.stringify({ id: 1, method: 'host.hello', params: helloParams() })}\n${JSON.stringify({ id: 2, method: 'host.status' })}\n`,
  );
  const got = await reader.wait(2);
  assert.ok(got.find((g) => g.id === 1).result.agreed);
  assert.equal(got.find((g) => g.id === 2).result.running, true);
  socket.destroy();
  signals.emit('SIGINT');
  assert.equal(await done, 0);
});

test('hello carries the surfaces this Host declares; a status that declares none (or junk) is all false', async () => {
  const dir = tmp();
  const make = (status: () => object) => {
    const epochs = createEpochStore(path.join(dir, `e-${Math.random()}.json`), quiet);
    const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, `l-${Math.random()}`), quiet) });
    return createProtocol({ runtime: { host: new EventEmitter() } as any, epochs, guard, status }).connection(() => undefined);
  };
  const declared = await hello(make(() => ({ capabilities: { iab: true, cu: 'yes', shell: true } })));
  assert.deepEqual(declared.capabilities, { iab: true, cu: false, desktop: false, bu: false, shell: true });
  assert.deepEqual(
    (await hello(make(async () => ({ capabilities: { bu: true } })))).capabilities,
    { iab: false, cu: false, desktop: false, bu: true, shell: false },
    'a status that answers later',
  );
  assert.deepEqual((await hello(make(() => ({})))).capabilities, { iab: false, cu: false, desktop: false, bu: false, shell: false });
});
