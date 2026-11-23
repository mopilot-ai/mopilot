// The Chrome comparison's `ext` arm Chrome: a scratch profile of its own, MoPilot's extension loaded unpacked over the DevTools pipe, and its pairing page answered (Pair) whenever MoPilot opens it.
//
// Google Chrome no longer loads an unpacked extension from the command line, so this Chrome starts with
// --remote-debugging-pipe and --enable-unsafe-extension-debugging, and the extension is loaded with
// Extensions.loadUnpacked. MoPilot opens the extension's options page with a one-time claim code when a chat
// first needs Chrome (browser/chromeExtension.cjs); a user would press Pair there, and this presses it for them,
// counting each pairing, so the arm measures the extension itself and how often it asks to pair.
import { trackProcessExit, waitForProcessExit } from './processExit.mjs';

/**
 * A DevTools protocol client over Chrome's pipe (fd 3 in, fd 4 out; messages end with a NUL byte).
 * @param {{ write: (s: string) => any, on?: (event: 'error', f: (e: any) => void) => any }} input @param {import('node:events').EventEmitter} output
 */
export function cdpPipe(input, output) {
  let next = 0;
  let pending = '';
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const calls = new Map();
  /** @type {Map<string, ((params: any, sessionId?: string) => void)[]>} */
  const listeners = new Map();
  output.on('data', (chunk) => {
    pending += String(chunk);
    let end = pending.indexOf('\0');
    while (end >= 0) {
      const m = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      end = pending.indexOf('\0');
      const call = calls.get(m.id);
      if (call) {
        calls.delete(m.id);
        if (m.error) call.reject(new Error(`${m.error.message}`));
        else call.resolve(m.result);
      } else for (const f of listeners.get(m.method) ?? []) f(m.params, m.sessionId);
    }
  });
  /** @type {Error | null} why the pipe is gone: every call then fails at once, those waiting and those to come */
  let gone = null;
  /** @param {Error} error */
  const fail = (error) => {
    const why = gone ?? error;
    gone = why;
    for (const c of calls.values()) c.reject(why);
    calls.clear();
  };
  output.on('close', () => fail(new Error('Chrome closed its DevTools pipe')));
  // a write to a pipe Chrome already closed (EPIPE) ends the client the same way
  input.on?.('error', (e) => fail(new Error(`Chrome's DevTools pipe failed: ${e?.message}`)));
  return {
    /** @param {string} method @param {any} [params] @param {string} [sessionId] @returns {Promise<any>} */
    send(method, params = {}, sessionId) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        if (gone) return reject(gone);
        calls.set(id, { resolve, reject });
        input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      });
    },
    /** Ends the client: every call fails with `error` (Chrome could not start, or went away). @param {Error} error */
    fail,
    /** @param {string} method @param {(params: any, sessionId?: string) => void} f */
    on(method, f) {
      listeners.set(method, [...(listeners.get(method) ?? []), f]);
    },
  };
}

/** How many times the pairing script runs on a page whose document was replaced under it (it was still loading). */
const LOAD_TRIES = 10;

/**
 * What the pairing page runs: waits for the claim code MoPilot put in its field, presses Pair, and returns the
 * extension's status once it settles ('no code' when the page had none). The page shows the status Pair answered
 * and is not told when it changes, so the script asks the extension's background (as the page itself does).
 */
export const PAIR_SCRIPT = `(async () => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50 && !$('code')?.value; i++) await sleep(100);
  if (!$('code')?.value) return 'no code';
  $('pair').click();
  let r = null;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    r = await chrome.runtime.sendMessage({ type: 'status' });
    if (r?.status !== 'connecting') break;
  }
  return r?.error || r?.status || '';
})()`;

