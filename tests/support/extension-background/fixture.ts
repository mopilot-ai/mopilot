// Shared extension services, fake Chrome/WebSocket/timer/page fixtures, and scratch build helpers for unit cases.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fakeChromeApi } from '../chrome-extension-kit.ts';
import { until } from '../chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const protocol = await import('../../../electron/chrome-extension/src/protocol.mjs');
const { Sessions, RELEASES, GROUP_COLOR }: any = await import('../../../electron/chrome-extension/src/sessions.mjs');
const { Client, KEEPALIVE_MS, RETRY_MS, claimPairing }: any = await import('../../../electron/chrome-extension/src/client.mjs');
const { startBackground, readPairing, RECONNECT_ALARM }: any = await import('../../../electron/chrome-extension/src/background.mjs');
const { startOptions, VIEWS, viewOf, FOLLOW_MS }: any = await import('../../../electron/chrome-extension/src/options.mjs');
const build: any = await import('../../../scripts/build-chrome-extension.mjs');
const main = require('../../../electron/capabilities/browser/chromeExtension.cjs');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const SECRET = crypto.randomBytes(32).toString('base64url');

/* ---------- sessions ---------- */

function sessions(o: any = {}) {
  const chrome = fakeChromeApi();
  const sent: any[] = [];
  const logged: string[] = [];
  const s = new Sessions({
    chrome,
    send: (m: any) => sent.push(m),
    storage: o.storage === undefined ? chrome.storage.session : o.storage,
    log: (what: string) => logged.push(what),
    sourcedPopups: o.sourcedPopups,
  });
  return { chrome, sent, logged, s };
}
const cmd = (s: any, chat: string, id: number, method: string, params: any[], turn?: number) =>
  s.handle({ chat, id, method, params, turn });
const reply = (sent: any[], id: number) => sent.find((m) => m.id === id);

/* ---------- client ---------- */

