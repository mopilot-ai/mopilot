// Fakes for MoPilot's Chrome extension tests (B2 step 2): a fake chrome.* namespace with scripted tabs, groups and debugger, a WebSocket class that reaches main's channel on loopback with the extension's origin, and an in-memory pairing store.
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { clientFrame, rawConnect, serverFrames } from './chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const { EXTENSION_ORIGIN, EXTENSION_ID } = require('../../electron/capabilities/browser/chromeExtension.cjs');

export { EXTENSION_ORIGIN, EXTENSION_ID };

/** An empty Chrome folder for the rest of test `t`: whether this machine's own profile has the extension decides nothing. */
export function emptyChromeFolder(t: { after: (f: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-ext-'));
  const was = process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR;
  process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR = dir;
  t.after(() => {
    if (was === undefined) delete process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR;
    else process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** A chrome.* event: listeners and a way to fire it. */
export function fakeEvent() {
  const listeners: Function[] = [];
  return {
    listeners,
    addListener: (f: Function) => listeners.push(f),
    fire: (...a: any[]) => listeners.map((f) => f(...a)),
  };
}

/** A fake chrome.* namespace: tabs, tab groups, the debugger, storage, alarms, runtime and action, recording each call. */
export function fakeChromeApi({ id = EXTENSION_ID } = {}) {
  const log: any[] = [];
  const tabs = new Map<number, any>();
  const groups = new Map<number, any>();
  const attached = new Set<number>();
  const store = { local: {} as Record<string, any>, session: {} as Record<string, any> };
  let nextTab = 500;
  let nextGroup = 1;
  let nextWindow = 2;
  // Chrome's open normal windows: none is the windowless state (#3714), where tabs.create without a windowId throws
  const windows = new Set<number>([1]);
  const fail: Record<string, Error | undefined> = {};
  const cdp: Record<string, any> = {};
  const call = (name: string, ...a: any[]) => {
    log.push([name, ...a]);
    if (fail[name]) throw fail[name];
  };
  const area = (k: 'local' | 'session') => ({
    // one key, or several (as Chrome's takes them)
    get: async (key: string | string[]) => {
      call(`storage.${k}.get`, key);
      return Object.fromEntries((Array.isArray(key) ? key : [key]).filter((x) => x in store[k]).map((x) => [x, store[k][x]]));
    },
    set: async (v: Record<string, any>) => {
      call(`storage.${k}.set`, v);
      Object.assign(store[k], structuredClone(v));
    },
    remove: async (key: string | string[]) => {
      call(`storage.${k}.remove`, key);
      for (const name of Array.isArray(key) ? key : [key]) delete store[k][name];
    },
  });
  const chrome = {
    log,
    fail,
    cdp,
    tabsById: tabs,
    groups,
    attached,
    store,
    windowIds: windows,
    addTab(t: any = {}) {
      const tab = { id: nextTab++, windowId: 1, groupId: -1, url: 'https://user.example/', ...t };
      tabs.set(tab.id, tab);
      return tab;
    },
    tabs: {
      onCreated: fakeEvent(),
      onRemoved: fakeEvent(),
      onUpdated: fakeEvent(),
      onActivated: fakeEvent(),
      onReplaced: fakeEvent(),
      async create(o: any) {
        call('tabs.create', o);
        if (o.windowId == null && !windows.size) throw new Error('No current window');
        if (o.windowId != null && !windows.has(o.windowId)) throw new Error(`No window with id: ${o.windowId}.`);
        return chrome.addTab({ url: o.url, windowId: o.windowId ?? [...windows].at(-1) });
      },
      async get(tabId: number) {
        call('tabs.get', tabId);
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}.`);
        return t;
      },
      async query(o: any) {
        call('tabs.query', o);
        return [...tabs.values()].filter((t) => !o.active || t.active);
      },
      async remove(tabId: number) {
        call('tabs.remove', tabId);
        const windowId = tabs.get(tabId)?.windowId;
        tabs.delete(tabId);
        // a window this fake made closes with its last tab, as Chrome's do (window 1, the user's, is never emptied by a test)
        if (windowId !== 1 && ![...tabs.values()].some((t) => t.windowId === windowId)) windows.delete(windowId);
      },
      async reload(tabId: number) {
        call('tabs.reload', tabId);
      },
      async update(tabId: number, o: any) {
        call('tabs.update', tabId, o);
        Object.assign(tabs.get(tabId) ?? {}, o);
      },
      async group(o: any) {
        call('tabs.group', o);
        const gid = o.groupId ?? nextGroup++;
        if (!groups.has(gid)) groups.set(gid, { id: gid, windowId: tabs.get(o.tabIds[0])?.windowId ?? 1 });
        for (const t of o.tabIds) if (tabs.has(t)) tabs.get(t).groupId = gid;
        return gid;
      },
      async ungroup(tabIds: number[]) {
        call('tabs.ungroup', tabIds);
        for (const t of tabIds) if (tabs.has(t)) tabs.get(t).groupId = -1;
      },
    },
    webNavigation: { onCreatedNavigationTarget: fakeEvent(), onCommitted: fakeEvent(), onBeforeNavigate: fakeEvent() },
    contextMenus: {
      onClicked: fakeEvent(),
      removeAll: async () => call('contextMenus.removeAll'),
      create: (o: any, done?: () => void) => {
        call('contextMenus.create', o);
        done?.();
      },
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      async create(o: any) {
        call('windows.create', o);
        const id = nextWindow++;
        windows.add(id);
        return {
          id,
          focused: o.focused !== false,
          type: 'normal',
          tabs: [chrome.addTab({ url: o.url ?? 'chrome://newtab/', windowId: id, active: true })],
        };
      },
    },
    commands: { getAll: async () => [{ name: '_execute_action', shortcut: '⌘E' }] },
    tabGroups: {
      async get(groupId: number) {
        call('tabGroups.get', groupId);
        const g = groups.get(groupId);
        if (!g) throw new Error(`No group with id: ${groupId}.`);
        return g;
      },
      async update(groupId: number, o: any) {
        call('tabGroups.update', groupId, o);
        Object.assign(groups.get(groupId), o);
      },
    },
    debugger: {
      onEvent: fakeEvent(),
      onDetach: fakeEvent(),
      async attach(target: any, version: string) {
        call('debugger.attach', target, version);
        attached.add(target.tabId);
      },
      async detach(target: any) {
        call('debugger.detach', target);
        attached.delete(target.tabId);
      },
      async sendCommand(target: any, method: string, params: any) {
        call('debugger.sendCommand', target, method, params);
        const r = cdp[method];
        if (typeof r === 'function') return r(params, target);
        if (r instanceof Error) throw r;
        return r ?? {};
      },
    },
    storage: {
      local: area('local'),
      session: area('session'),
      // an unmanaged browser: no administrator policy
      managed: { get: async () => ({}) } as any,
      onChanged: fakeEvent(),
    },
    downloads: {
      items: new Map<number, any>(),
      onCreated: fakeEvent(),
      onChanged: fakeEvent(),
      async search(q: any) {
        call('downloads.search', q);
        const d = chrome.downloads.items.get(q.id);
        return d ? [d] : [];
      },
    },
    alarms: {
      onAlarm: fakeEvent(),
      create: (name: string, o: any) => call('alarms.create', name, o),
    },
    runtime: {
      id,
      onMessage: fakeEvent(),
      onStartup: fakeEvent(),
      onInstalled: fakeEvent(),
      onUpdateAvailable: fakeEvent(),
      lastError: undefined as any,
      /** what requestUpdateCheck answers */
      updateCheck: { status: 'no_update' } as any,
      requestUpdateCheck: async () => {
        call('runtime.requestUpdateCheck');
        if (chrome.runtime.updateCheck instanceof Error) throw chrome.runtime.updateCheck;
        return chrome.runtime.updateCheck;
      },
      reload: () => call('runtime.reload'),
      getManifest: () => ({ version: '0.3.0' }),
      openOptionsPage: async () => call('runtime.openOptionsPage'),
      getURL: (p: string) => `chrome-extension://${id}/${p}`,
      sendMessage: async (m: any) => {
        call('runtime.sendMessage', m);
        return chrome.reply(m);
      },
    },
    sidePanel: {
      setPanelBehavior: async (o: any) => call('sidePanel.setPanelBehavior', o),
      setOptions: async (o: any) => call('sidePanel.setOptions', o),
      open: async (o: any) => call('sidePanel.open', o),
    },
    action: {
      onClicked: fakeEvent(),
      setBadgeText: async (o: any) => call('action.setBadgeText', o),
      setBadgeBackgroundColor: async (o: any) => call('action.setBadgeBackgroundColor', o),
      /** what action.getUserSettings answers (the page's pin tip) */
      userSettings: { isOnToolbar: true } as any,
      getUserSettings: async () => chrome.action.userSettings,
    },
    /** what runtime.sendMessage answers (the options page's tests set it) */
    reply: (_m: any): any => ({ status: 'offline' }),
  };
  return chrome;
}

/**
 * A WebSocket class (the browser API's shape) that reaches a loopback server with the extension's origin, as Chrome
 * opens the extension's socket. Each instance is pushed to `opened`.
 */
export function loopbackWebSocket(origin = EXTENSION_ORIGIN) {
  const opened: any[] = [];
  class LoopbackWebSocket {
    url: string;
    readyState = 0;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sock: import('node:net').Socket | null = null;
    buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    sent: string[] = [];
    opening = new AbortController();
    constructor(url: string) {
      this.url = url;
      opened.push(this);
      rawConnect(url, { origin, signal: this.opening.signal }).then(
        (sock) => {
          if (this.readyState === 2) {
            sock.destroy();
            this.#gone();
            return;
          }
          this.sock = sock;
          this.readyState = 1;
          sock.on('data', (chunk: Buffer) => {
            const { frames, rest } = serverFrames(Buffer.concat([this.buf, chunk]));
            this.buf = rest;
            for (const f of frames) {
              if (f.opcode === 0x1) this.onmessage?.({ data: f.payload.toString() });
              if (f.opcode === 0x8) sock.end();
            }
          });
          sock.on('close', () => this.#gone());
          sock.on('error', () => undefined);
        },
        () => {
          this.onerror?.();
          this.#gone();
        },
      );
    }
    #gone() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.();
    }
    send(text: string) {
      this.sent.push(text);
      this.sock?.write(clientFrame(0x1, Buffer.from(text)));
    }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      if (!this.sock) this.opening.abort();
      this.sock?.write(clientFrame(0x8, Buffer.from([0x03, 0xe8])));
      this.sock?.end();
    }
  }
  return { LoopbackWebSocket, opened };
}

/** An in-memory pairing store (ChromePairing's shape). */
export function memoryPairing(initial: { secret: string; port: number; paired: boolean; name?: string } | null = null): any {
  let p = initial ? { ...initial } : null;
  return {
    get: () => (p ? { ...p } : null),
    forPort(port: number) {
      if (p && p.port === port) return { ...p };
      p = { secret: 'A'.repeat(43), port, paired: false };
      return { ...p };
    },
    markPaired() {
      if (p) p.paired = true;
    },
    rename(name: unknown) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('Use a name of 1 to 80 characters.');
      if (!p) throw new Error('Connect this Chrome first.');
      p.name = name.trim();
      return name.trim();
    },
    set(v: typeof p) {
      p = v ? { ...v } : null;
    },
  };
}

/**
 * Main's channel and the real extension background (sessions and client) on a fake Chrome, connected over loopback:
 * what MoPilot and its extension do with each other, with nothing of Chrome's but the chrome.* fake.
 */
export async function extensionWorld(
  o: {
    connectMs?: number;
    commandMs?: number;
    openMs?: number;
    graceMs?: number;
    paired?: boolean;
    /** main's side panel requests (chromePanel.cjs) and the extension's end of them (panelLink.mjs) */
    panel?: (m: any, reply: (message: object) => void) => unknown;
    onPanel?: (m: any) => void;
  } = {},
): Promise<any> {
  const { ChromeExtensionChannel } = require('../../electron/capabilities/browser/chromeExtension.cjs');
  const { Sessions } = await import('../../electron/chrome-extension/src/sessions.mjs');
  const { Client, claimPairing } = await import('../../electron/chrome-extension/src/client.mjs');
  const { parsePairingCode, parseClaimCode, pairingCode } = await import('../../electron/chrome-extension/src/protocol.mjs');
  const pairing = memoryPairing();
  const opened: string[] = [];
  const channel = new ChromeExtensionChannel({
    pairing,
    openPage: async (url: string) => opened.push(url),
    connectMs: o.connectMs ?? 2000,
    commandMs: o.commandMs ?? 1000,
    openMs: o.openMs ?? 1000,
    graceMs: o.graceMs,
    port: 0,
    clientName: (chatId: string) => `MoPilot ${chatId}`,
    panel: o.panel,
  });
  const port = await channel.start();
  /** the pairing code the extension holds (chrome.storage.local's): it has one from the start unless `paired` is false */
  let code: string | null = o.paired === false ? null : pairingCode(port, pairing.get().secret);
  const chrome = fakeChromeApi();
  const { LoopbackWebSocket, opened: sockets } = loopbackWebSocket();
  let client: any;
  const logged: string[] = [];
  const sessions = new Sessions({
    chrome,
    send: (m: any) => client.send(m),
    storage: chrome.storage.session,
    log: (what: string) => logged.push(what),
  });
  client = new Client({
    WebSocket: LoopbackWebSocket,
    crypto: webcrypto,
    pairing: async () => parsePairingCode(code),
    sessions,
    version: '0.3.0',
    panel: (m: any) => o.onPanel?.(m),
  });
  /** the extension connects (as when Chrome is open with it paired) and MoPilot accepts it */
  const connectExtension = async () => {
    await client.connect();
    const end = Date.now() + 2000;
    while (!channel.peer?.open) {
      if (Date.now() > end) throw new Error('the extension did not connect');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** the user presses Pair on the page MoPilot opened: the extension trades the page's claim code for the pairing */
  const pressPair = async (url = opened.at(-1) as string) => {
    const claim = parseClaimCode(decodeURIComponent(url.split('#pair=')[1]));
    const got = claim ? await claimPairing(LoopbackWebSocket, claim) : null;
    if (got) code = got;
    return got;
  };
  if (o.paired !== false) await connectExtension();
  const stop = () => {
    client.dispose();
    channel.stop();
    for (const s of sockets) s.onclose = null;
  };
  return {
    channel,
    port,
    pairing,
    opened,
    chrome,
    sessions,
    client,
    sockets,
    connectExtension,
    pressPair,
    setCode: (c: string | null) => (code = c),
    stop,
    logged,
  };
}
