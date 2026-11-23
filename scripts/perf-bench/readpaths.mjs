// The read-path benchmark (docs/performance/measurement.md): the app's own transcript, search, ranking and rollout code timed in plain Node on generated files, with no app and no virtual machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { median } from './aggregate.mjs';
import { TRANSCRIPT_SHAPES, acpTranscript, claudeMessages, codexRollout, pathListing } from './history.mjs';

const require = createRequire(import.meta.url);
const { ItemsLog } = require('../../electron/platform/itemsLog.cjs');
const { listChats, searchChats } = require('../../electron/harness/acp/history.cjs');
const { rank } = require('../../electron/platform/search.cjs');
const { core, requiredCore } = require('../../electron/platform/core.cjs');
const { buildAcpTurns, readChatTurns } = require('../../electron/harness/items/acpTranslator.cjs');
const { openHistory, historyPage, releaseHistory, allTurns } = require('../../electron/platform/claudeHistory.cjs');

const MB = 1024 * 1024;
const LONG_CHATS = [10 * MB, 50 * MB];
const MANY_CHATS = { count: 300, bytes: MB / 5 };
const LISTINGS = [20_000, 100_000];
const QUERIES = { short: 'cmp', long: 'components/widgets/file' };
const ROLLOUT_BYTES = 50 * MB;
const MISSING_TERM = 'no transcript holds these words';

const parseKey = (/** @type {string} */ key) => ({ harness: 'perf', id: key });

/** @typedef {{ name: string, ms: number, min: number, max: number, reps: number }} Row */

