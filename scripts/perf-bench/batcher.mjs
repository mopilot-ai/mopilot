// The stream batcher benchmark (docs/performance/measurement.md): main's stream batcher in plain Node on a simulated clock,
// with no app and no virtual machine. It times main's work per delta at the S3 rate (four chats at 120 tokens a second,
// one delta a token) and in a burst, each tick's flush, a request's flush of the chats it names, an event that passes
// unbatched, for each harness family's shapes, and one command-output delta of 1 and 8 MB, alone and joined.
//
//   node scripts/perf-bench/batcher.mjs [--root <checkout>] [--reps 5] [--seconds 10] [--out file.json]
//
// `--root` runs a checkout's own batcher (another worktree, or an older tree unpacked with `git archive`), so a change can
// be timed before and after: one with electron/harness/coreBatcher.cjs runs the core's; one without it runs the batcher
// that tree has.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { median, percentile } from './aggregate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** S3: four chats at 120 tokens a second, each token one delta. */
const CHATS = 4;
const RATE = 120;
const BURST = 20_000;

/**
 * The batcher of the checkout at `root`, made the way main makes it, with `send` and the simulated clock's timers.
 * @param {string} root
 */
export function loadBatcher(root) {
  const req = createRequire(path.join(root, 'package.json'));
  const chats = { chatOf: (/** @type {string} */ key) => key };
  if (fs.existsSync(path.join(root, 'electron/harness/coreBatcher.cjs'))) {
    const { CoreBatcher, familyChats } = req('./electron/harness/coreBatcher.cjs');
    return {
      engine: 'core',
      /** @param {object} o */
      make(o) {
        const b = new CoreBatcher(o);
        for (const [family, chatOf] of Object.entries(familyChats(chats))) b.register(family, chatOf);
        return b;
      },
    };
  }
  // an older tree: the batcher it had, with its contracts
  const { StreamBatcher } = req('./electron/harness/streamBatcher.cjs');
  const { streamContracts } = req('./electron/harness/streamContracts.cjs');
  return {
    engine: 'js',
    /** @param {object} o */
    make(o) {
      const b = new StreamBatcher(o);
      for (const [family, contract] of Object.entries(streamContracts(chats))) b.register(family, contract);
      return b;
    },
  };
}

/** A simulated clock: timers fire when `advance` passes them, in order. */
export function clock() {
  let now = 0;
  let next = 1;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const pending = new Map();
  return {
    timers: {
      setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => (pending.set(next, { at: now + ms, fn }), next++),
      clearTimeout: (/** @type {number} */ id) => void pending.delete(id),
    },
    /** Run every timer due by `to`, timing each with `time`. @param {number} to @param {(fn: () => void) => void} time */
    advance(to, time) {
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        time(due[1].fn);
      }
      now = to;
    },
  };
}

/** A family's text delta for `chat`, in the shape its adapter emits, about 300 bytes as JSON. */
export const deltas = {
  codex: (/** @type {string} */ chat, /** @type {string} */ text, /** @type {number} */ n) => ({
    kind: 'notification',
    chatId: chat,
    method: 'item/agentMessage/delta',
    params: { threadId: chat, turnId: '019a2c1e-7b8f-7c31-9e0a-5d4f3b2a1c0d', itemId: `msg_${chat}_0001`, delta: text, seq: n },
    origin: 7,
  }),
  claude: (/** @type {string} */ chat, /** @type {string} */ text, /** @type {number} */ n) => ({
    kind: 'message',
    key: chat,
    account: 'default',
    msg: {
      type: 'stream_event',
      uuid: `5b1f2c3d-${n}`,
      session_id: '0c9d8e7f-6a5b-4c3d-2e1f-0a9b8c7d6e5f',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    },
  }),
  acp: (/** @type {string} */ chat, /** @type {string} */ text) => ({
    kind: 'update',
    key: chat,
    turnId: 'at-6f5e4d3c-2b1a-4098-8776-655443322110',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  }),
};

/** Mean, p95, p99 and max of times in microseconds. @param {number[]} us */
const stats = (us) => ({
  mean: us.reduce((a, b) => a + b, 0) / Math.max(us.length, 1),
  p95: percentile(us, 95),
  p99: percentile(us, 99),
  max: Math.max(0, ...us),
});

/**
 * One run of every scenario for `family`.
 * @param {ReturnType<typeof loadBatcher>} loaded @param {keyof typeof deltas} family @param {number} seconds
 */
