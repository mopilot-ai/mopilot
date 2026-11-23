// The chat commit benchmark (docs/architecture/rust-core.md §6 step 2): what ChatsStore.commit spends writing a record, in
// plain Node, with no app. `core` is what it runs now (the record's JSON written whole by the Rust core's store.writeRecord,
// electron/platform/recordFiles.cjs); `js` is fsutil's writeAtomic, which wrote it before Stage 4.5 and still writes the
// other state files. A small record and a 1 MB one, the two engines taking turns, each figure the median of the rounds.
//
//   node scripts/perf-bench/commit.mjs [--rounds 5] [--scale 1] [--out file.json]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { median } from './aggregate.mjs';

const require = createRequire(import.meta.url);
const { writeAtomic } = require('../../electron/platform/fsutil.cjs');
const { writeRecordFile } = require('../../electron/platform/recordFiles.cjs');
const { keepPrivate } = require('../../electron/platform/privateFiles.cjs');

/** The writers timed: what a commit calls with the record's file and its JSON. */
export const ENGINES = { core: writeRecordFile, js: writeAtomic };
/** Commits per round: a small record's write is microseconds, so a round makes many. */
const COMMITS = { small: 400, large: 40 };

/** A chat record as commit writes it, its notes padded to about `bytes`. @param {number} bytes */
export function record(bytes) {
  return {
    id: 'claude:5f0c7a52-perf',
    segments: [{ kind: 'claude', nativeId: '5f0c7a52-perf', instance: null, provider: null, model: 'opus', start: 0, count: null }],
    meta: { pinned: true, unread: false, archived: null, worktreeOf: null, account: 'default', notes: 'n'.repeat(bytes) },
    schemaVersion: 2,
    updatedAt: 1_762_900_000_000,
  };
}

/** Microseconds per commit of `rec` through `write`, over `commits` commits of one file. */
function round(/** @type {(file: string, text: string) => void} */ write, /** @type {string} */ file, rec, /** @type {number} */ commits) {
  const start = performance.now();
  for (let i = 0; i < commits; i++) write(file, JSON.stringify({ ...rec, updatedAt: rec.updatedAt + i }));
  return ((performance.now() - start) * 1000) / commits;
}

/**
 * Each size's figures for each engine: `rounds` rounds, the engines alternating within each, so a disk or a CPU that
 * changes speed partway is shared between them. Written in a private data folder, as the app's chats are.
 * @param {{ rounds?: number, scale?: number, dir?: string }} [o]
 */
export function bench({ rounds = 5, scale = 1, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-commit-bench-')) } = {}) {
  keepPrivate(dir);
  const sizes = { small: record(600), large: record(1 << 20) };
  /** @type {Record<string, Record<string, { usPerCommit: number, min: number, max: number }>>} */
  const result = {};
  try {
    for (const [size, rec] of Object.entries(sizes)) {
      const commits = Math.max(1, Math.round(COMMITS[/** @type {'small' | 'large'} */ (size)] * scale));
      /** @type {Record<string, number[]>} */
      const times = { core: [], js: [] };
      for (let r = 0; r < rounds; r++)
        for (const name of r % 2 ? ['js', 'core'] : ['core', 'js'])
          times[name].push(
            round(ENGINES[/** @type {'core' | 'js'} */ (name)], path.join(dir, 'threads', `${name}-${size}.v2`), rec, commits),
          );
      const hundredths = (/** @type {number} */ us) => Math.round(us * 100) / 100;
      result[size] = Object.fromEntries(
        Object.entries(times).map(([name, t]) => [
          name,
          { usPerCommit: hundredths(/** @type {number} */ (median(t))), min: hundredths(Math.min(...t)), max: hundredths(Math.max(...t)) },
        ]),
      );
      result[size].bytes = /** @type {any} */ (Buffer.byteLength(JSON.stringify(rec)));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { node: process.version, platform: `${process.platform}-${process.arch}`, rounds, ...result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { rounds: { type: 'string', default: '5' }, scale: { type: 'string', default: '1' }, out: { type: 'string' } },
  });
  const text = JSON.stringify(bench({ rounds: Number(values.rounds), scale: Number(values.scale) }), null, 2);
  if (values.out) fs.writeFileSync(values.out, `${text}\n`);
  console.log(text);
}