/** `run` timed `reps` times, as one row in whole hundredths of a millisecond. */
async function timed(/** @type {string} */ name, /** @type {number} */ reps, /** @type {() => unknown} */ run) {
  const times = [];
  for (let i = 0; i < reps; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  const hundredths = (/** @type {number} */ ms) => Math.round(ms * 100) / 100;
  return {
    name,
    ms: hundredths(/** @type {number} */ (median(times))),
    min: hundredths(Math.min(...times)),
    max: hundredths(Math.max(...times)),
    reps,
  };
}

/** One chat's transcript read through ItemsLog, parsed, built into turns and copied as IPC would copy them. */
async function oneChat(
  /** @type {InstanceType<typeof ItemsLog>} */ items,
  /** @type {(typeof TRANSCRIPT_SHAPES)[number]} */ shape,
  /** @type {number} */ bytes,
  /** @type {number} */ reps,
) {
  const id = `perf:${shape}-${bytes}`;
  fs.writeFileSync(items.file(id), acpTranscript(id, bytes, shape));
  const size = `${shape} ${(bytes / MB).toFixed(1)} MB`;
  const text = await items.readText(id);
  const records = items.parse(text);
  const turns = buildAcpTurns(records, id, '/perf');
  return [
    await timed(`acp read, ${size}`, reps, () => items.readText(id)),
    await timed(`acp parse, ${size}`, reps, () => items.parse(text)),
    await timed(`acp build turns, ${size}`, reps, () => readChatTurns({ items, chats: new Map() }, id, id, { cwd: '/perf' })),
    await timed(`acp copy turns, ${size}`, reps, () => v8.deserialize(v8.serialize(turns))),
  ];
}

/** One Claude chat's messages through the core: its read, which is off the main thread, then what main does with it. */
async function claudeChat(/** @type {number} */ bytes, /** @type {number} */ reps) {
  const messages = claudeMessages(bytes);
  const size = `${(bytes / MB).toFixed(1)} MB`;
  const read = () => openHistory(messages, 'chat', '/perf', { key: 'perf' });
  const held = await read();
  const rows = [
    await timed(`claude read, ${size}`, reps, async () => releaseHistory(await read())),
    await timed(`claude first page, ${size}`, reps, () => historyPage(held, { liveTail: true, closedTail: true, limit: 30 })),
    await timed(`claude all turns, ${size}`, reps, () => allTurns(held)),
  ];
  releaseHistory(held);
  return rows;
}

/**
 * Every row of the benchmark, on files in `dir`; `scale` multiplies the sizes, so a test can run small ones.
 * @returns {Promise<Row[]>}
 */
export async function readPathRows({ dir, reps = 5, scale = 1 }) {
  const sized = (/** @type {number} */ n) => Math.max(1, Math.round(n * scale));
  const rows = [];

  const long = new ItemsLog(path.join(dir, 'long'));
  fs.mkdirSync(long.dir);
  for (const shape of TRANSCRIPT_SHAPES) for (const bytes of LONG_CHATS) rows.push(...(await oneChat(long, shape, sized(bytes), reps)));

  for (const bytes of LONG_CHATS) rows.push(...(await claudeChat(sized(bytes), reps)));

  const many = new ItemsLog(path.join(dir, 'many'));
  fs.mkdirSync(many.dir);
  const count = Math.max(2, sized(MANY_CHATS.count));
  for (let i = 0; i < count; i++) fs.writeFileSync(many.file(`perf:${i}`), acpTranscript(`c${i}`, sized(MANY_CHATS.bytes)));
  rows.push(await timed(`acp list, ${count} chats`, reps, () => listChats(many, parseKey)));
  rows.push(await timed(`acp search miss, ${count} chats`, reps, () => searchChats(many, parseKey, MISSING_TERM)));

  for (const paths of LISTINGS) {
    const files = pathListing(sized(paths));
    for (const [kind, query] of Object.entries(QUERIES))
      rows.push(await timed(`rank ${kind} query, ${files.length} paths`, reps, () => rank(files, query)));
  }

  const rollout = codexRollout('perf', sized(ROLLOUT_BYTES));
  const rolloutFile = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(rolloutFile, rollout);
  rows.push(await timed(`codex rollout parse, ${(rollout.length / MB).toFixed(1)} MB`, reps, () => readRollout(rolloutFile)));
  return rows;
}

/** A rollout's turns through the core, as the app reads one, all of them onto the JS heap. */
async function readRollout(/** @type {string} */ file) {
  const addon = requiredCore(core());
  const call = async (/** @type {string} */ route, /** @type {string} */ payload) =>
    JSON.parse(String(await addon.dispatch(route, Buffer.from(payload))));
  const { id, count } = await call('rollout.open', file);
  const turns = await call('rollout.page', `${id} 0 ${count}`);
  await call('rollout.close', String(id));
  return turns;
}

/** The rows as a Markdown table. */
export function readPathTable(/** @type {Row[]} */ rows) {
  const lines = rows.map((r) => `| ${r.name} | ${r.ms} | ${r.min} | ${r.max} |`);
  return ['| Path | Median ms | Min | Max |', '| --- | --- | --- | --- |', ...lines].join('\n');
}

/** The command: the table on standard output, and with `--out` the rows as JSON. */
export async function main(/** @type {string[]} */ args) {
  const { values } = parseArgs({
    args,
    options: { reps: { type: 'string', default: '5' }, scale: { type: 'string', default: '1' }, out: { type: 'string' } },
  });
  const reps = Number(values.reps);
  const scale = Number(values.scale);
  // no repetition would time nothing and print rows of 0 ms
  if (!Number.isInteger(reps) || reps < 1) throw new Error(`--reps needs a whole number of 1 or more, not ${values.reps}`);
  if (!(scale > 0 && Number.isFinite(scale))) throw new Error(`--scale needs a number above 0, not ${values.scale}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-readpaths-'));
  try {
    const rows = await readPathRows({ dir, reps, scale });
    console.log(`Node ${process.version} ${process.arch}, synthetic files\n\n${readPathTable(rows)}`);
    if (values.out) fs.writeFileSync(values.out, `${JSON.stringify({ node: process.version, arch: process.arch, rows }, null, 2)}\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// the command line entry
if (import.meta.url === pathToFileURL(String(process.argv[1])).href) await main(process.argv.slice(2));
