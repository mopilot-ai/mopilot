// Runs a benchmark fake: the e2e fake harness loaded in this process, its stdout rewritten line by line (rewrite.mjs) so each reply is the benchmark's, paced by the run's control folder (PERF_BENCH_CONTROL).
//
// In this process, not a child: MoPilot accepts a tool bridge (sage-mcp) only from a direct child of the harness
// process it started (electron/capabilities/mcp/socket.cjs), and the fake starts sage-mcp itself.
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { PROTOCOLS, createRewriter } from './rewrite.mjs';
import { logEvent, makeReply, play, readSettings, waitGate } from './replay.mjs';

/**
 * @typedef {{ stdin: NodeJS.ReadableStream, stdout: { write: (...a: any[]) => boolean }, exit: (code?: number) => void }} Proc
 */

/**
 * @param {'codex' | 'claude' | 'acp'} protocol
 * @param {URL} inner the e2e fake to run
 * @param {{ env?: Record<string, string | undefined>, proc?: Proc, load?: (url: URL) => Promise<unknown> }} [deps]
 *   proc: the process whose stdio and exit the fake uses (tests pass a stand-in); load: runs the fake
 */
export async function runFake(
  protocol,
  inner,
  { env = process.env, proc = /** @type {Proc} */ (/** @type {unknown} */ (process)), load = (url) => import(url.href) } = {},
) {
  const dir = env.PERF_BENCH_CONTROL || undefined;
  const realStdin = proc.stdin;
  const realWrite = proc.stdout.write.bind(proc.stdout);
  const realExit = proc.exit.bind(proc);
  const rewriter = createRewriter({
    protocol: PROTOCOLS[protocol],
    settings: () => readSettings(dir),
    out: (line) => realWrite(`${line}\n`),
    player: (s, on) => play(s, on, { gate: () => (s.gate ? waitGate(dir) : Promise.resolve()) }),
    reply: makeReply,
    log: (e) => logEvent(dir, { protocol, ...e }),
  });

  // what the fake writes, a line at a time
  let partial = '';
  proc.stdout.write = (/** @type {string | Uint8Array} */ chunk, /** @type {any} */ encoding, /** @type {any} */ cb) => {
    partial +=
      typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk).toString(/** @type {BufferEncoding} */ (typeof encoding === 'string' ? encoding : 'utf8'));
    for (let i = partial.indexOf('\n'); i >= 0; i = partial.indexOf('\n')) {
      rewriter.fromAgent(partial.slice(0, i));
      partial = partial.slice(i + 1);
    }
    (typeof encoding === 'function' ? encoding : cb)?.();
    return true;
  };
  // what MoPilot writes, seen before the fake reads it
  const input = new PassThrough();
  const fromClient = readline.createInterface({ input: realStdin });
  fromClient.on('line', (line) => {
    rewriter.fromClient(line);
    input.write(`${line}\n`);
  });
  fromClient.on('close', () => input.end());
  Object.defineProperty(proc, 'stdin', { value: input, configurable: true, writable: true });
  // a fake that exits while a reply plays (its own turn ended, its input closed) leaves once the reply went out
  let exiting = false;
  proc.exit = (code = 0) => {
    if (exiting) return;
    exiting = true;
    if (!rewriter.busy()) return realExit(code);
    void rewriter.idle().then(() => realExit(code));
  };
  await load(inner);
}
