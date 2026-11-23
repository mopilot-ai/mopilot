// Passkey requests a built-in browser page is waiting on, for every harness. Electron has no Chrome
// passkey sheet (no phone QR code, no Chrome/iCloud passkeys), so a request with no authenticator here
// just hangs. Where macOS's own passkey sheet is allowed (the web-browser passkey entitlement), a modal
// request goes there instead, through the passkey bridge (passkeyBridge.cjs); otherwise, or for a request
// the bridge doesn't serve, Electron's path runs as before. A small wrapper in each frame's own world (as
// password-manager extensions install) carries those requests, reports pending navigator.credentials
// get/create calls over the console, and can end them as Chrome's Cancel
// does (NotAllowedError), so the site offers its other sign-in methods at once. It goes in before the
// page's own scripts (documentScripts.cjs), since a page may ask for a passkey as its <head> runs, and
// again once each frame commits, should the page's debugger be unavailable. It also corrects
// PublicKeyCredential.getClientCapabilities, where Electron reports the hybrid transport it lacks (the
// sheet offers it).
// Each document names itself in its reports: Electron gives a same-process subframe's console message the
// main frame, so main counts by that name, and Cancel asks every frame of the page.
const crypto = require('node:crypto');
const { noteIgnored } = require('../../ignored.cjs');
const { isWebUrl } = require('../../../shared/browser.mjs');
const { runBeforePage } = require('./documentScripts.cjs');
const { passkeyCodec } = require('./passkeyCodec.cjs');
const { createPasskeyBridge } = require('./passkeyBridge.cjs');

const PASSKEY_SIGNAL = 'mopilot-passkey:';

/**
 * Runs in the page (serialized with Function.prototype.toString, so it must not close over anything).
 * Logs `${signal}${doc}:${n}` whenever the document's count of pending passkey requests changes (and 0 as
 * it goes away), where `doc` names this document, and puts a function at globalThis[key] that cancels
 * them all and returns how many it cancelled, or with 'name' returns `doc` while any wait (else ''), or
 * with ('settle', id, answer) hands the passkey bridge's answer to the request it is for.
 * @param {string} key
 * @param {string} signal
 * @param {string} [binding] the passkey bridge's CDP binding: a modal request goes there while it exists
 * @param {typeof passkeyCodec} [codec]
 * @param {number} [ackWait] how long a request waits for the bridge to answer or start the sheet (ack) before the
 *   wrapper takes Electron's own path: a call the bridge never heard (a turn let go of the debugger) can't hang
 */
function passkeyWatch(key, signal, binding = '', codec = undefined, ackWait = 5000) {
  const G = globalThis;
  const creds = G.navigator?.credentials;
  if (!creds || Object.hasOwn(G, key)) return;
  const log = G.console.debug.bind(G.console);
  const doc = `d${G.Math.random().toString(36).slice(2, 12)}`;
  /** @type {Set<() => void>} */
  const live = new Set();
  /** requests the bridge has, by id: each takes the bridge's answer once */
  /** @type {Map<string, { settle: (answer: any) => void, ack: () => void }>} */
  const waiting = new Map();
  const codecFns = codec ? codec(G) : null;
  const bridge = () => (binding && codecFns && typeof G[binding] === 'function' ? G[binding] : null);
  /** 24 random base-36 characters (the bridge takes ids of 8 to 40) */
  const newId = () => G.Array.from(G.crypto.getRandomValues(new G.Uint8Array(24)), (b) => (b % 36).toString(36)).join('');
  const report = () => log(`${signal}${doc}:${live.size}`);
  // a document that goes (navigated away, or its frame removed) takes its requests with it
  G.addEventListener?.('pagehide', () => live.size && log(`${signal}${doc}:0`));
  for (const name of ['get', 'create']) {
    const native = creds[name];
    if (typeof native !== 'function') continue;
    const wrapped = {
      [name](options) {
        // autofill (conditional) requests wait quietly by design; other credential types never hang
        if (!options?.publicKey || options.mediation === 'conditional') return native.apply(this, arguments);
        const stop = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
        const viaNative = () => native.call(this, { ...options, signal });
        const send = bridge();
        const call =
          send && codecFns && !signal.aborted
            ? new Promise((resolve, reject) => {
                const id = newId();
                const say = (/** @type {object} */ m) => send(G.JSON.stringify({ id, ...m }));
                // no word from the bridge in time: Electron's own path, as if it had answered `fallback`
                const unheard = G.setTimeout(() => waiting.get(id)?.settle({ fallback: true }), ackWait);
                waiting.set(id, {
                  ack: () => G.clearTimeout(unheard),
                  settle: (answer) => {
                    G.clearTimeout(unheard);
                    waiting.delete(id);
                    if (answer.credential) resolve(codecFns.toCredential(answer.credential));
                    else if (answer.error) reject(new DOMException(answer.error.message, answer.error.name));
                    else resolve(viaNative());
                  },
                });
                signal.addEventListener(
                  'abort',
                  () => {
                    if (!waiting.has(id)) return;
                    G.clearTimeout(unheard);
                    waiting.delete(id);
                    say({ type: 'abort' });
                    reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                  },
                  { once: true },
                );
                say({ type: 'request', kind: name, options: codecFns.encode(options.publicKey) });
              })
            : viaNative();
        return new Promise((resolve, reject) => {
          const cancel = () => {
            stop.abort();
            reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
          };
          live.add(cancel);
          report();
          call.then(resolve, reject).finally(() => {
            live.delete(cancel);
            report();
          });
        });
      },
    }[name];
    Object.defineProperty(creds, name, { value: wrapped, writable: true, configurable: true });
  }
  // Electron claims Chrome's hybrid (phone QR) transport and its passkey sheet, so sites pick a passkey
  // that can't arrive; say what this browser really offers and they lead with other methods
  const PKC = G.PublicKeyCredential;
  const capabilities = PKC?.getClientCapabilities;
  if (typeof capabilities === 'function')
    Object.defineProperty(PKC, 'getClientCapabilities', {
      value: {
        getClientCapabilities() {
          return capabilities.call(this).then((c) => ({
            ...c,
            hybridTransport: !!bridge(),
            passkeyPlatformAuthenticator: !!bridge() || !!c.userVerifyingPlatformAuthenticator,
          }));
        },
      }.getClientCapabilities,
      writable: true,
      configurable: true,
    });
  Object.defineProperty(G, key, {
    value: (/** @type {string | undefined} */ mode, /** @type {string} */ id, /** @type {any} */ answer) => {
      if (mode === 'name') return live.size ? doc : '';
      if (mode === 'settle') {
        const take = waiting.get(id);
        if (!take || !answer || typeof answer !== 'object') return false;
        if (answer.ack) take.ack();
        else take.settle(answer);
        return true;
      }
      const n = live.size;
      for (const cancel of [...live]) cancel();
      return n;
    },
  });
}

