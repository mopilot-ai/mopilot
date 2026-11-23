// Raw Chrome DevTools Protocol helpers (no Playwright: in-app browser targets can stall its connectOverCDP): the
// MoPilot app window, in-app browser tabs, and reading a REAL site's /finish state from whichever target is on it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every CDP target of the app on this port. @param {string} port */
export const targets = async (port) => /** @type {any[]} */ (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()));

/** A CDP session on one target: send(method, params) and evaluate(expression). @param {string} wsUrl */
export async function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  /** @type {Map<number, { res: (d: any) => void, rej: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();
  const settle = (/** @type {number} */ i) => {
    const p = pending.get(i);
    pending.delete(i);
    if (p) clearTimeout(p.timer);
    return p;
  };
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (!d.id) return;
    const p = settle(d.id);
    if (!p) return;
    // a protocol error (a closed target, a bad method) rejects rather than reading as an empty result
    if (d.error) p.rej(new Error(`CDP ${d.error.message ?? JSON.stringify(d.error)}`));
    else p.res(d);
  };
  // a target that closes or crashes mid-call fails every pending call instead of leaving it unsettled
  ws.onclose = () => {
    for (const i of [...pending.keys()]) settle(i)?.rej(new Error('CDP target closed'));
  };
  /** @param {string} method @param {Record<string, unknown>} [params] @returns {Promise<any>} */
  const send = (method, params = {}, timeoutMs = 60000) =>
    new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => settle(i)?.rej(new Error(`CDP ${method} timed out`)), timeoutMs);
      pending.set(i, { res, rej, timer });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  /** @param {string} expression */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

/** The MoPilot app window (not the mini window). @param {string} port */
export async function appWindow(port) {
  const t = (await targets(port)).find((x) => x.type === 'page' && x.url.startsWith('file:') && !x.url.includes('#mini'));
  if (!t) throw new Error(`no MoPilot app window on CDP port ${port}`);
  return session(t.webSocketDebuggerUrl);
}

/** In-app browser tabs: web pages that are not the app or DevTools. @param {string} port */
export const browserTabs = async (port) =>
  (await targets(port)).filter((t) => t.type === 'page' && /^(https?:|about:|chrome:)/.test(t.url) && !t.url.startsWith('devtools'));

/**
 * An in-app browser tab, opening one the way a person does (the New tab button, then the address bar) when none
 * exists.
 * @param {string} port @param {string} url
 */
export async function ensureTab(port, url) {
  let ts = await browserTabs(port);
  if (ts.length) return ts[0];
  const app = await appWindow(port);
  await app.evaluate(`document.querySelector('[aria-label="New tab"]').click()`);
  await sleep(1500);
  await app.evaluate(`document.querySelector('[aria-label="Browser address"]').focus()`);
  await app.send('Input.insertText', { text: url });
  for (const type of ['keyDown', 'keyUp']) {
    await app.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: type === 'keyDown' ? '\r' : undefined,
    });
  }
  app.close();
  for (let i = 0; i < 20 && !ts.length; i++) {
    await sleep(500);
    ts = await browserTabs(port);
  }
  if (!ts.length) throw new Error('no in-app browser tab');
  return ts[0];
}

/** Navigates a target and waits. @param {any} target @param {string} url */
export async function navigate(target, url, waitMs = 3000) {
  const s = await session(target.webSocketDebuggerUrl);
  await s.send('Page.navigate', { url });
  await sleep(waitMs);
  s.close();
}

/**
 * Loads <site>/finish in a target and returns the state JSON text the page prints (empty when there is none).
 * @param {any} target @param {string} site
 */
export async function readFinish(target, site) {
  const s = await session(target.webSocketDebuggerUrl);
  await s.send('Page.navigate', { url: `${site}/finish` });
  await sleep(6000);
  const r = await s.send('Runtime.evaluate', { expression: "document.querySelector('pre')?.innerText ?? ''", returnByValue: true });
  s.close();
  return String(r.result?.result?.value ?? '');
}

/** The targets (pages or webviews) of an app that are on a site's host. @param {string} port @param {string} site */
export async function siteTargets(port, site) {
  const host = new URL(site).host;
  return (await targets(port)).filter((t) => (t.type === 'page' || t.type === 'webview') && t.url.includes(host));
}