class FakeWs {
  static all: FakeWs[] = [];
  url: string;
  readyState = 1;
  sent: any[] = [];
  closed = 0;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
  }
  send(t: string) {
    this.sent.push(JSON.parse(t));
  }
  close() {
    this.closed++;
  }
  /** a message from MoPilot */
  async from(m: any) {
    await this.onmessage({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  }
}

function fakeTimers() {
  const timeouts: { f: Function; ms: number; id: number }[] = [];
  const intervals: { f: Function; ms: number; id: number }[] = [];
  let id = 0;
  return {
    timeouts,
    intervals,
    setTimeout: (f: Function, ms: number) => {
      timeouts.push({ f, ms, id: ++id });
      return id;
    },
    clearTimeout: (t: number) => {
      const i = timeouts.findIndex((x) => x.id === t);
      if (i >= 0) timeouts.splice(i, 1);
    },
    setInterval: (f: Function, ms: number) => {
      intervals.push({ f, ms, id: ++id });
      return id;
    },
    clearInterval: (t: number) => {
      const i = intervals.findIndex((x) => x.id === t);
      if (i >= 0) intervals.splice(i, 1);
    },
  };
}

function client(o: any = {}) {
  FakeWs.all = [];
  const timers = fakeTimers();
  const handled: any[] = [];
  const statuses: string[] = [];
  const sess: any = { handle: mock.fn(async (m: any) => handled.push(m)), peerGone: mock.fn() };
  let pairing: any = o.pairing === undefined ? { port: 47615, secret: SECRET } : o.pairing;
  const c = new Client({
    WebSocket: o.WebSocket ?? FakeWs,
    crypto: webcrypto,
    pairing: async () => pairing,
    sessions: sess,
    version: '0.3.0',
    timers,
    onStatus: (s: string) => statuses.push(s),
    log: o.log,
  });
  return { c, timers, handled, statuses, sess, setPairing: (p: any) => (pairing = p) };
}

/** Plays MoPilot's side of the handshake on a FakeWs. */
async function handshake(ws: FakeWs, { secret = SECRET, badWelcome = false, panelTabs = true } = {}) {
  const appNonce = 'a'.repeat(32);
  await ws.from({ type: 'hello', protocol: 1, nonce: appNonce, ...(panelTabs ? { capabilities: [protocol.PANEL_TAB_CAPABILITY] } : {}) });
  const auth = ws.sent.at(-1);
  assert.equal(auth.type, 'auth');
  assert.equal(auth.version, '0.3.0');
  assert.equal(auth.proof, main.proofOf(secret, 'extension', appNonce, auth.nonce));
  await ws.from({ type: 'welcome', proof: badWelcome ? 'f'.repeat(64) : main.proofOf(secret, 'app', auth.nonce, appNonce) });
}

/* ---------- the service worker ---------- */

async function background(
  o: { pairing?: string; host?: (m: any) => Promise<any>; now?: () => number; held?: boolean; before?: (chrome: any) => void } = {},
) {
  FakeWs.all = [];
  const chrome: any = fakeChromeApi();
  if (o.pairing) chrome.store.local.pairing = o.pairing;
  // Disconnect pressed before this start
  if (o.held) chrome.store.local.held = true;
  o.before?.(chrome);
  // MoPilot's native host (#1632): absent unless a test gives one
  if (o.host)
    chrome.runtime.sendNativeMessage = async (name: string, m: any) => (
      chrome.log.push(['runtime.sendNativeMessage', name, m]), o.host!(m)
    );
  const timers = fakeTimers();
  const g = { chrome, WebSocket: FakeWs, crypto: webcrypto, ...timers, now: o.now };
  const warn = mock.method(console, 'warn', () => undefined);
  const bg = startBackground(g);
  await bg.ready;
  return { chrome, bg, timers, warn };
}
const own = (chrome: any) => ({ id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/options.html` });
const ask = (chrome: any, message: any, sender: any = own(chrome)) =>
  new Promise((resolve) => {
    const r = chrome.runtime.onMessage.fire(message, sender, resolve)[0];
    if (r === false) resolve('ignored');
  });

/* ---------- the options page ---------- */

function page(hash = '') {
  const chrome = fakeChromeApi();
  // a settled status: a settling one ("connecting", "offline") makes the page ask again on a timer (CM-Z20)
  chrome.reply = () => ({ status: 'unpaired', port: null });
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => {
      els[id] ??= {
        value: '',
        textContent: '',
        listeners: {} as Record<string, Function>,
        attrs: {} as Record<string, string>,
        children: [] as any[],
        addEventListener(type: string, f: Function) {
          this.listeners[type] = f;
        },
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
        replaceChildren(...c: any[]) {
          this.children = c;
        },
        focus() {},
      };
      return els[id];
    },
  };
  const history = { replaceState: mock.fn() };
  const location = { hash, pathname: '/options.html' };
  // the page's follow-ups are recorded, never run: a test that wants one runs it (CM-Z20). Like Chrome's, the window's
  // timers refuse to be called on anything but the window ("Illegal invocation")
  const timers = fakeTimers();
  const g: any = {
    chrome,
    document,
    location,
    history,
    setTimeout(f: Function, ms: number) {
      if (this !== g) throw new TypeError('Illegal invocation');
      return timers.setTimeout(f, ms);
    },
    clearTimeout(t: number) {
      if (this !== g) throw new TypeError('Illegal invocation');
      return timers.clearTimeout(t);
    },
  };
  return { chrome, els, history, timers, g };
}

/* ---------- the build step ---------- */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-ext-'));

export {
  test,
  assert,
  crypto,
  fs,
  path,
  spawnSync,
  build,
  main,
  tmp,
  mock,
  protocol,
  KEEPALIVE_MS,
  RETRY_MS,
  claimPairing,
  tick,
  SECRET,
  FakeWs,
  fakeTimers,
  client,
  handshake,
  startOptions,
  VIEWS,
  viewOf,
  FOLLOW_MS,
  page,
  webcrypto,
  RELEASES,
  GROUP_COLOR,
  sessions,
  cmd,
  reply,
  fakeChromeApi,
  until,
  readPairing,
  RECONNECT_ALARM,
  background,
  ask,
};
