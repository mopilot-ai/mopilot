// electron/capabilities/browser/iabBackend.cjs: the Browser plugin's in-app browser backend per native Codex
// thread (framing, the peer check, the protocol over the browser host's tabs, the CDP filter and site rules).
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
export { tick } from '../async-scenarios.ts';

export const require = createRequire(import.meta.url);
export const {
  IabBackends,
  mainIabBackends,
  IabBackend,
  Peer,
  FrameDecoder,
  encodeFrame,
  cdpPolicy,
  urlAllowed,
  pluginBrowserEnv,
  verifyDescendant,
  SOCKET_DIR,
} = require('../../../electron/capabilities/browser/iabBackend.cjs');
export const { FRAME_SCRIPT } = require('../../../electron/capabilities/browser/hostUtil.cjs');
export const { BrowserTabs } = require('../../../electron/capabilities/browser/host.cjs');
export const { runBeforePage } = require('../../../electron/capabilities/browser/documentScripts.cjs');

export const S = 'thread-1';

/* ------------------------------------------------------------------ fakes */

export function fakeTab(id: string, o: any = {}) {
  const dbg: any = new EventEmitter();
  dbg.attached = true;
  dbg.isAttached = () => dbg.attached;
  dbg.sent = [];
  dbg.sendCommand = (m: string, p: any, sid?: string) => {
    dbg.sent.push(sid ? [m, p, sid] : [m, p]);
    return dbg.fail ? Promise.reject(new Error('gone')) : Promise.resolve({});
  };
  let destroyed = false;
  const tab: any = {
    id,
    url: 'https://example.com/',
    title: 'Example',
    closed: false,
    signin: null,
    takenOver: false,
    frames: new Map(),
    // BrowserTabs.run's per-tab queue
    queue: Promise.resolve(),
    layer: 'back',
    wc: Object.assign(new EventEmitter(), {
      debugger: dbg,
      isDestroyed: () => destroyed,
      destroy: () => (destroyed = true),
      stop() {},
      setVisualZoomLevelLimits() {},
    }),
    get backend() {
      return this.wc;
    },
    attached: 0,
    held: 0,
    // the renderer crashed or was killed (Tab.rendererGone)
    gone: false,
    rendererGone: () => tab.gone,
    sends: [] as any[],
    agents: [] as any[],
    reply: {} as Record<string, any>,
    async attach() {
      tab.attached++;
    },
    hold() {
      tab.held++;
    },
    async send(m: string, p: any = {}, sid = '') {
      tab.sends.push([m, p, sid]);
      const r = tab.reply[m];
      if (typeof r === 'function') return r(p, sid);
      return r ?? { ok: m };
    },
    async agent(op: string, args: any, sid: string) {
      tab.agents.push([op, args, sid]);
      if (tab.agentFail) throw new Error('no world');
      return tab.unreadable ? { count: tab.masked ?? 0, unreadable: tab.unreadable } : { count: tab.masked ?? 0 };
    },
    ...o,
  };
  return tab;
}

export function fakeHost() {
  const cursor: any = { acts: [] as any[], conceals: 0, reveals: 0 };
  cursor.act = async (t: any, a: any) => cursor.acts.push([t.id, a]);
  cursor.conceal = async () => cursor.conceals++;
  cursor.reveal = async () => cursor.reveals++;
  cursor.arrivals = [] as any[];
  cursor.arrival = async (t: any) => cursor.arrivals.push(t.id);
  const host: any = {
    o: { cursor },
    tabs: [] as any[],
    cur: null as any,
    calls: [] as any[],
    intentOf: null as any,
    list(chatId: string) {
      host.calls.push(['list', chatId]);
      return host.tabs.filter((t: any) => !t.closed);
    },
    current() {
      return host.cur;
    },
    async create(chatId: string, o: any) {
      host.calls.push(['create', chatId, o]);
      const t = fakeTab(`tab_${host.tabs.length + 1}`);
      host.tabs.push(t);
      host.cur = t;
      return t;
    },
    async close(chatId: string, id: string) {
      host.calls.push(['close', chatId, id]);
      host.tabs.find((t: any) => t.id === id).closed = true;
    },
    select(chatId: string, id: string) {
      host.calls.push(['select', chatId, id]);
    },
    mark(chatId: string, id: string, status: string) {
      host.calls.push(['mark', chatId, id, status]);
    },
    async intent(tab: any, target: any) {
      host.calls.push(['intent', tab.id, target]);
      return host.intentOf;
    },
    // the real per-tab action queue
    run: BrowserTabs.prototype.run,
    // the real check whether a reload would resubmit a form
    reloadResubmits: BrowserTabs.prototype.reloadResubmits,
    // the turn's result tab follows the plugin's actions too
    actedOn: [] as string[],
    acted(t: any) {
      host.actedOn.push(t.id);
    },
  };
  return host;
}

export function fakeGrants(o: any = {}) {
  const g: any = {
    verdict: 'ok',
    risk: { level: 'low', credentials: false },
    calls: [] as any[],
    peek(url: string, need: string, ctx: any) {
      g.calls.push(['peek', url, need, ctx]);
      return typeof g.verdict === 'function' ? g.verdict(url, need) : g.verdict;
    },
    riskOf() {
      return g.risk;
    },
    blockNote(url: string) {
      return `${g.risk.label ? `${g.risk.label}: blocked.` : 'Blocked.'} ${url}`;
    },
    async require(url: string, need: string, ctx: any, opts: any) {
      g.calls.push(['require', url, need, ctx, opts]);
    },
    async act(url: string, ctx: any, what: any) {
      g.calls.push(['act', url, ctx, what]);
    },
    ...o,
  };
  return g;
}

export function backend(o: any = {}) {
  const host = o.host ?? fakeHost();
  const grants = o.grants ?? fakeGrants();
  const b = new IabBackend({
    threadId: S,
    chatOf: (id: string) => `chat:${id}`,
    tabs: () => (o.noHost ? null : host),
    grants: () => grants,
    flavor: 'flavor' in o ? o.flavor : 'prod',
    version: o.version,
    cdpMs: o.cdpMs,
  });
  const notes: any[] = [];
  b.peers.add({ notify: (m: string, p: any) => notes.push([m, p]) });
  const call = (method: string, params: any = {}) => b.handle(method, { session_id: S, ...params });
  return { b, host, grants, notes, call };
}

export async function withTab(o: any = {}) {
  const k = backend(o);
  const created = await k.call('createTab');
  const tab = k.host.tabs[0];
  return { ...k, tab, id: created.id };
}
