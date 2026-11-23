// A stream frame over what one wire message may carry is cut to fit or ends the stream with a reason; it is never dropped silently (host/src/frameFit.mjs, protocol.mjs) (B1, B5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { fitFrame } from '../host/src/frameFit.mjs';
// @ts-ignore
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

const MiB = 1024 * 1024;
const size = (f: unknown) => Buffer.byteLength(JSON.stringify(f));

test('a frame that fits is returned as it is; long strings are cut, the multi-byte ones by bytes; the shape and revision stay', () => {
  const small = { t: 'durable', seq: 1, rev: 5, item: { t: 'assistant', text: 'hi' } };
  assert.equal(fitFrame(small, 1000), small);
  const big = { t: 'durable', seq: 2, rev: 6, item: { t: 'assistant', text: '界'.repeat(4 * MiB), tools: [{ out: 'x'.repeat(MiB) }] } };
  const fitted = fitFrame(big, 8 * MiB)!;
  assert.ok(size(fitted) <= 8 * MiB);
  assert.deepEqual([fitted.t, fitted.seq, fitted.rev, fitted.item.t], ['durable', 2, 6, 'assistant']);
  assert.match(fitted.item.text, /\[cut: too long to pass on\]$/);
  // strings are cut harder only as far as the budget needs
  const tight = fitFrame(big, 20 * 1024)!;
  assert.ok(size(tight) <= 20 * 1024 && tight.item.text.length < fitted.item.text.length);
});

test('a Hello whose snapshot is too big keeps the newest items and says how many it left out; a frame no cut can save is null', () => {
  const items = Array.from({ length: 2000 }, (_, i) => ({ t: 'assistant', text: `${i}`.repeat(1000) }));
  const hello = { t: 'hello', seq: 0, rev: 2000, snapshot: { rev: 2000, items } };
  const fitted = fitFrame(hello, 512 * 1024)!;
  assert.ok(size(fitted) <= 512 * 1024);
  assert.equal(fitted.snapshot.items.at(-1).text.slice(0, 4), '1999');
  assert.equal(fitted.snapshot.droppedItems, 2000 - fitted.snapshot.items.length);
  assert.equal(fitFrame({ t: 'durable', rev: 1, item: { n: Array(5_000_000).fill(1) } }, 8 * MiB), null);
  assert.equal(fitFrame({ t: 'hello', seq: 0, rev: 0, snapshot: { rev: 0, items: [] }, pad: Array(5_000_000).fill(1) }, 8 * MiB), null);
  assert.equal(fitFrame(hello, 10), null, 'nothing fits in ten bytes');
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-fit-'));
  const quiet = { report: () => undefined };
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, send: async () => ({ turnId: 't1' }) };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }) });
  const out: any[] = [];
  const conn = protocol.connection((m: object) => out.push(m));
  return { host, conn, out };
}
const scope = { chatId: 'claude:c1', epoch: 1 };
const tick = () => new Promise((r) => setImmediate(r));

test('a durable item over a frame reaches the app cut to fit, with its own revision, and a Hello carries it the same way', async () => {
  const { host, conn, out } = setup();
  await conn.call('host.hello', helloParams());
  await conn.call('chat.subscribe', scope);
  host.emit('event', { kind: 'turnStart', turnId: 't1', key: 'claude:c1' });
  host.emit('event', {
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c1', rawOutput: '界'.repeat(4 * MiB) },
  });
  const durable = out.map((m) => m.frame).find((f) => f.t === 'durable' && f.item.event?.update?.toolCallId === 'c1');
  assert.ok(durable && size({ event: 'frame', chatId: 'claude:c1', frame: durable }) < 8 * MiB);
  assert.match(durable.item.event.update.rawOutput, /\[cut: too long to pass on\]$/);
  // the next subscriber is given the snapshot, which holds the same item
  await conn.call('chat.subscribe', scope);
  const hello = out
    .map((m) => m.frame)
    .filter((f) => f.t === 'hello')
    .at(-1);
  assert.ok(size(hello) < 8 * MiB);
  assert.match(JSON.stringify(hello.snapshot.items), /\[cut: too long to pass on\]/);
});

test('an item no cut can save ends the stream with the reason too_large, once, and the app is told', async () => {
  const { host, conn, out } = setup();
  await conn.call('host.hello', helloParams());
  await conn.call('chat.subscribe', scope);
  const before = out.length;
  host.emit('event', { kind: 'turnStart', turnId: 't1', key: 'claude:c1' });
  host.emit('event', {
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c1', rawOutput: Array(5_000_000).fill(1) },
  });
  await tick();
  const closed = out.slice(before).filter((m) => m.event === 'closed');
  assert.deepEqual(
    closed.map((m) => [m.chatId, m.reason]),
    [['claude:c1', 'too_large']],
  );
  // nothing more is sent to a stream that was closed
  const after = out.length;
  host.emit('event', { kind: 'turnEnd', turnId: 't1' });
  await tick();
  assert.equal(out.length, after);
});

test('a stream replaced before its close is told stays quiet: the old one is not closed over the new one', async () => {
  const { host, conn, out } = setup();
  await conn.call('host.hello', helloParams());
  await conn.call('chat.subscribe', scope);
  host.emit('event', { kind: 'turnStart', turnId: 't1', key: 'claude:c1' });
  host.emit('event', {
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c1', rawOutput: Array(5_000_000).fill(1) },
  });
  const again = conn.call('chat.subscribe', scope);
  await again.catch(() => undefined);
  await tick();
  assert.deepEqual(
    out.filter((m) => m.event === 'closed' && m.reason === 'too_large'),
    [],
  );
});
