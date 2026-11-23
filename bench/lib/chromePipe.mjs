// Chrome's DevTools protocol over --remote-debugging-pipe (Chrome reads fd 3 and writes fd 4, one JSON message per NUL),
// for the bench's own Chrome: MoPilot's unpacked extension is loaded on every start and checked to run. Chrome
// 155 ignores --load-extension and drops an extension loaded this way when it next starts, so loading it once leaves
// a profile that silently has none (#1561).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const { EXTENSION_ID } = createRequire(import.meta.url)('../../electron/capabilities/browser/chromeExtensionTransport.cjs');

/** MoPilot's extension id (its manifest key), whatever folder it is loaded from. */
export const MOPILOT_EXTENSION_ID = EXTENSION_ID;

/** The switches that open the pipe and allow Extensions.loadUnpacked on it. */
export const PIPE_ARGS = ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging'];

/** Chrome's stdio with the pipe: fd 3 is what Chrome reads, fd 4 what it writes. */
export const PIPE_STDIO = /** @type {const} */ (['inherit', 'inherit', 'inherit', 'pipe', 'pipe']);

/**
 * A client on Chrome's pipe: `send(method, params, sessionId)` resolves with the result, or rejects with the protocol
 * error, when no answer comes in `timeoutMs`, or when Chrome closes the pipe first; `on(method, f)` hears its events.
 * @param {{ write: (s: string) => unknown, on?: (e: string, f: (e: Error) => void) => unknown }} toChrome @param {{ on: (e: string, f: (d?: any) => void) => unknown }} fromChrome
 */
