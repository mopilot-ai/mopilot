// A flush's stream batch as bytes (electron/app/streamBatch.cjs) and the preload's reading of it (electron/bridge/spec.cjs
// `streamItems`): events main has as JSON go in as that text, the rest are cloned beside it, and a window gets each in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { checkedKnownJson } from './support/kept-json-check.ts';

const require = createRequire(import.meta.url);
const { streamBatch, jsonWithExtra, withExtra } = require('../electron/app/streamBatch.cjs');
const { remember, knownJson } = require('../electron/harness/eventJson.cjs');
const { streamItems, unpackStreamBatches, STREAM_BATCH } = require('../electron/bridge/spec.cjs');

/** An event whose JSON main has, as the stream batcher leaves it. */
const known = (event: any) => remember(event, JSON.stringify(event));

test('events with JSON go in as their text and the rest are cloned beside it, in order', () => {
  const a = known({ kind: 'notification', params: { delta: 'a "\ud800' } });
  const tool = { kind: 'update', update: { sessionUpdate: 'tool_call', data: new Uint8Array([1, 2]) } };
  const b = known({ kind: 'notification', params: { delta: 'b' } });
  const [bytes, cloned] = streamBatch([
    ['codex:item', a, { mine: true }],
    ['acp:event', tool, undefined],
    ['codex:item', b, { mine: false }],
  ]) as [Uint8Array, any[]];
  // an array of its own, of the batch's size: no pooled view, which IPC could copy whole with others' bytes in it
  assert.equal(bytes.byteOffset, 0);
  assert.equal(bytes.buffer.byteLength, bytes.length);
  assert.ok(!Buffer.isBuffer(bytes));
  assert.deepEqual(cloned, [tool], 'only the event main had no JSON for is cloned');
  assert.equal(cloned[0], tool);
  assert.deepEqual(streamItems(new Uint8Array(bytes), cloned), [
    ['codex:item', { ...a, mine: true }],
    ['acp:event', tool],
    ['codex:item', { ...b, mine: false }],
  ]);
});

test('a batch with no event as JSON is the cloned list, as before; an extra on JSON of no object is cloned', () => {
  const plain = { n: 1 };
  assert.deepEqual(streamBatch([['x', plain, undefined]]), [[['x', plain]]]);
  assert.equal(withExtra(plain, undefined), plain, 'an event with nothing of its window is the same object');
  const toJSON = () => 'x';
  const odd = remember({ toJSON }, '"x"');
  const [bytes, cloned] = streamBatch([
    ['x', odd, { mine: true }],
    ['y', known({}), { mine: true }],
  ]) as [Buffer, any[]];
  assert.deepEqual(cloned, [{ toJSON, mine: true }]);
  assert.deepEqual(streamItems(bytes, cloned)?.[1], ['y', { mine: true }]);
  assert.equal(knownJson(remember('a string', '"a string"')), undefined, 'only an object keeps its text');
  assert.equal(knownJson(null), undefined);
  assert.equal(jsonWithExtra('{"a":1}', undefined), '{"a":1}');
  assert.equal(jsonWithExtra('{"a":1}', { a: 2, b: 'x' }), '{"a":1,"a":2,"b":"x"}');
  assert.equal(JSON.parse(jsonWithExtra('{"a":1}', { a: 2 })).a, 2, 'the window reads the extra, as the spread had it');
  assert.equal(jsonWithExtra('[1]', { mine: true }), null);
});

test('the preload drops a batch it cannot read, as one of the wrong shape always was', () => {
  assert.equal(streamItems('junk'), null);
  assert.equal(streamItems(new Uint8Array([123])), null, 'bytes with nothing cloned beside them');
  assert.equal(streamItems(Buffer.from('{'), []), null);
  assert.equal(streamItems(Buffer.from('{"a":1}'), []), null);
});

test("a batch's events reach their listeners before the message that came after it", () => {
  const ipc = new EventEmitter();
  unpackStreamBatches(ipc);
  const heard: string[] = [];
  ipc.on('claude:event', (_e, ev) => heard.push(`delta ${ev.text}`));
  ipc.on('acp:event', (_e, ev) => heard.push(`tool ${ev.id}`));
  ipc.on('session:patch', (_e, p) => heard.push(`patch ${p.rev}`));
  const [bytes, cloned] = streamBatch([
    ['claude:event', known({ text: 'a' }), undefined],
    ['acp:event', { id: 't1' }, undefined],
    ['claude:event', known({ text: 'b' }), undefined],
  ]);
  ipc.emit(STREAM_BATCH, {}, new Uint8Array(bytes as Buffer), cloned);
  ipc.emit('session:patch', {}, { rev: 2 });
  assert.deepEqual(heard, ['delta a', 'tool t1', 'delta b', 'patch 2']);
});

test('an extra JSON cannot write as the spread has it sends that event by clone, and the rest of the batch still as text', () => {
  const a = known({ kind: 'notification', n: 1 });
  const b = known({ kind: 'notification', n: 2 });
  const c = known({ kind: 'notification', n: 3 });
  const [bytes, cloned] = streamBatch([
    ['codex:item', a, { mine: undefined }],
    ['codex:item', b, { mine: 10n }],
    ['codex:item', c, { mine: true }],
  ]) as [Uint8Array, any[]];
  assert.deepEqual(cloned, [
    { ...a, mine: undefined },
    { ...b, mine: 10n },
  ]);
  assert.ok('mine' in cloned[0], 'the window gets the key the spread wrote');
  assert.deepEqual(streamItems(bytes, cloned), [
    ['codex:item', { ...a, mine: undefined }],
    ['codex:item', { ...b, mine: 10n }],
    ['codex:item', { ...c, mine: true }],
  ]);
  assert.equal(jsonWithExtra('{"a":1}', {}), '{"a":1}', 'an extra with no fields writes none');
  assert.equal(jsonWithExtra('{"a":1}', { f: () => 1 }), null);
});

test('the preload reads a batch whose bytes were made in another realm', () => {
  const foreign = runInNewContext('new Uint8Array([91, 91, 34, 120, 34, 44, 49, 93, 93])');
  assert.equal(foreign instanceof Uint8Array, false, 'another realm');
  assert.deepEqual(streamItems(foreign, []), [['x', 1]]);
});

test('the JSON check of every unit test tells a stream event that changed after main kept its text', () => {
  const told: Error[] = [];
  // its own keeping, not the module's: the register's check of that would fail this file
  const event = { kind: 'notification', params: { delta: 'a' } };
  const kept = JSON.stringify(event);
  const read = checkedKnownJson(
    (e: unknown) => (e === event ? kept : undefined),
    (error: Error) => told.push(error),
  );
  assert.equal(read(event), kept);
  assert.equal(read({ unknown: true }), undefined);
  event.params.delta = 'changed';
  assert.equal(read(event), '{"kind":"notification","params":{"delta":"a"}}');
  assert.equal(told.length, 1);
  assert.match(told[0].message, /changed after main kept its JSON/);
});