/** Whether a target of the loaded extension (its worker or a page) shows up in Chrome within `waitMs`. */
async function started(cdp, id, waitMs, pollMs) {
  for (let waited = 0; ; waited += pollMs) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    if (targetInfos.some((t) => String(t.url).startsWith(`chrome-extension://${id}/`))) return true;
    if (waited >= waitMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Starts the arm's Chrome on its own scratch profile with the extension loaded unpacked, and answers its pairing page.
 * @param {{ spawn: typeof import('node:child_process').spawn, bin: string, userDataDir: string, extensionDir: string,
 *           url?: string, log?: (s: string) => void, retryMs?: number, closeMs?: number, startMs?: number, startPollMs?: number }} o
 *   retryMs: how long to wait before running the pairing script again when the page was still loading
 *   closeMs: how long Chrome gets to close before it is killed
 *   startMs: how long the loaded extension may take to show up as a target in Chrome (startPollMs between looks)
 * @returns {Promise<{ id: string, cdp: ReturnType<typeof cdpPipe>, pairings: () => Promise<number>, closeTabs: () => Promise<number>, close: () => Promise<void> }>}
 */
export async function startExtensionChrome({
  spawn,
  bin,
  userDataDir,
  extensionDir,
  url = 'about:blank',
  log = () => undefined,
  retryMs = 300,
  closeMs = 5000,
  startMs = 10_000,
  startPollMs = 250,
}) {
  const child = spawn(
    bin,
    [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const cdp = cdpPipe(/** @type {any} */ (child.stdio[3]), /** @type {any} */ (child.stdio[4]));
  const stopped = trackProcessExit(child);
  // Chrome could not start (no such executable): its calls fail instead of the process
  child.on('error', (e) => cdp.fail(new Error(`Chrome did not start: ${e?.message}`)));
  /** Closes Chrome, and kills it when it does not close in time (or already lost its pipe). */
  const close = async () => {
    let timer;
    const late = new Promise((r) => {
      timer = setTimeout(() => r('late'), closeMs);
    });
    const closed = await Promise.race([
      cdp.send('Browser.close').then(
        () => 'closed',
        (e) => (log(`ext: closing Chrome failed: ${e}`), 'failed'),
      ),
      late,
    ]);
    clearTimeout(timer);
    if (closed !== 'closed') child.kill();
    await waitForProcessExit(child, stopped, closeMs);
  };
  let id;
  try {
    ({ id } = await cdp.send('Extensions.loadUnpacked', { path: extensionDir }));
    // Chrome has answered with an id and then not kept the extension in some runs (10 chats failed on "not installed"): load it once more, then stop
    if (!(await started(cdp, id, startMs, startPollMs))) {
      log('ext: the extension did not start; loading it again');
      ({ id } = await cdp.send('Extensions.loadUnpacked', { path: extensionDir }));
      if (!(await started(cdp, id, startMs, startPollMs))) throw new Error(`the extension ${id} did not start in Chrome`);
    }
  } catch (e) {
    // a Chrome that started but could not load the extension does not stay behind
    await close();
    throw e;
  }
  const page = `chrome-extension://${id}/options.html`;
  let pairings = 0;
  const seen = new Set();
  /** @type {Set<Promise<void>>} pairing pages still being answered */
  const answering = new Set();
  // the page is attached as soon as Chrome creates it, so its first document may still be replaced while the script runs
  const evaluate = async (sessionId) => {
    for (let tries = 1; ; tries++) {
      try {
        return await cdp.send('Runtime.evaluate', { expression: PAIR_SCRIPT, awaitPromise: true, returnByValue: true }, sessionId);
      } catch (e) {
        if (tries >= LOAD_TRIES || !/context/i.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
  };
  const pair = async (targetId) => {
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const r = await evaluate(sessionId);
      const status = String(r?.result?.value ?? '');
      if (status !== 'no code') pairings++;
      log(`ext: pairing page answered: ${status}`);
      await cdp.send('Target.closeTarget', { targetId });
    } catch (e) {
      log(`ext: pairing page failed: ${e}`);
    }
  };
  const onTarget = ({ targetInfo: t }) => {
    const offered =
      t.type === 'page' && String(t.url).startsWith(`${page}#`)
        ? new URLSearchParams(String(t.url).slice(page.length + 1)).get('pair')
        : null;
    // Native host pages connect themselves; their empty code field is not a manual pairing request to answer or close.
    if (!offered || offered === 'host' || seen.has(t.targetId)) return;
    seen.add(t.targetId);
    const p = pair(t.targetId).finally(() => answering.delete(p));
    answering.add(p);
  };
  cdp.on('Target.targetCreated', onTarget);
  cdp.on('Target.targetInfoChanged', onTarget);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  log(`ext: loaded MoPilot's extension ${id} into ${userDataDir}`);
  return {
    id,
    /** The DevTools pipe, for probes that inspect the arm's tabs. */
    cdp,
    /** The pairings so far, once the pages being answered now are done (so each is counted for the task that opened it). */
    async pairings() {
      while (answering.size) await Promise.all(answering);
      return pairings;
    },
    /**
     * Closes the pages the last task left (one blank tab stays, so Chrome stays open): each task starts clean, as tabs
     * kept from earlier chats piled up until Chrome stalled (#1699). Returns how many it closed.
     */
    async closeTabs() {
      const { targetId: keep } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { targetInfos = [] } = await cdp.send('Target.getTargets');
      let closed = 0;
      for (const t of targetInfos) {
        if (t.type !== 'page' || t.targetId === keep || !/^(?:https?:|about:blank)/.test(String(t.url))) continue;
        await cdp.send('Target.closeTarget', { targetId: t.targetId }).then(
          () => closed++,
          (e) => log(`ext: closing a tab failed: ${e}`),
        );
      }
      return closed;
    },
    close,
  };
}
