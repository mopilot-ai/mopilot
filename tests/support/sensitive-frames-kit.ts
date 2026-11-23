// The checkout fixture of the control matrix's group J (docs/control-plane/matrix/J.md): a checkout page whose "Pay" sits in a cross-origin iframe, driven by browser_* for every harness, the Codex Browser plugin's iab backend and Your Chrome, with real site rules that record each card.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { world, claudeSession, codexConnection, switchingChat } from './control-matrix-kit.ts';
import { setup, tabOf } from './browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../../electron/capabilities/browser/origins.cjs');
const { BrowserTabs } = require('../../electron/capabilities/browser/host.cjs');
const { IabBackend } = require('../../electron/capabilities/browser/iabBackend.cjs');
const { chromeTools } = require('../../electron/capabilities/browser/extension.cjs');

export const SHOP = 'https://shop.test/checkout';
/** The checkout iframe's "Pay $49.00": a submit in a form with card fields (payment details, CM-J02). */
export const PAY = {
  tag: 'button',
  name: 'Pay $49.00',
  role: 'button',
  button: true,
  submits: true,
  editable: false,
  form: { payment: true, secrets: 0, newPassword: false, submit: 'Pay $49.00' },
};
/** The card number field in that form. */
export const CARD = { tag: 'input', name: 'Card number', editable: true, payment: true, form: PAY.form };
/** A saved-card "Place order" in a cross-origin frame: a purchase with no payment details (Full access covers it, D4). */
export const SAVED = {
  tag: 'button',
  name: 'Place order',
  button: true,
  submits: true,
  form: { payment: false, secrets: 0, submit: 'Place order' },
};

/** Real site rules in `anchor` mode for shop.test (write allowed), recording every card. */
export function grantsIn(anchor: string, browser: 'iab' | 'chrome' = 'iab') {
  const cards: any[] = [];
  const g = new OriginGrants({
    browser,
    anchor: () => anchor,
    ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async (req: any) => (cards.push(req), true),
  });
  g.set('https://shop.test', 'write');
  return { g, cards };
}

/**
 * The checkout page in a real BrowserTabs tab: the top frame, a cross-origin checkout iframe F1 (its own process,
 * owner ref_10) and, inside it, nothing more unless a case adds it. `answers` is what each frame's page agent says.
 */
