// A fake Playwright Extension and Chrome for the Chrome relay's tests: a real loopback WebSocket client that speaks the extension's relay protocol (version 2) over a scripted set of tabs.
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EXTENSION_ORIGIN } = require('../../electron/capabilities/browser/chromeRelay.cjs');

/** A client frame: masked, FIN set unless `fin` is false. */
export function clientFrame(opcode: number, payload: Buffer, { fin = true, mask = true } = {}) {
  const len = payload.length;
  const key = crypto.randomBytes(4);
  let head: Buffer;
  const m = mask ? 0x80 : 0;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, m | len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = m | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = m | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([head, payload]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}

/** Reads the server's unmasked frames. */
export function serverFrames(buf: Buffer) {
  const out: { opcode: number; payload: Buffer }[] = [];
  let rest = buf;
  for (;;) {
    if (rest.length < 2) break;
    let len = rest[1] & 0x7f;
    let at = 2;
    if (len === 126) {
      if (rest.length < 4) break;
      len = rest.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (rest.length < 10) break;
      len = Number(rest.readBigUInt64BE(2));
      at = 10;
    }
    if (rest.length < at + len) break;
    out.push({ opcode: rest[0] & 0x0f, payload: rest.subarray(at, at + len) });
    rest = rest.subarray(at + len);
  }
  return { frames: out, rest };
}

/** Opens a WebSocket to `url` with `origin`; resolves with the raw socket, or rejects with the HTTP status. */
export function rawConnect(
  url: string,
  {
    origin = EXTENSION_ORIGIN,
    version = '13',
    key = crypto.randomBytes(16).toString('base64'),
    signal,
  }: { origin?: string; version?: string; key?: string; signal?: AbortSignal } = {},
) {
  const u = new URL(url);
  return new Promise<import('node:net').Socket>((resolve, reject) => {
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname,
      signal,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': version, Origin: origin },
    });
    // bytes the server sent right after its answer arrive with it: they are read first
    req.on('upgrade', (_res, socket, head) => {
      if (head?.length) socket.unshift(head);
      resolve(socket);
    });
    req.on('response', (res) => {
      res.destroy();
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

type Handler = (method: string, params: any[]) => any;

/** The extension's side of one connection: answers commands with `handle`, sends events, records what it got. */
export class FakeExtension extends EventEmitter {
  socket: import('node:net').Socket;
  got: any[] = [];
  closes: { code: number; reason: string }[] = [];
  handle: Handler;
  buf: Buffer = Buffer.alloc(0);
  constructor(socket: import('node:net').Socket, handle: Handler) {
    super();
    this.socket = socket;
    this.handle = handle;
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = serverFrames(Buffer.concat([this.buf, chunk]));
      this.buf = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) {
          this.closes.push({ code: f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 0, reason: f.payload.subarray(2).toString() });
          this.emit('closed');
          continue;
        }
        if (f.opcode === 0xa) {
          this.emit('pong', f.payload.toString());
          continue;
        }
        const m = JSON.parse(f.payload.toString());
        this.got.push(m);
        this.emit('command', m);
        void this.#answer(m);
      }
    });
    socket.on('error', () => undefined);
  }

  async #answer(m: any) {
    let reply: any;
    try {
      const r = await this.handle(m.method, m.params);
      if (r === NO_ANSWER) return;
      reply = { id: m.id, result: r };
    } catch (e: any) {
      reply = { id: m.id, error: e.message };
    }
    this.send(reply);
  }

  send(message: any) {
    this.socket.write(clientFrame(0x1, Buffer.from(JSON.stringify(message))));
  }

  raw(buf: Buffer) {
    this.socket.write(buf);
  }

  event(method: string, ...params: any[]) {
    this.send({ method, params });
  }

  close() {
    this.socket.destroy();
  }
}

/** A command the fake leaves unanswered (to test timeouts). */
export const NO_ANSWER = Symbol('no answer');

