// The stream delivery benchmark (docs/performance/measurement.md): what a flush's `stream:batch` costs main to put on the
// wire and a window to take off it, in plain Node with no app. Electron's IPC writes a message with V8's serializer, the
// one `node:v8` exposes, so a message is timed as `v8.serialize` of its arguments in main and `v8.deserialize` in the
// window: before, a list of event objects; after, JSON bytes made of the text main already has, with what it has no
// text for cloned beside them (electron/app/streamBatch.cjs), parsed by the preload (electron/bridge/spec.cjs). It also
// times what one serialization of an event main holds only as an object costs, by JSON and by the clone.
//
//   node scripts/perf-bench/delivery.mjs [--reps 5] [--rounds 2000] [--out file.json]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import v8 from 'node:v8';
import { median } from './aggregate.mjs';

const require = createRequire(import.meta.url);
const { streamBatch } = require('../../electron/app/streamBatch.cjs');
const { remember } = require('../../electron/harness/eventJson.cjs');
const { streamItems } = require('../../electron/bridge/spec.cjs');

/** A Codex text delta as main has it after a join: its JSON from the core. */
const delta = (/** @type {number} */ chat, /** @type {string} */ text) => {
  const event = {
    kind: 'notification',
    chatId: `chat-${chat}`,
    method: 'item/agentMessage/delta',
    params: { threadId: `chat-${chat}`, turnId: '019a2c1e-7b8f-7c31-9e0a-5d4f3b2a1c0d', itemId: `msg_${chat}_0001`, delta: text },
    origin: 7,
  };
  return remember(event, JSON.stringify(event));
};
/** An ACP tool update, which waits behind the deltas and which main has only as an object. */
const tool = (/** @type {number} */ bytes) => ({
  kind: 'update',
  key: 'acp:kimi:s1',
  turnId: 'at-1',
  update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    status: 'in_progress',
    content: [{ type: 'diff', path: '/w/src/app.ts', oldText: 'a'.repeat(bytes / 2), newText: 'b'.repeat(bytes / 2) }],
  },
});

/**
 * The flushes a window gets, by name: a frame tick at S3 (four chats, a tick's text each, joined) with a tool update
 * among them, and a background tick (250 ms of four chats).
 */
export const FLUSHES = {
  frameTick: () => [
    ...[0, 1, 2, 3].map((c) => ['codex:item', delta(c, 'tok '.repeat(2)), { mine: c === 0 }]),
    ['acp:event', tool(1024), undefined],
  ],
  backgroundTick: () => [0, 1, 2, 3].map((c) => ['codex:item', delta(c, 'tok '.repeat(30)), { mine: false }]),
  // a chat past the batcher's bound: 256 Ki units in one joined delta, and another chat's
  bound: () => [
    ['codex:item', delta(0, 'x'.repeat(256 * 1024)), { mine: false }],
    ['codex:item', delta(1, 'tok '), { mine: false }],
  ],
};

/** Events main holds only as objects, at the sizes they come in. */
export const OBJECTS = {
  claudeAssistant: () => ({
    kind: 'message',
    key: 's',
    msg: {
      type: 'assistant',
      uuid: 'u',
      message: {
        id: 'm',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't',
            name: 'Edit',
            input: { file_path: '/w/a.ts', old_string: 'x'.repeat(800), new_string: 'y'.repeat(800) },
          },
        ],
      },
    },
  }),
  claudeToolResult100k: () => ({
    kind: 'message',
    key: 's',
    msg: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r'.repeat(100_000) }] } },
  }),
  codexCommand1m: () => ({
    kind: 'notification',
    method: 'item/completed',
    params: {
      threadId: 'c',
      turnId: 't',
      item: { type: 'commandExecution', id: 'i', command: 'ls', aggregatedOutput: 'o\n'.repeat(500_000) },
    },
  }),
  acpToolUpdate50k: () => tool(50_000),
};

/** Microseconds `fn` takes, the median of `rounds`. @param {() => unknown} fn @param {number} rounds */
function time(fn, rounds) {
  const us = [];
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    fn();
    us.push((performance.now() - t) * 1000);
  }
  return /** @type {number} */ (median(us));
}

/** One flush timed both ways, in main and in the window. @param {any[]} items @param {number} rounds */
export function timeFlush(items, rounds) {
  const before = () => v8.serialize([items.map(([channel, event, extra]) => [channel, extra ? { ...event, ...extra } : event])]);
  const after = () => v8.serialize(streamBatch(items));
  const sentBefore = before();
  const sentAfter = after();
  return {
    mainBeforeUs: time(before, rounds),
    mainAfterUs: time(after, rounds),
    windowBeforeUs: time(() => v8.deserialize(sentBefore), rounds),
    windowAfterUs: time(() => {
      const [bytes, cloned] = v8.deserialize(sentAfter);
      streamItems(bytes, cloned);
    }, rounds),
    bytesBefore: sentBefore.length,
    bytesAfter: sentAfter.length,
  };
}

/** One event's serialization timed by JSON and by the clone. @param {unknown} event @param {number} rounds */
export function timeObject(event, rounds) {
  return { stringifyUs: time(() => JSON.stringify(event), rounds), cloneUs: time(() => v8.serialize(event), rounds) };
}

/** Every figure, the median of `reps` runs. @param {{ reps: number, rounds: number }} o */
export function bench({ reps, rounds }) {
  /** @type {Record<string, Record<string, number>>} */
  const rows = {};
  const add = (/** @type {string} */ name, /** @type {() => Record<string, number>} */ run) => {
    const runs = Array.from({ length: reps }, run);
    rows[name] = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, /** @type {number} */ (median(runs.map((r) => r[k])))]));
  };
  for (const [name, make] of Object.entries(FLUSHES)) add(name, () => timeFlush(make(), rounds));
  for (const [name, make] of Object.entries(OBJECTS)) add(name, () => timeObject(make(), Math.max(1, Math.round(rounds / 20))));
  return { node: process.version, reps, rounds, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { reps: { type: 'string', default: '5' }, rounds: { type: 'string', default: '2000' }, out: { type: 'string' } },
  });
  const text = JSON.stringify(bench({ reps: Number(values.reps), rounds: Number(values.rounds) }), null, 2);
  if (values.out) fs.writeFileSync(values.out, `${text}\n`);
  console.log(text);
}
