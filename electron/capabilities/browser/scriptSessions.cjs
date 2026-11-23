// Browser-script workers per chat: serialized sandbox source, queued calls, cancellation and session retirement.
const { noteIgnored } = require('../../ignored.cjs');
const { Worker } = require('node:worker_threads');
const { ToolError } = require('../contract/registry.cjs');
const { scriptRuntime, persist, withReturn, workerMain, hardenRealm } = require('./scriptRuntime.cjs');

const LOG_MAX = 20_000;

const WORKER_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
(${hardenRealm})(globalThis, [Function, Object.getPrototypeOf(async function () {}).constructor, Object.getPrototypeOf(function* () {}).constructor, Object.getPrototypeOf(async function* () {}).constructor]);
(${workerMain})(parentPort, vm, ${JSON.stringify(`(${scriptRuntime})`)}, workerData, ${withReturn}, ${persist});
`;

const WORKER_OPTIONS = {
  eval: true,
  env: {},
  stdout: true,
  stderr: true,
  resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
};

/**
 * A chat's script session: one worker (one context) that runs its browser_script calls one at a time,
 * so a call sees the top-level declarations of the calls before it. A call that times out, is stopped
 * or crashes the worker ends the session (the next call starts a fresh one and says so); so does the
 * turn's end (end()).
 */
/**
 * @typedef {{ run: number, w: Worker, dispatch: (op: string, args: object) => unknown, logs: string[], size: number,
 *             dropped: number, finish: (r: object, kill?: string | null) => void }} ActiveRun
 */

class ScriptSession {
  constructor({ init, makeWorker = (src, o) => new Worker(src, o) }) {
    this.init = init;
    this.makeWorker = makeWorker;
    /** @type {Worker | null} */
    this.worker = null;
    this.queue = Promise.resolve();
    this.seq = 0;
    /** @type {ActiveRun | null} the call running now */
    this.active = null;
    /** @type {string | null} why the session ended mid-call, told to the next call */
    this.lost = null;
  }

  /**
   * Runs one call's code (after the calls before it). `dispatch(op, args)` answers its API calls.
   * Resolves (never rejects) { ok, value?, undef?, error?: { message, code, name?, line?, stack? },
   * logs, dropped, ms, lost } - lost: why the earlier calls' declarations are gone, when they are.
   */
  run(o) {
    const p = this.queue.then(() => this.#run(o));
    this.queue = p;
    return p;
  }

  /** Lets go of the worker: the context and its declarations go with it. */
  end() {
    const w = this.worker;
    this.worker = null;
    this.lost = null;
    if (w)
      Promise.resolve(w.terminate()).catch((error) => {
        // the worker may already have exited
        noteIgnored('terminate the browser_script worker at turn end', error);
      });
    this.active?.finish({ ok: false, error: { message: 'The turn ended.', code: 'aborted' } });
  }

  /** @returns {Worker} the new worker, which is now the session's */
  #spawn() {
    const w = this.makeWorker(WORKER_SOURCE, { ...WORKER_OPTIONS, workerData: { init: this.init } });
    this.worker = w;
    w.on('message', (raw) => this.#message(w, raw));
    w.on('error', (/** @type {any} */ e) => this.#died(w, `The script stopped: ${e?.message || e}`));
    w.on('exit', () => this.#died(w, 'The script stopped before it finished.'));
    return w;
  }

  #died(w, message) {
    if (this.worker !== w) return;
    this.worker = null;
    this.lost = 'its worker stopped';
    this.active?.finish({ ok: false, error: { message, code: 'crashed' } });
  }

  #run(
    /** @type {{ code: string, timeoutMs: number, signal?: AbortSignal | null, current?: unknown, dispatch: ActiveRun['dispatch'] }} */ {
      code,
      timeoutMs,
      signal = null,
      current = null,
      dispatch,
    },
  ) {
    return new Promise((resolve) => {
      const lost = this.lost;
      this.lost = null;
      const fresh = !this.worker;
      const w = this.worker || this.#spawn();
      const run = ++this.seq;
      const started = Date.now();
      /** @type {ActiveRun} */
      const a = {
        run,
        w,
        dispatch,
        logs: [],
        size: 0,
        dropped: 0,
        // once: everything that can end the run (done, timeout, stop, crash, end) goes through here and is undone
        finish: (r, kill = null) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', stop);
          this.active = null;
          if (kill && this.worker === w) {
            this.worker = null;
            this.lost = kill;
            Promise.resolve(w.terminate()).catch((error) => {
              // the worker may already have exited
              noteIgnored('terminate a stopped or failed browser_script worker', error);
            });
          }
          resolve({ ...r, logs: a.logs, dropped: a.dropped, ms: Date.now() - started, lost: fresh ? lost : null });
        },
      };
      this.active = a;
      const stop = () => a.finish({ ok: false, error: { message: 'The turn was stopped.', code: 'aborted' } }, 'the turn was stopped');
      const timer = setTimeout(
        () =>
          a.finish(
            { ok: false, error: { message: `The script didn't finish within ${timeoutMs} ms.`, code: 'script_timeout' } },
            'a script timed out',
          ),
        timeoutMs,
      );
      timer.unref?.();
      if (signal?.aborted) return stop();
      signal?.addEventListener('abort', stop, { once: true });
      w.postMessage(JSON.stringify({ t: 'run', run, code, current }));
    });
  }

  #message(w, raw) {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    const a = this.active?.w === w ? this.active : null;
    const reply = (msg) => {
      if (this.worker === w) w.postMessage(JSON.stringify(msg));
    };
    if (m.t === 'log') {
      if (!a) return;
      const text = `${m.level === 'log' ? '' : `[${m.level}] `}${String(m.text)}`;
      if (a.size + text.length > LOG_MAX) a.dropped++;
      else {
        a.size += text.length + 1;
        a.logs.push(text);
      }
    } else if (m.t === 'call') {
      // a call an earlier script left running (not awaited) has no script to answer to any more
      if (!a)
        return reply({ id: m.id, ok: false, error: { message: 'The script that made this call already finished.', code: 'finished' } });
      Promise.resolve()
        .then(() => a.dispatch(String(m.op), m.args && typeof m.args === 'object' ? m.args : {}))
        .then(
          (value) => reply({ id: m.id, ok: true, value: value ?? null }),
          (e) =>
            reply({
              id: m.id,
              ok: false,
              error: { message: String(e?.message || e), code: e instanceof ToolError && e.code ? e.code : 'failed' },
            }),
        );
    } else if (m.t === 'done' && a && a.run === m.run)
      a.finish(m.ok ? { ok: true, value: m.value, undef: !!m.undef } : { ok: false, error: m.error });
  }
}

/** Each chat's script session, made on its first call and ended with the turn (or the chat). */
class ScriptSessions {
  /**
   * @param {object} [o]
   * @param [o.init] what each session's worker starts with
   * @param [o.makeWorker] (source, options) => Worker (tests)
   */
  constructor({ init, makeWorker } = {}) {
    this.init = init;
    this.makeWorker = makeWorker;
    this.byChat = new Map();
  }

  get(chatId) {
    let s = this.byChat.get(chatId);
    if (!s) this.byChat.set(chatId, (s = new ScriptSession({ init: this.init, makeWorker: this.makeWorker })));
    return s;
  }

  end(chatId) {
    const s = this.byChat.get(chatId);
    if (!s) return;
    this.byChat.delete(chatId);
    s.end();
  }

  endAll() {
    for (const chatId of [...this.byChat.keys()]) this.end(chatId);
  }
}

module.exports = { ScriptSession, ScriptSessions, WORKER_SOURCE, LOG_MAX };