export function runFamily(loaded, family, seconds) {
  const make = (/** @type {ReturnType<typeof clock>} */ c, /** @type {object} */ o = {}) =>
    loaded.make({ send: () => true, timers: c.timers, watched: () => true, hostOf: () => 'local', ...o });
  const delta = deltas[family];
  const word = 'tok ';

  // S3: CHATS chats at RATE deltas a second each, spread evenly, ticks firing as they fall due
  const steady = clock();
  const b = make(steady);
  /** @type {number[]} */
  const push = [];
  /** @type {number[]} */
  const tick = [];
  const timeTick = (/** @type {() => void} */ fn) => {
    const t = performance.now();
    fn();
    tick.push((performance.now() - t) * 1000);
  };
  const total = CHATS * RATE * seconds;
  for (let n = 0; n < total; n++) {
    const at = (n / (CHATS * RATE)) * 1000;
    steady.advance(at, timeTick);
    const event = delta(`chat-${n % CHATS}`, word, n);
    const t = performance.now();
    b.push(family, event);
    push.push((performance.now() - t) * 1000);
  }
  steady.advance(seconds * 1000 + 1000, timeTick);
  const busy = (push.reduce((a, x) => a + x, 0) + tick.reduce((a, x) => a + x, 0)) / seconds / 1000;

  // a burst: BURST deltas of one chat with no tick ending, joined until the bound sends them
  const burstClock = clock();
  const burst = make(burstClock);
  burst.push(family, delta('burst', word, 0));
  const t0 = performance.now();
  for (let n = 1; n <= BURST; n++) burst.push(family, delta('burst', word, n));
  const burstUs = ((performance.now() - t0) * 1000) / BURST;
  const f0 = performance.now();
  burst.flushAll();
  const burstFlushUs = (performance.now() - f0) * 1000;
  burst.cancel();

  // a request's flush: four chats with a tick's worth of deltas each, one named
  /** @type {number[]} */
  const named = [];
  /** @type {number[]} */
  const unbatched = [];
  const flushClock = clock();
  const f = make(flushClock);
  for (let r = 0; r < 200; r++) {
    for (let n = 0; n < CHATS * 8; n++) f.push(family, delta(`chat-${n % CHATS}`, word, n));
    const t = performance.now();
    f.flushNamed(['chat-1']);
    named.push((performance.now() - t) * 1000);
    // an event of the chat that is no delta (a status) flushes it and goes out at once
    const u = performance.now();
    f.push(family, { kind: 'status', chatId: 'chat-2', key: 'chat-2', text: '' });
    unbatched.push((performance.now() - u) * 1000);
    f.flushAll();
  }
  f.cancel();
  b.cancel();
  return {
    pushUs: stats(push),
    tickUs: stats(tick),
    mainMsPerSecond: busy,
    burstUsPerDelta: burstUs,
    burstFlushUs,
    namedFlushUs: stats(named),
    unbatchedEventUs: stats(unbatched),
  };
}

/**
 * One Codex command-output delta of `megabytes` while a tick runs: alone (past the bound, so it goes out at once), and
 * behind a small pending delta of its key, which it joins. Each push's time, in milliseconds.
 * @param {ReturnType<typeof loadBatcher>} loaded @param {number} megabytes
 */
export function runBig(loaded, megabytes) {
  const c = clock();
  const b = loaded.make({ send: () => true, timers: c.timers, watched: () => true, hostOf: () => 'local' });
  const output = (/** @type {string} */ text, /** @type {number} */ n) => ({
    ...deltas.codex('big', text, n),
    method: 'item/commandExecution/outputDelta',
  });
  const text = 'drwxr-xr-x  12 user  staff   384 Nov 13 10:00 src\n'.repeat(Math.round((megabytes * 1024 * 1024) / 49));
  // the leading edge: the tick runs from here, so what follows waits for it unless the bound sends it
  b.push('codex', deltas.codex('lead', 'tok ', 0));
  const time = (/** @type {any} */ event) => {
    const t = performance.now();
    b.push('codex', event);
    return performance.now() - t;
  };
  const aloneMs = time(output(text, 1));
  b.push('codex', output('$ ls -la\n', 2));
  const joinedMs = time(output(text, 3));
  b.cancel();
  return { aloneMs, joinedMs };
}

function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: path.join(HERE, '..', '..') },
      reps: { type: 'string', default: '5' },
      seconds: { type: 'string', default: '10' },
      out: { type: 'string' },
    },
  });
  const loaded = loadBatcher(path.resolve(values.root));
  const reps = Number(values.reps);
  /** @type {Record<string, any>} */
  const rows = {};
  for (const family of /** @type {(keyof typeof deltas)[]} */ (Object.keys(deltas))) {
    // a warm-up run, then the median of the reps of each figure
    runFamily(loaded, family, 2);
    const runs = Array.from({ length: reps }, () => runFamily(loaded, family, Number(values.seconds)));
    const med = (/** @type {(r: any) => number} */ pick) => median(runs.map(pick));
    rows[family] = {
      pushMeanUs: med((r) => r.pushUs.mean),
      pushP95Us: med((r) => r.pushUs.p95),
      pushP99Us: med((r) => r.pushUs.p99),
      pushMaxUs: med((r) => r.pushUs.max),
      tickMeanUs: med((r) => r.tickUs.mean),
      tickP95Us: med((r) => r.tickUs.p95),
      tickMaxUs: med((r) => r.tickUs.max),
      mainMsPerSecond: med((r) => r.mainMsPerSecond),
      burstUsPerDelta: med((r) => r.burstUsPerDelta),
      burstFlushUs: med((r) => r.burstFlushUs),
      namedFlushMeanUs: med((r) => r.namedFlushUs.mean),
      namedFlushP95Us: med((r) => r.namedFlushUs.p95),
      unbatchedEventMeanUs: med((r) => r.unbatchedEventUs.mean),
    };
  }
  for (const megabytes of [1, 8]) {
    const runs = Array.from({ length: reps }, () => runBig(loaded, megabytes));
    rows[`output${megabytes}mb`] = {
      aloneMs: median(runs.map((r) => r.aloneMs)),
      joinedMs: median(runs.map((r) => r.joinedMs)),
    };
  }
  const result = { engine: loaded.engine, node: process.version, reps, rows };
  const text = JSON.stringify(result, null, 2);
  if (values.out) fs.writeFileSync(values.out, `${text}\n`);
  console.log(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