export function pipeClient(toChrome, fromChrome, { timeoutMs = 15_000 } = {}) {
  let rest = '';
  let id = 0;
  /** @type {Map<number, { resolve: (r: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, method: string }>} */
  const pending = new Map();
  /** @type {Map<string, ((params: any, sessionId?: string) => void)[]>} */
  const listeners = new Map();
  const settle = (/** @type {number} */ n) => {
    const p = pending.get(n);
    pending.delete(n);
    if (p) clearTimeout(p.timer);
    return p;
  };
  fromChrome.on('data', (chunk) => {
    // each chunk is split once: a message cut across chunks is joined from what the last one left over
    const parts = String(chunk).split('\0');
    parts[0] = rest + parts[0];
    rest = /** @type {string} */ (parts.pop());
    for (const line of parts) {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        // not a message (Chrome writes only JSON here): nothing waits on it
        continue;
      }
      // an event (no id): to whoever listens for its method
      if (m.id === undefined) {
        for (const f of listeners.get(m.method) ?? []) f(m.params ?? {}, m.sessionId);
        continue;
      }
      const p = settle(m.id);
      if (!p) continue;
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`));
      else p.resolve(m.result ?? {});
    }
  });
  const failAll = (/** @type {string} */ why) => {
    for (const n of [...pending.keys()]) {
      const p = /** @type {NonNullable<ReturnType<typeof settle>>} */ (settle(n));
      p.reject(new Error(`${p.method}: ${why}`));
    }
  };
  fromChrome.on('close', () => failAll('Chrome closed the pipe'));
  // a write after Chrome exited (EPIPE) fails what waits on it, never the process
  toChrome.on?.('error', (/** @type {Error} */ e) => failAll(e.message));
  /**
   * @param {string} method @param {Record<string, unknown>} [params] @param {string} [sessionId] a target attached flat
   * @returns {Promise<any>}
   */
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(n, { resolve, reject, timer, method });
      toChrome.write(`${JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  /** Calls `f` with each event of `method` (its params, and the session it came from). @param {string} method @param {(params: any, sessionId?: string) => void} f */
  const on = (method, f) => void listeners.set(method, [...(listeners.get(method) ?? []), f]);
  return { send, on };
}

/**
 * Loads the unpacked extension in `dir` and waits until its service worker runs: an extension that loaded but never
 * started is no use to browser use. Throws when Chrome refuses it, when it loads under another id than `id`, or when
 * its worker does not start in `waitMs`.
 * @param {{ send: (method: string, params?: Record<string, unknown>) => Promise<any> }} client @param {string} dir
 * @param {{ id?: string, waitMs?: number, pollMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} [o]
 */
export async function loadExtension(
  client,
  dir,
  { id = MOPILOT_EXTENSION_ID, waitMs = 10_000, pollMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {},
) {
  // a load over the profile's earlier one keeps that one's service worker registration, scripts included: the worker
  // would run the old files while the manifest is new (#1642). Uninstalling first registers the files in `dir`; the
  // pairing goes with it, and the wrapper pairs again (MOPILOT_SCRATCH_CHROME_PAIR). Nothing loaded yet: Chrome refuses.
  await client.send('Extensions.uninstall', { id }).then(
    () => undefined,
    (/** @type {Error} */ error) => error,
  );
  const loaded = await client.send('Extensions.loadUnpacked', { path: dir });
  if (loaded.id !== id) throw new Error(`${dir} loaded as ${loaded.id}, not MoPilot's extension ${id}`);
  const started = now();
  for (;;) {
    const { targetInfos = [] } = await client.send('Target.getTargets');
    const runs = targetInfos.some(
      (/** @type {{ type: string, url: string }} */ t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`),
    );
    if (runs) return { id, ms: now() - started };
    if (now() - started >= waitMs)
      throw new Error(`MoPilot's extension ${id} loaded, but its service worker did not start in ${waitMs} ms`);
    await sleep(pollMs);
  }
}

/**
 * Whether a Chrome runs on this profile now: its SingletonLock names "<host>-<pid>" and that process is alive. A start
 * on such a profile only hands its URLs to the running Chrome and quits, so it gets no pipe. A lock left by a Chrome
 * that is gone (a VM restart) does not count.
 * @param {string} userDataDir @param {{ readlink?: (p: string) => string, alive?: (pid: number) => boolean }} [o]
 */
export function runningOn(userDataDir, { readlink = (p) => fs.readlinkSync(p), alive = isAlive } = {}) {
  let target;
  try {
    target = readlink(path.join(userDataDir, 'SingletonLock'));
  } catch {
    // no lock: no Chrome holds the profile
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  return pid > 0 && alive(pid);
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: alive but another user's
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * How the wrapper starts Chrome with the extension: its switches with the pipe's, and no page yet, so nothing it was
 * asked to open (MoPilot's own pairing page among them) loads before the extension does; `urls` are opened over
 * the pipe once it runs.
 * @param {string[]} args
 */
export function pipeLaunch(args) {
  const switches = args.filter((a) => a.startsWith('--'));
  return {
    args: [...switches, ...PIPE_ARGS, ...(switches.includes('--no-startup-window') ? [] : ['about:blank'])],
    urls: args.filter((a) => !a.startsWith('--')),
  };
}

/** The profile a start names (--user-data-dir=…), or null. @param {string[]} args */
export const userDataDirOf = (args) => args.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) || null;

/** What the pairing page shows after Pair is pressed, read back by `pressPair`. */
const PRESS_PAIR = `(() => {
  const b = document.getElementById('pair'), code = document.getElementById('code');
  if (!b || !code || !code.value) return 'waiting';
  b.click();
  return 'pressed';
})()`;

/**
 * The bench operator's half of pairing: MoPilot opens the extension's options page with `#pair=<claim code>` and
 * a person presses Pair (by design, nothing pairs without it). In a bench run, which has no person, this presses it on
 * every such page Chrome opens, as the drivers answer MoPilot's approval cards. `report` hears each outcome.
 * @param {ReturnType<typeof pipeClient>} client @param {{ id?: string, report?: (what: string) => void, tries?: number,
 *   sleep?: (ms: number) => Promise<void> }} [o]
 */
export async function autoPair(
  client,
  {
    id = MOPILOT_EXTENSION_ID,
    report = (/** @type {string} */ _what) => undefined,
    tries = 20,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const page = `chrome-extension://${id}/options.html`;
  /** @type {Set<string>} each claim code is pressed once */
  const seen = new Set();
  const press = async (/** @type {{ targetId: string, type: string, url: string }} */ t) => {
    const claim = t.type === 'page' && t.url.startsWith(`${page}#`) ? new URLSearchParams(t.url.slice(page.length + 1)).get('pair') : null;
    // The native host route owns its Connect flow; only manual claim codes need the bench operator's Pair action.
    if (!claim || claim === 'host' || seen.has(claim)) return;
    seen.add(claim);
    try {
      const { sessionId } = await client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      // the page moves the code from its address into the field once it has loaded: press when it is there
      for (let i = 0; i < tries; i++) {
        const r = await client.send('Runtime.evaluate', { expression: PRESS_PAIR, returnByValue: true }, sessionId);
        if (r.result?.value === 'pressed') return report(`pressed Pair on MoPilot's pairing page (${t.targetId})`);
        await sleep(250);
      }
      report(`the pairing page never showed its code (${t.targetId})`);
    } catch (e) {
      report(`could not press Pair (${t.targetId}): ${/** @type {Error} */ (e).message}`);
    }
  };
  const look = (/** @type {{ targetInfo: any }} */ p) => void press(p.targetInfo);
  client.on('Target.targetCreated', look);
  client.on('Target.targetInfoChanged', look);
  await client.send('Target.setDiscoverTargets', { discover: true });
}

/**
 * Waits until the profile shows the extension on, as MoPilot's own check reads it (Chrome commits its preferences
 * some seconds after a load): MoPilot starts no Chrome for a profile it thinks lacks the extension. Throws with
 * the last state after `waitMs`.
 * @param {() => string | null} state extensionInProfile for the profile @param {{ waitMs?: number, pollMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number }} [o]
 */
export async function waitExtensionOn(
  state,
  { waitMs = 40_000, pollMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {},
) {
  const started = now();
  for (;;) {
    const s = state();
    if (s === 'on') return now() - started;
    if (now() - started >= waitMs)
      throw new Error(`the profile does not show MoPilot's extension on after ${waitMs} ms (it reads ${s ?? 'nothing'})`);
    await sleep(pollMs);
  }
}

/**
 * What a start of the wrapper ended with, from the lines it appended to <profile>/scratch-chrome.log since then: the
 * extension runs, the start was handed over to the running Chrome, or it failed (with the line). Null while it says
 * nothing yet. The profile's own preferences can't tell: they still list the extension a Chrome loaded before it quit,
 * until the next start drops it.
 * @param {string} appended the log's text past where it ended before the start
 * @returns {{ outcome: 'runs' | 'handed' | 'failed', line: string } | null}
 */
export function startOutcome(appended) {
  for (const line of appended.split('\n')) {
    if (/MoPilot's extension \S+ runs/.test(line)) return { outcome: 'runs', line };
    if (/handing the start over/.test(line)) return { outcome: 'handed', line };
    if (/Quitting this Chrome/.test(line)) return { outcome: 'failed', line };
  }
  return null;
}
