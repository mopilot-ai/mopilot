// browser_script on the host side (electron/capabilities/browser/script.cjs): every operation a script
// can call, over a fake BrowserTabs and a virtual clock (gates, auto-waits, strictness, actionability,
// screenshots, dialogs); the worker runner over a fake worker (messages, caps, timeouts, stops) and a
// real one (the sandbox); and the tool's result and failure text through createBrowserTools.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
export { tick } from '../async-scenarios.ts';

const require = createRequire(import.meta.url);
export const {
  SCRIPT_SPEC,
  SCRIPT_REFERENCE,
  SESSION_INIT,
  ScriptSession,
  ScriptSessions,
  createScriptOps,
  WORKER_SOURCE,
  IMAGES_MAX,
  LOG_MAX,
  RESULT_MAX,
  MAX_MS,
} = require('../../../electron/capabilities/browser/script.cjs');
export const { createBrowserTools } = require('../../../electron/capabilities/browser/hostTools.cjs');
export { browserToolSpecs } from '../tool-specs.ts';
export const { BrowserTabs } = require('../../../electron/capabilities/browser/host.cjs');
export const { OriginGrants } = require('../../../electron/capabilities/browser/origins.cjs');
export const { ToolError } = require('../../../electron/capabilities/contract/registry.cjs');

export const code = (c: string, re?: RegExp) => (e: any) => {
  assert.ok(e instanceof ToolError, `expected a ToolError, got ${e?.stack || e}`);
  assert.equal(e.code, c);
  if (re) assert.match(e.message, re);
  return true;
};

/** A fake BrowserTabs for the script operations; `q` answers queries, `st` is the element state. */
export function fakeTabs() {
  const calls: any[][] = [];
  const check = () => {};
  const tab: any = { id: 't1', url: 'https://a.test/', title: 'A', dialog: null, kind: 'tab', check };
  const other: any = { id: 't2', url: 'https://b.test/', title: 'B', dialog: null, kind: 'tab', check };
  const t: any = {
    calls,
    tab,
    other,
    list_: [tab, other],
    st: { visible: true, enabled: true, editable: true, checked: null, tag: 'button', type: '' },
    values: {},
  };
  t.q = () => ({ sessionId: 'S', refs: ['ref_1'], count: 1, desc: ['button "Go"'] });
  t.loc = { x: 50, y: 40, w: 20, h: 10, tag: 'button', name: 'Go', cover: null };
  t.result = undefined;
  t.impl = {
    resolve: async (_c: string, id: any) => {
      if (id === 'missing') throw new ToolError('No tab missing in this chat.', 'bad_args');
      return id === 't2' ? other : tab;
    },
    run: async (_tab: any, fn: () => any) => fn(),
    // the real wait: the tab is checked again after the card, and nothing is done once the call ended
    awaitUser: BrowserTabs.prototype.awaitUser,
    ready: async () => ({ w: 800, h: 600 }),
    create: async () => ({ id: 't3', url: 'about:blank', title: '' }),
    list: () => t.list_,
    current: () => t.list_[0] ?? null,
    close: async () => tab,
    select: () => tab,
    mark: () => tab,
    query: async (_tab: any, steps: any[]) => t.q(steps),
    inspect: async (_tab: any, _s: string, refs: string[], what: string) => refs.map(() => (what === 'state' ? t.st : t.values[what])),
    locate: async () => t.loc,
    point: async (_tab: any, _st: any, { coordinate }: any) => ({ x: coordinate[0], y: coordinate[1] }),
    click: async () => t.result,
    hover: async () => t.result,
    settle: async () => {},
    formInput: async () => ({ ok: true }),
    focus: async () => {},
    typeText: async () => t.result,
    keys: async () => t.result,
    selectOptions: async (_tab: any, _ref: string, wants: any[]) => wants,
    scrollTo: async () => {},
    capture: async (_tab: any, st: any, o: any) => ({
      data: 'IMG',
      width: 400,
      height: 300,
      frame: { w: st.w, h: st.h },
      rect: o.region ? {} : null,
    }),
    captureFull: async () => ({ data: 'FULL', width: 1280, height: 4000, frame: { w: 1280, h: 4000 }, truncated: true }),
    handleDialog: async (_tab: any, accept: boolean) => (accept ? 'Accepted.' : 'Dismissed.'),
    waitForLoad: async () => {},
    readPage: async () => ({ lines: ['- button "Go" [ref_1]'], truncated: false }),
    exec: async () => '{"v":{"a":1}}',
    peek: async () => '{"v":{"a":1}}',
    console: () => [{ at: 0, level: 'error', text: 'oops', source: 'x.js:1' }],
    wheel: async () => t.result,
    drag: async () => t.result,
    state: (chatId: string) => `STATE ${chatId}`,
    navigate: async (_tab: any, url: string) => ({ url, title: 'Next' }),
    intent: async () => t.intentValue ?? null,
  };
  for (const k of Object.keys(t.impl)) {
    t[k] = (...a: any[]) => {
      calls.push([k, ...a]);
      return t.impl[k](...a);
    };
  }
  t.called = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));
  return t;
}