/** A fake Chrome behind the extension: its tabs, CDP replies per method, and the commands it got. */
export function fakeChrome() {
  const chrome = {
    nextTab: 100,
    tabs: new Map<number, any>(),
    attached: new Set<number>(),
    cdp: {} as Record<string, any>,
    log: [] as any[],
    handle(method: string, params: any[]) {
      chrome.log.push([method, params]);
      switch (method) {
        case 'chrome.tabs.create': {
          const tab = { id: chrome.nextTab++, url: params[0]?.url ?? 'about:blank', title: '' };
          chrome.tabs.set(tab.id, tab);
          return tab;
        }
        case 'chrome.tabs.remove':
          chrome.tabs.delete(params[0]);
          return {};
        case 'chrome.debugger.attach':
          chrome.attached.add(params[0].tabId);
          return {};
        case 'chrome.debugger.detach':
          chrome.attached.delete(params[0].tabId);
          return {};
        case 'chrome.debugger.sendCommand': {
          const [, m, p] = params;
          const r = chrome.cdp[m];
          if (r === NO_ANSWER) return NO_ANSWER;
          if (typeof r === 'function') return r(p, params[0]);
          if (r instanceof Error) throw r;
          return r ?? {};
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    },
  };
  return chrome;
}

/**
 * An `openPage` for ChromeRelay that plays the extension: it reads the relay URL from the connect page,
 * connects with the extension's origin, reports the connect page's tab and says it is initialized.
 * Each connection is pushed to `connections`.
 */
export function playExtension(chrome = fakeChrome(), { initialize = true, connectTab = true } = {}) {
  const connections: FakeExtension[] = [];
  const urls: string[] = [];
  const openPage = async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const relayUrl = u.searchParams.get('mcpRelayUrl') as string;
    const socket = await rawConnect(relayUrl);
    const ext = new FakeExtension(socket, (m, p) => chrome.handle(m, p));
    connections.push(ext);
    if (connectTab) {
      const tab = { id: chrome.nextTab++, url, title: 'Playwright Extension' };
      chrome.tabs.set(tab.id, tab);
      ext.event('chrome.tabs.onCreated', tab);
    }
    if (initialize) ext.event('extension.initialized');
  };
  return { chrome, connections, urls, openPage };
}

/** A fake Chrome page: navigations answer with a loader and then the load events; the page agent reads as quiet. */
export function pageChrome(x: ReturnType<typeof playExtension>) {
  const pages = new Map<number, { url: string; title: string }>();
  const page = (tabId: number) => {
    if (!pages.has(tabId)) pages.set(tabId, { url: 'about:blank', title: '' });
    return pages.get(tabId) as { url: string; title: string };
  };
  const c = x.chrome.cdp;
  c['Target.getTargetInfo'] = (_p: any, t: any) => ({
    targetInfo: { targetId: `T${t.tabId}`, url: page(t.tabId).url, title: page(t.tabId).title },
  });
  c['Page.getNavigationHistory'] = (_p: any, t: any) => ({ currentIndex: 0, entries: [{ id: 1, url: page(t.tabId).url }] });
  c['Page.getFrameTree'] = (_p: any, t: any) => ({ frameTree: { frame: { id: `T${t.tabId}` } } });
  c['Page.createIsolatedWorld'] = { executionContextId: 3 };
  c['Runtime.evaluate'] = (p: any) =>
    String(p.expression).includes('navigator.userAgent')
      ? { result: { value: 'Chrome/140' } }
      : { result: { value: { value: { quietMs: 1000, visibility: 'visible' }, seq: 0 } } };
  c['Page.navigate'] = (p: any, t: any) => {
    const ext = x.connections.at(-1) as any;
    setTimeout(() => {
      const frame = `T${t.tabId}`;
      ext.event('chrome.debugger.onEvent', { tabId: t.tabId }, 'Page.frameStartedLoading', { frameId: frame });
      page(t.tabId).url = p.url;
      page(t.tabId).title = 'Example Domain';
      ext.event('chrome.debugger.onEvent', { tabId: t.tabId }, 'Page.frameNavigated', { frame: { id: frame, url: p.url } });
      ext.event('chrome.debugger.onEvent', { tabId: t.tabId }, 'Page.frameStoppedLoading', { frameId: frame });
    }, 5);
    return { frameId: `T${t.tabId}`, loaderId: 'L1' };
  };
  return pages;
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Waits until `f()` is truthy (at most `ms`). */
export async function until(f: () => unknown, ms = 2000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(5);
  }
}

/** In-memory tab relay, with inventory authority, for ChromeTabContents-only contract tests. */
export function fakeRelay() {
  const tabs = new Set([5]);
  const r: any = {
    turn: 0,
    calls: [] as any[],
    replies: {} as Record<string, any>,
    linked: true,
    token: (chatId: string) => ({ chatId, turn: r.turn }),
    link: () => (r.linked ? { tabs } : null),
    owns: (_chat: string, id: number) => r.linked && tabs.has(id),
    attach: async (tok: any, tabId: number) => r.calls.push(['attach', tok.turn, tabId]),
    detach: async (tok: any, tabId: number) => {
      r.calls.push(['detach', tok.turn, tabId]);
      if (r.detachFails) throw new Error('gone');
    },
    cdp: async (tok: any, target: any, method: string, params: any = {}) => {
      r.calls.push(['cdp', tok.turn, target, method, params]);
      const v = r.replies[method];
      if (v instanceof Error) throw v;
      return typeof v === 'function' ? v(params) : (v ?? {});
    },
    tabs,
  };
  return r;
}
