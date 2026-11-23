// The harness stdio benchmark (docs/performance/measurement.md): a stand-in harness's stdout to the JS callback, through
// the app's own spawn and JSON reader (the core frames the lines, JS parses them), in plain Node, with no app and no
// virtual machine. It records the latency from a line's write to its value (p50, p95, max), main's busy time per event
// and how long a spawn takes, at a Codex rate and at a burst.
//
//   node scripts/perf-bench/stdio.mjs [--engine core|node] [--reps 3] [--scale 1] [--out file.json]
//
// `core` is the path harnesses run on (electron/platform/coreChild.cjs); `node` is node:child_process under the same
// spawnGroup and reader, which is what they ran on before, kept so each run can say the difference.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { spawnCore } = require('../../electron/platform/coreChild.cjs');
const { spawnGroup } = require('../../electron/platform/winbin.cjs');
const { JsonReader } = require('../../electron/transport/jsonReader.cjs');

const WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stdio-writer.mjs');
/** The streaming benchmark's S3: four chats at 120 tokens a second, each token one delta. */
const CODEX_RATE = 4 * 120;
const STEADY_SECONDS = 6;
const LINE_BYTES = 300;
const BURST_LINES = 20_000;
const RECORD_BYTES = 32 << 20;
const SPAWNS = 40;

/** `sorted`'s value at quantile `q`. @param {number[]} sorted @param {number} q */
const at = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
/** A millisecond figure in whole microseconds. @param {number} ms */
const fine = (ms) => Math.round(ms * 1000) / 1000;

/**
 * One writer run: its lines through the reader Codex reads with, timed from write to value.
 * @param {typeof nodeSpawn} spawn @param {string[]} args
 */
function readRun(spawn, args) {
  return new Promise((resolve, reject) => {
    /** @type {number[]} */
    const latency = [];
    const elu = performance.eventLoopUtilization();
    const cpu = process.cpuUsage();
    const proc = /** @type {any} */ (
      spawnGroup(spawn, process.execPath, [WRITER, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, lines: {} })
    );
    const reader = new JsonReader({
      stream: proc.stdout,
      onValue: (/** @type {{ t: number }} */ value) => latency.push((Number(process.hrtime.bigint()) - value.t) / 1e6),
      onError: reject,
    });
    proc.on('error', reject);
    proc.stdout.on('data', (/** @type {Buffer} */ chunk) => reader.push(chunk));
    proc.on('exit', () =>
      reader.finishInput(() => {
        const busy = performance.eventLoopUtilization(elu).active;
        const used = process.cpuUsage(cpu);
        latency.sort((a, b) => a - b);
        resolve({
          events: latency.length,
          p50: fine(at(latency, 0.5)),
          p95: fine(at(latency, 0.95)),
          max: fine(latency[latency.length - 1]),
          mainUsPerEvent: fine((busy * 1000) / Math.max(1, latency.length)),
          cpuMs: Math.round((used.user + used.system) / 1000),
        });
      }),
    );
  });
}

/**
 * How long a spawn holds main, and how long a child that does nothing takes to be told of.
 * @param {typeof nodeSpawn} spawn @param {number} spawns
 */
async function spawnRun(spawn, spawns) {
  /** @type {number[]} */
  const held = [];
  /** @type {number[]} */
  const told = [];
  for (let i = 0; i < spawns; i++) {
    const start = performance.now();
    const proc = /** @type {any} */ (spawnGroup(spawn, '/usr/bin/true', [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env }));
    held.push(performance.now() - start);
    proc.stdout.resume();
    proc.stderr.resume();
    await new Promise((resolve) => proc.on('close', resolve));
    told.push(performance.now() - start);
  }
  held.sort((a, b) => a - b);
  told.sort((a, b) => a - b);
  return { spawns, heldP50: fine(at(held, 0.5)), heldMax: fine(held[held.length - 1]), closedP50: fine(at(told, 0.5)) };
}

/** The middle run of `runs` by p95, or by what `by` reads. @template T @param {T[]} runs @param {(run: T) => number} by */
const middle = (runs, by) => [...runs].sort((a, b) => by(a) - by(b))[Math.floor(runs.length / 2)];

/**
 * Every figure of `engine`: each run `reps` times, keeping the middle one, at `scale` of the full sizes.
 * @param {{ engine: 'core' | 'node', reps: number, scale?: number }} o
 */
export async function bench({ engine, reps, scale = 1 }) {
  const scaled = (/** @type {number} */ size) => String(Math.ceil(size * scale));
  const spawn = /** @type {typeof nodeSpawn} */ (engine === 'node' ? nodeSpawn : spawnCore);
  const repeated = async (/** @type {() => Promise<any>} */ run) => {
    const runs = [];
    for (let i = 0; i < reps; i++) runs.push(await run());
    return middle(runs, (r) => r.p95 ?? r.heldP50);
  };
  return {
    engine,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    steady: await repeated(() => readRun(spawn, ['steady', String(CODEX_RATE), String(STEADY_SECONDS * scale), String(LINE_BYTES)])),
    burst: await repeated(() => readRun(spawn, ['burst', scaled(BURST_LINES), String(LINE_BYTES)])),
    record: await repeated(() => readRun(spawn, ['record', scaled(RECORD_BYTES)])),
    spawn: await repeated(() => spawnRun(spawn, Number(scaled(SPAWNS)))),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string', default: 'core' },
      reps: { type: 'string', default: '3' },
      scale: { type: 'string', default: '1' },
      out: { type: 'string' },
    },
  });
  const engine = /** @type {'core' | 'node'} */ (values.engine);
  const result = await bench({ engine, reps: Number(values.reps), scale: Number(values.scale) });
  const text = JSON.stringify(result, null, 2);
  if (values.out) fs.writeFileSync(values.out, `${text}\n`);
  console.log(text);
}