/** The operations over fake tabs, a virtual clock and recording gates. */
export function ops(o: any = {}) {
  const tabs = fakeTabs();
  const clock = { now: 1_000_000 };
  const gates: string[] = [];
  const navs: string[] = [];
  const confirms: string[] = [];
  const images: any[] = [];
  const ctx: any = { chatId: 'c1', segmentId: 's1', signal: o.signal };
  const dispatch = createScriptOps({
    tabs,
    ctx,
    images,
    deadline: clock.now + (o.budget ?? 30_000),
    gate: (_tab: any, need: string) => {
      gates.push(need);
      if (o.deny === need) throw new ToolError('https://a.test is read only for this chat.', 'read_only');
    },
    navigate: async (tab: any, url: string) => {
      navs.push(url);
      return `Navigated ${tab.id}`;
    },
    confirmed: async (_tab: any, summary: string) => {
      confirms.push(summary);
      if (o.refuse) throw new ToolError('The user did not allow this.', 'denied');
    },
    ...(o.act ? { act: o.act } : {}),
    wait: async (ms: number) => {
      clock.now += ms;
    },
    now: () => clock.now,
  });
  return { tabs, clock, gates, navs, confirms, images, ctx, d: dispatch };
}

export const loc = (extra: any = {}) => ({ tab: 't1', steps: [{ k: 'css', s: 'button' }], desc: 'locator("button")', ...extra });

// ---------------------------------------------------------------- tabs and pages

export class FakeWorker extends EventEmitter {
  posted: any[] = [];
  terminated = 0;
  src: string;
  opts: any;
  constructor(src: string, opts: any) {
    super();
    this.src = src;
    this.opts = opts;
  }
  postMessage(m: string) {
    this.posted.push(JSON.parse(m));
  }
  terminate() {
    this.terminated++;
    return this.terminated > 1 ? undefined : Promise.reject(new Error('already gone'));
  }
  /** The run the session last asked for. */
  get run() {
    return this.posted.filter((m) => m.t === 'run').at(-1)?.run;
  }
  /** A message from the worker; 'done' is for the latest run unless it says otherwise. */
  send(m: any) {
    this.emit('message', typeof m === 'string' ? m : JSON.stringify(m.t === 'done' && !('run' in m) ? { ...m, run: this.run } : m));
  }
}
export const answers = (w: FakeWorker) => w.posted.filter((m) => m.t !== 'run');

/** A session over fake workers; `workers` lists each one it started. */
export function fakeSession() {
  const workers: FakeWorker[] = [];
  const session = new ScriptSession({
    init: { platform: 'linux' },
    makeWorker: (src: string, opts: any) => (workers.push(new FakeWorker(src, opts)), workers.at(-1)),
  });
  const run = (o: any = {}) =>
    session.run({
      code: o.code ?? 'x',
      timeoutMs: o.timeoutMs ?? 5000,
      signal: o.signal,
      current: o.current,
      dispatch: o.dispatch ?? (async () => undefined),
    });
  return { session, workers, run, w: () => workers.at(-1)! };
}

/** browser_script through createBrowserTools, over fake tabs and a scripted fake worker per session. */
export function tool(worker: (w: FakeWorker) => void, o: any = {}) {
  const tabs = fakeTabs();
  const grants = new OriginGrants({
    file: null,
    anchor: () => 'ask',
    ask: o.ask ?? (async () => ({ decision: 'allow', scope: 'once', level: 'write' })),
  });
  grants.set('https://a.test', 'write');
  let made: FakeWorker = null as any;
  const sessions = new ScriptSessions({
    init: SESSION_INIT,
    makeWorker: (src: string, opts: any) => {
      made = new FakeWorker(src, opts);
      return made;
    },
  });
  const tools = createBrowserTools({ tabs, grants, sessions });
  const t = tools.find((x: any) => x.name === 'browser_script');
  const ctx = { chatId: 'c1', segmentId: 's1', signal: o.signal };
  const call = (args: any) => {
    const p = t.handler(args, ctx);
    setImmediate(() => made && worker(made));
    return p;
  };
  return { tabs, grants, t, sessions, call, worker: () => made };
}
