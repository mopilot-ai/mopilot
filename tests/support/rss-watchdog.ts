// A unit test process that grows past a memory limit, or outlives a time limit, is killed with the reason and its file.
//
// The watch runs on its own thread: what usually grows without bound is synchronous (node formatting a failed
// assertion whose value holds a happy-dom node, window or React event: AssertionError inspects with getters on and
// depth 1000, ignoring inspect.custom; tests/support/brief-assert.ts keeps the comparisons brief), so neither
// --test-timeout nor a timer on the test's own thread would fire, and --max-old-space-size does not bound memory held
// outside the JavaScript heap. The worker reads the process's resident memory every INTERVAL_MS and, past the limit,
// writes the reason straight to stderr and kills the process.
// The same worker bounds how long the process lives. --test-timeout ends a test that runs too long, but not a file
// whose tests all passed and whose process never exits because a timer, socket or child process was left open: main's
// unit run sat 40 and 100 minutes on one (#1759) and named nothing. Past the time limit the worker names the file, asks
// the main thread to list what is still open (it answers only when idle, which a leak leaves it), and kills it.
import { isMainThread, Worker } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import path from 'node:path';

/** The limit unless UNIT_TEST_RSS_LIMIT_MB sets another positive number. */
export const DEFAULT_LIMIT_MB = 6144;
export const INTERVAL_MS = 100;
/** How long a test process may live, unless UNIT_TEST_FILE_TIMEOUT_MS sets another positive number: in CI, where a
 * file takes about 1.5 s on average and no test may take over two minutes, and locally, where runs are niced and share
 * the computer. */
export const CI_FILE_TIMEOUT_MS = 5 * 60_000;
export const LOCAL_FILE_TIMEOUT_MS = 15 * 60_000;
/** How long the main thread has to list its open handles before the process is killed. */
export const GRACE_MS = 2000;

/** The resident memory, in MB, past which a test process is killed: UNIT_TEST_RSS_LIMIT_MB, else 6144. */
export function rssLimitMb(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.UNIT_TEST_RSS_LIMIT_MB);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT_MB;
}

/** How long, in ms, a test process may live: UNIT_TEST_FILE_TIMEOUT_MS, else 5 minutes in CI and 15 locally. */
export function fileTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.UNIT_TEST_FILE_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return env.CI ? CI_FILE_TIMEOUT_MS : LOCAL_FILE_TIMEOUT_MS;
}

/** What the process is running: the test file node --test started it for, or its arguments. */
export function processLabel(argv: string[], cwd: string): string {
  const args = argv.slice(1).map((arg) => (path.isAbsolute(arg) ? path.relative(cwd, arg) : arg));
  return args.join(' ').slice(0, 300) || 'node';
}

/** process.getActiveResourcesInfo() as one line, counted: `Timeout ×2, TCPSocketWrap`. */
export function describeHandles(resources: string[]): string {
  const counts = new Map<string, number>();
  for (const r of resources) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].map(([r, n]) => (n > 1 ? `${r} ×${n}` : r)).join(', ') || 'nothing';
}

/** The kinds of handle that keep this process alive. */
export const openHandles = (): string[] => process.getActiveResourcesInfo();
/** Straight to stderr: console output goes through streams a stuck process may never flush. */
export const toStderr = (line: string): number => writeSync(2, line);

/** The worker's code: plain CommonJS, so it needs none of the test loader hooks. */
export const WATCHDOG_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { limitMb, pid, what, intervalMs, timeoutMs, graceMs } = workerData;
// the processes under p, deepest last; none where pgrep finds none (it exits 1) or is missing
const descendants = (p) => {
  let kids = [];
  try {
    kids = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' }).split('\\n').filter(Boolean).map(Number);
  } catch {}
  return kids.flatMap((k) => [k, ...descendants(k)]);
};
// The test process and what it started: a child it leaked holds the runner's stdio open if it inherited it, and the
// runner waits for that to close, so killing the test process alone would leave the run hanging.
const killTree = (p) => {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(p)], { stdio: 'ignore' });
      return;
    } catch {}
  }
  for (const k of descendants(p)) {
    try {
      process.kill(k, 'SIGKILL');
    } catch {}
  }
  process.kill(p, 'SIGKILL');
};
const started = Date.now();
let late = false;
setInterval(() => {
  const mb = Math.round(process.memoryUsage.rss() / 1048576);
  if (mb > limitMb) {
    // straight to the file descriptor: the main thread, which would relay console output, may be stuck
    writeSync(2, '\\n[rss-watchdog] killed test process ' + pid + ' (' + what + ') at ' + mb + ' MB, over its ' + limitMb +
      ' MB limit (UNIT_TEST_RSS_LIMIT_MB). The usual cause is a failing assert whose value holds a DOM node, ' +
      'window or React event: compare strings, booleans or plain records instead.\\n');
    killTree(pid);
  }
  if (late || Date.now() - started <= timeoutMs) return;
  late = true;
  writeSync(2, '\\n[file-timeout] killing test process ' + pid + ' (' + what + '): it has not exited ' +
    Math.round(timeoutMs / 1000) + ' s after it started (UNIT_TEST_FILE_TIMEOUT_MS). Either a test is still running, ' +
    'or its tests finished and a timer, socket or child process they opened keeps it alive: close it when the test ends.\\n');
  parentPort.postMessage('timeout');
  setTimeout(() => killTree(pid), graceMs);
}, intervalMs);
`;

type WorkerLike = { unref(): void; on(event: 'message', listener: () => void): unknown };
type WorkerConstructor = new (source: string, options: Record<string, unknown>) => WorkerLike;

/** Start watching this process, once, from the main thread; the watch never keeps the process alive. */
export function startRssWatchdog({
  env = process.env,
  argv = process.argv,
  mainThread = isMainThread,
  WorkerClass = Worker as unknown as WorkerConstructor,
  resources = openHandles,
  write = toStderr,
}: {
  env?: Record<string, string | undefined>;
  argv?: string[];
  mainThread?: boolean;
  WorkerClass?: WorkerConstructor;
  resources?: () => string[];
  write?: (line: string) => unknown;
} = {}): WorkerLike | null {
  // a worker a test starts loads this file again through the inherited --import; the main thread's watch covers it
  if (!mainThread) return null;
  const what = processLabel(argv, process.cwd());
  const worker = new WorkerClass(WATCHDOG_SOURCE, {
    eval: true,
    // without the --import of the test loader, which would start a watch inside the watch
    execArgv: [],
    workerData: {
      limitMb: rssLimitMb(env),
      pid: process.pid,
      what,
      intervalMs: INTERVAL_MS,
      timeoutMs: fileTimeoutMs(env),
      graceMs: GRACE_MS,
    },
  });
  // what keeps the process alive, from the only thread that can see it; under node --test, PipeWrap ×3 is its stdio
  worker.on('message', () => write(`[file-timeout] still open in ${what}: ${describeHandles(resources())}\n`));
  worker.unref();
  return worker;
}