export function checkout(t: any, anchor = 'full') {
  const h = setup(t);
  const wc = h.newWC();
  wc.url = SHOP;
  const tab = tabOf(h, 'tab_aaaaaa', 'c', wc);
  tab.frames.set('F1', { sessionId: 'F1', parent: '', frameId: 'frame-1', world: null, ownerRef: 'ref_10' });
  wc.ownerFrames.ref_10 = 'frame-1';
  const answers: Record<string, any> = { '': { frame: true, owner: 'ref_10', x: 20, y: 30 }, F1: PAY };
  const asked: any[] = [];
  wc.ops.intent = (args: any, sid?: string) => (asked.push([args, sid ?? '']), answers[sid ?? '']);
  const { g, cards } = grantsIn(anchor);
  const w = world();
  for (const n of ['browser_navigate', 'browser_tabs_context']) w.r.tools.delete(n);
  for (const tool of createBrowserTools({ tabs: h.tabs, grants: g })) w.r.register(tool);
  const clicks = () => wc.debugger.calls.filter((c: any) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  return { h, w, wc, tab, answers, asked, cards, clicks, grants: g };
}

/** Claude Code, a Codex thread, and the chat's Codex thread after a switch from Claude Code (its Claude segment first). */
export async function harnesses(w: any) {
  const claude = claudeSession(w, { chatId: 'c', segmentId: 'claude-1' });
  const codex = codexConnection(w, () => 'c');
  const cx = await codex.session((await codex.startThread()).thread.id);
  const sw = switchingChat(w);
  sw.startOnClaude('c');
  const before = sw.claudeNow('c');
  const after = await sw.codex.session((await sw.switchTo('c', 'codex')).nativeId);
  return {
    'Claude Code': (name: string, args: any) => claude.call(name, args),
    Codex: (name: string, args: any) => cx.call(name, args),
    'Claude Code before the switch': (name: string, args: any) => before.call(name, args),
    'Codex after the switch': (name: string, args: any) => after.call(name, args),
  } as Record<string, (name: string, args: any) => Promise<any>>;
}

/** The Codex Browser plugin's iab backend over the real BrowserTabs.intent, with a fake pane tab and its frames. */
export function plugin(anchor = 'full') {
  const { g, cards } = grantsIn(anchor);
  const dbg: any = Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand: async () => ({}) });
  const answers: Record<string, any> = { '': { frame: true, owner: 'ref_10', x: 20, y: 30 }, F1: PAY };
  const asked: any[] = [];
  const sent: any[] = [];
  const tab: any = {
    id: 'tab_1',
    chatId: 'c',
    kind: 'tab',
    url: SHOP,
    title: 'Checkout',
    closed: false,
    takenOver: false,
    dialog: null,
    frames: new Map([['F1', { sessionId: 'F1', parent: '', frameId: 'frame-1', ownerRef: 'ref_10' }]]),
    queue: Promise.resolve(),
    created: true,
    used: 0,
    dialogWaiters: new Set(),
    get backend() {
      return this.wc;
    },
    wc: { debugger: dbg, isDestroyed: () => false, id: 1 },
    async attach() {},
    hold() {},
    rendererGone: () => false,
    async send(m: string, p: any, sid = '') {
      sent.push([m, p?.type, sid]);
      return {};
    },
    async agent(op: string, args: any, sid = '') {
      if (op !== 'intent') return { count: 0 };
      asked.push([args, sid]);
      return answers[sid];
    },
    async childFrame(_place: any, owner: string) {
      return { sessionId: [...tab.frames.values()].find((f: any) => f.ownerRef === owner).sessionId };
    },
    async agentAt(place: any, op: string, args: any) {
      return tab.agent(op, args, place.sessionId);
    },
  };
  const host: any = Object.create(BrowserTabs.prototype);
  Object.assign(host, {
    o: {},
    chats: new Map([['c', { tabs: new Map([[tab.id, tab]]) }]]),
    useSeq: 0,
    downloadListeners: new Set(),
    turnsEnded: new Map(),
    emit() {},
    list: () => [tab],
    current: () => tab,
    select() {},
    mark() {},
  });
  const b = new IabBackend({ threadId: 'thread-1', chatOf: () => 'c', tabs: () => host, grants: () => g, enabled: () => true });
  b.peers.add({ notify() {} } as any);
  const cdp = (method: string, commandParams: any = {}, target: any = {}) =>
    b.handle('executeCdp', { session_id: 'thread-1', turn_id: 'turn-1', target: { tabId: b.idOf(tab), ...target }, method, commandParams });
  return { cards, answers, asked, sent, tab, cdp, b, grants: g };
}

/** Your Chrome over a fake Playwright MCP instance: `evaluate` answers browser_evaluate by its target ('' for the focus). */
export async function yourChrome(anchor: string, name: string, args: any, evaluate: (target: string) => any, snapshot: string, url = SHOP) {
  const { g, cards } = grantsIn(anchor, 'chrome');
  const evaluated: string[] = [];
  const inst: any = {
    url,
    needsSnapshot: false,
    async call(tool: string, a: any) {
      if (tool === 'browser_evaluate') {
        evaluated.push(a.target ?? '');
        const r = evaluate(a.target ?? '');
        return { content: [{ type: 'text', text: `### Result\n${JSON.stringify({ mopilot_intent: true, ...r }, null, 2)}\n` }] };
      }
      return { content: [{ type: 'text', text: `### Page\n- Page URL: ${inst.url}\n### Snapshot\n${snapshot}` }] };
    },
  };
  const [tool] = chromeTools({
    channel: { instance: async () => inst },
    grants: g,
    schemas: [{ name, inputSchema: { type: 'object', properties: {} } }],
  });
  await tool.handler(args, { chatId: 'c', segmentId: 's' });
  return { cards, evaluated };
}

/** A Playwright snapshot of the checkout: the focus in the card field inside the cross-origin iframe. */
export const SNAPSHOT_FOCUS_IN_FRAME = [
  '- generic [ref=e1]:',
  '  - paragraph [ref=e2]: 1 × Desk lamp — $49.00',
  '  - iframe [active] [ref=e3]:',
  '    - textbox "Card number" [active] [ref=f1e2]: 4242 4242 4242 4242',
  '    - button "Pay $49.00" [ref=f1e3]',
].join('\n');
