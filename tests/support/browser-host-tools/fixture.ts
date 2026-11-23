// The harness-neutral browser_* tools (electron/capabilities/browser/hostTools.cjs), driven through
// their real handlers over a fake BrowserTabs and a real OriginGrants (site gating, confirmations,
// upload folder checks, batches and registration).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { calendarNow } from '../../../shared/calendarDay.mjs';

const require = createRequire(import.meta.url);
/** Today for the exact-text cases, and the line browser_tabs_context names it with. */
export const CALENDAR = calendarNow(new Date('2026-10-20T19:00:00Z'), 'America/Los_Angeles');
export const TODAY =
  'Today is Tuesday, 2026-10-20 (ISO week 43, America/Los_Angeles). This week is 2026-10-19 to 2026-10-25 (Monday to Sunday); last week was 2026-10-12 to 2026-10-18.';

export { browserToolSpecs } from '../tool-specs.ts';
export const {
  createBrowserTools,
  registerBrowserTools,
  inAppBrowserEnabled,
  BROWSER_TOOL_NAMES,
} = require('../../../electron/capabilities/browser/hostTools.cjs');
export const { OriginGrants } = require('../../../electron/capabilities/browser/origins.cjs');
export const { ToolError } = require('../../../electron/capabilities/contract/registry.cjs');

export const STATE = 'STATE c1';

/** A fake BrowserTabs: every method records its call and delegates to a replaceable impl. */
export function makeTabs() {
  const calls: any[][] = [];
  const tab: any = { id: 't1', url: 'https://a.example/page', title: 'A page', kind: 'tab', chatId: 'c1' };
  const t: any = { calls, tab, list_: [tab] };
  t.called = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));
  t.impl = {
    resolve: async () => t.tab,
    run: async (_tab: any, fn: () => any) => fn(),
    awaitUser: async (_tab: any, p: Promise<any>) => p,
    ready: async () => ({ w: 800, h: 600 }),
    create: async (chatId: string) => {
      const nt = { id: 't2', url: 'about:blank', title: '', kind: 'tab', chatId };
      t.list_.push(nt);
      return nt;
    },
    close: async (_c: string, id: string) => ({ id }),
    select: (_c: string, id: string) => ({ ...t.tab, id }),
    mark: (_c: string, id: string) => ({ id }),
    list: () => t.list_,
    current: () => t.list_[0],
    historyTarget: () => 'https://a.example/prev',
    history: async () => ({ url: 'https://a.example/prev', title: 'Prev' }),
    navigate: async (_tab: any, url: string) => ({ url, title: 'T' }),
    readPage: async () => ({ lines: ['button "OK" [ref_1]'], truncated: false }),
    find: async () => ['button "OK" [ref_1]'],
    pageText: async () => ({ title: 'A page', url: t.tab.url, text: 'hello', truncated: false }),
    capture: async () => ({ width: 800, height: 600, data: 'IMG' }),
    scrollTo: async () => {},
    settle: async () => {},
    point: async (_tab: any, _st: any, target: any) =>
      target.ref
        ? { x: 10.4, y: 20.6, name: 'Submit' }
        : target.coordinate
          ? { x: target.coordinate[0], y: target.coordinate[1] }
          : { x: 0, y: 0 },
    hover: async () => undefined,
    scroll: async () => undefined,
    click: async () => undefined,
    drag: async () => undefined,
    typeText: async () => undefined,
    keys: async () => undefined,
    formInput: async (_tab: any, _ref: string, value: any) => ({ value }),
    exec: async () => '42',
    console: () => [],
    requests: () => [],
    responseBody: async () => ({ request: { method: 'GET', url: 'https://a.example/x', status: 200, mime: 'text/plain' }, body: 'hi' }),
    resize: async () => 'Resized.',
    handleDialog: async (_tab: any, accept: boolean) => (accept ? 'Accepted the dialog.' : 'Dismissed the dialog.'),
    setFiles: async () => {},
    intent: async () => t.intentValue ?? null,
    // returns at once (userTurn.cjs): the agent's turn ends and the user continues it
    requestSignin: () => undefined,
    state: (chatId: string) => `STATE ${chatId}`,
  };
  for (const k of Object.keys(t.impl)) {
    t[k] = (...a: any[]) => {
      calls.push([k, ...a]);
      return t.impl[k](...a);
    };
  }
  return t;
}

/** The tools over a fake tabs and a real OriginGrants (https://a.example is allowed read and write). */
export function world(o: Record<string, any> = {}) {
  const st: any = { anchor: 'ask', answers: [] as any[], answer: { decision: 'allow', scope: 'once', level: 'write' }, asks: [] as any[] };
  const grants =
    o.grants ??
    new OriginGrants({
      file: null,
      anchor: () => st.anchor,
      // a card's signal (#1865) is not part of what it shows
      ask: async ({ signal: _signal, ...req }: any) => {
        st.asks.push(req);
        return st.answers.length ? st.answers.shift() : st.answer;
      },
    });
  if (!o.grants) grants.set('https://a.example', 'write');
  const tabs = makeTabs();
  const tools = createBrowserTools({
    tabs,
    grants,
    enabled: o.enabled,
    confirm: o.confirm,
    folders: o.folders,
    snapshots: o.snapshots,
    calendar: () => CALENDAR,
  });
  const ctx: any = { chatId: 'c1', segmentId: 's1' };
  const call = (name: string, args: any = {}, c: any = ctx) => tools.find((x: any) => x.name === name).handler(args, c);
  return { st, grants, tabs, tools, ctx, call };
}

export const texts = (out: any[]) => out.filter((c) => c.type === 'text').map((c) => c.text);
export const first = (out: any[]) => out[0].text;
export const endsWithState = (out: any[]) => assert.deepEqual(out[out.length - 1], { type: 'text', text: STATE });
/** The structured part a refusal adds to its message (refusals.cjs), checked by the refusal tests below. */
export const REFUSAL = /\n<refusal reason="[a-z_]+" retryable="(?:true|false)">\n[\s\S]*?<\/refusal>/;
export const code = (c: string, re?: RegExp) => (e: any) => {
  assert.ok(e instanceof ToolError, `expected a ToolError, got ${e}`);
  assert.equal(e.code, c);
  if (re) assert.match(e.message.replace(REFUSAL, ''), re);
  return true;
};
/** A refusal with its reason and whether retrying can help. */
export const refusal =
  (c: string, reason: string, retryable = false) =>
  (e: any) => {
    code(c)(e);
    assert.equal(e.reason, reason);
    assert.equal(e.retryable, retryable);
    assert.match(e.message, new RegExp(`\\n<refusal reason="${reason}" retryable="${retryable}">\\nnext: \\S`));
    assert.equal(/Do not try to achieve the same outcome/.test(e.message), !retryable);
    return true;
  };