/**
 * Watches a browser page's frames for pending passkey requests.
 * @param {any} wc the page's webContents
 * @param {() => void} onChange called when the page starts or stops waiting on a passkey
 */
function watchPasskeys(wc, onChange) {
  const key = `__mopilotPasskey_${crypto.randomUUID().replaceAll('-', '')}`;
  const binding = `__mopilotPasskeyBridge_${crypto.randomUUID().replaceAll('-', '')}`;
  const source = `(${passkeyWatch.toString()})(${JSON.stringify(key)}, ${JSON.stringify(PASSKEY_SIGNAL)}, ${JSON.stringify(binding)}, ${passkeyCodec.toString()})`;
  /** documents with pending requests, by the name each reports */
  const pending = new Set();
  /** the pane sent the page's request to Electron's Touch ID prompt (legacy), until nothing waits any more */
  let atLegacy = false;
  const bridge = createPasskeyBridge(wc, { key, binding, onChange });
  runBeforePage(wc, source, bridge.arm);
  const update = (change) => {
    const before = pending.size > 0;
    change();
    if (!pending.size) atLegacy = false;
    if (pending.size > 0 !== before) onChange();
  };
  /**
   * Every frame's answer to the page function (`arg`: its mode), skipping frames that went away. All at once: a
   * frame that doesn't answer (busy, or held by a dialog) doesn't hold up the others' Cancel.
   */
  const ask = (/** @type {string} */ arg, /** @type {string} */ what) =>
    Promise.all(
      (wc.mainFrame?.framesInSubtree ?? []).map((frame) =>
        frame.executeJavaScript(`globalThis[${JSON.stringify(key)}]?.(${arg}) ?? 0`).catch((error) => {
          // the frame went away (removed or swapped), and its requests with it
          noteIgnored(what, error);
          return 0;
        }),
      ),
    );
  /**
   * Drops the documents in `names` that no frame still waits in (one that went without its last report: a
   * subframe that navigated, a frame removed). Reports that arrive meanwhile are kept.
   */
  const prune = async (/** @type {string[]} */ names) => {
    if (!names.length) return;
    const waiting = new Set(await ask("'name'", 'read the passkey requests a browser page waits on'));
    update(() => {
      for (const doc of names) if (!waiting.has(doc)) pending.delete(doc);
    });
  };
  wc.on('did-frame-navigate', (_e, url, _code, _status, isMainFrame, processId, routingId) => {
    // a new page: the old one's requests went with it; a subframe's new document took its old one's, which
    // may not have said so as it went
    if (isMainFrame) update(() => pending.clear());
    else void prune([...pending]);
    if (!isWebUrl(url)) return;
    const frame = wc.mainFrame?.framesInSubtree?.find((f) => f.processId === processId && f.routingId === routingId);
    frame?.executeJavaScript(source).catch((error) => {
      // the frame went away or navigated again before the wrapper ran
      noteIgnored('watch a browser page for passkey requests', error);
    });
  });
  wc.on('console-message', (e) => {
    const message = String(e?.message ?? '');
    const report = message.startsWith(PASSKEY_SIGNAL) && /^([0-9a-z]+):(\d+)$/.exec(message.slice(PASSKEY_SIGNAL.length));
    if (!report) return;
    const [, doc, n] = report;
    update(() => (Number(n) > 0 ? pending.add(doc) : pending.delete(doc)));
  });
  wc.on('render-process-gone', () => update(() => pending.clear()));
  return {
    pending: () => pending.size > 0,
    /** The page's passkey state for its notice: waiting on one, at macOS's sheet, and what the pane may offer. */
    notice: () => ({ passkey: pending.size > 0, passkeySystem: atLegacy || bridge.active(), ...bridge.offers() }),
    /**
     * Ends the page's pending passkey requests as Chrome's Cancel would, in every frame of the page (a report
     * doesn't say which frame it came from); resolves to how many ended. `legacy`: the page's request at macOS's
     * sheet goes to Electron's own Touch ID authenticator instead, for a passkey an earlier build made there.
     */
    async cancel({ legacy = false } = {}) {
      if (legacy) {
        // set before the bridge's answer refreshes the notice, so it never flashes "can't provide"
        atLegacy = bridge.active();
        return bridge.cancel({ legacy: true });
      }
      bridge.cancel();
      const names = [...pending];
      if (!names.length) return 0;
      const n = (await ask('', 'cancel a passkey request in a browser page')).reduce((sum, x) => sum + (Number(x) || 0), 0);
      // the documents that went without saying so
      await prune(names);
      return n;
    },
  };
}

module.exports = { watchPasskeys, passkeyWatch, PASSKEY_SIGNAL };
