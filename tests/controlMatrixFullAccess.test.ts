// The control matrix (docs/control-plane/matrix.md), Full access and sensitive browser actions: in a chat with Full
// access (Claude Code bypassPermissions, Codex full-access, an ACP mode the agent maps to full) an ordinary delete,
// purchase, booking, transfer, sent message or upload runs without the "can't be undone" card, as in Claude
// Desktop's and Codex's most permissive browser modes; entering or submitting payment details, changing a password,
// a high-risk site and typing into a password field keep their checks, and every other mode still asks. The rule is
// decided once, in OriginGrants.act, for the in-app browser's browser_* tools, the Codex Browser plugin's iab
// backend and Your Chrome. Case ids (CM-J..) start every title. OriginGrants, siteRisk, the anchor mapping, the
// browser_* handlers, the iab backend and the Your Chrome tools are real; pages, Chrome and the harnesses are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const {
  FULL_ACCESS_COVERS,
  fullAccessCovers,
  sensitiveAction,
  sensitiveByName,
  VERBS,
} = require('../electron/capabilities/browser/siteRisk.cjs');
const { anchorOf } = require('../electron/capabilities/contract/policy.cjs');
const { chatAnchorOf } = require('../electron/capabilities/anchor.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { IabBackend } = require('../electron/capabilities/browser/iabBackend.cjs');
const { BrowserTabs } = require('../electron/capabilities/browser/host.cjs');
const { chromeTools } = require('../electron/capabilities/browser/extension.cjs');

const ROOT = new URL('../', import.meta.url);
const CHAT = 'chat-1';
const ctx = { chatId: CHAT, segmentId: 'seg-1' };
const SITE = 'https://shop.test/';

/** The actions on an ordinary site that Full access runs without a card, as the page agent describes their element. */
const COVERED: [string, any][] = [
  ['click "Delete repository"', { button: true, name: 'Delete repository' }],
  ['click "Place order"', { button: true, name: 'Place order' }],
  ['click "Book now"', { button: true, name: 'Book now' }],
  ['click "Transfer"', { button: true, name: 'Transfer' }],
  ['click "Send"', { button: true, name: 'Send' }],
  [
    'submit a contact form',
    { button: true, name: 'Go', submits: true, form: { payment: false, secrets: 0, newPassword: false, submit: 'Post comment' } },
  ],
];
/** The actions that still ask in Full access: payment details and a password change. */
const STILL_ASK: [string, any, any][] = [
  ['submit a payment form', { kind: 'click' }, { button: true, name: 'Continue', submits: true, form: { payment: true, secrets: 0 } }],
  // a payment form's submit named like a purchase is still payment details, not a covered purchase
  [
    'click "Pay $49.99" in a card form',
    { kind: 'click' },
    { button: true, name: 'Pay $49.99', submits: true, form: { payment: true, secrets: 0 } },
  ],
  [
    'click "Place order" in a card form',
    { kind: 'click' },
    { button: true, name: 'Place order', submits: true, form: { payment: true, secrets: 0 } },
  ],
  ['type a card number', { kind: 'type' }, { editable: true, payment: true, name: 'Card number' }],
  ['change a password', { kind: 'click' }, { button: true, name: 'Change password' }],
];

/** A real site table whose anchor and card answers the test sets. */
function grantsWith(browser: 'iab' | 'chrome', o: { anchor?: () => string } = {}) {
  const asked: any[] = [];
  const confirmed: any[] = [];
  const g = new OriginGrants({
    browser,
    anchor: o.anchor ?? (() => 'full'),
    ask: async (req: any) => (asked.push(req), { decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async (req: any) => (confirmed.push(req), true),
  });
  g.set('https://shop.test', 'write');
  return { g, asked, confirmed };
}

/* ---------- the in-app browser's browser_* tools over a fake tab ---------- */

function iabTools(anchor: string) {
  const { g, confirmed } = grantsWith('iab', { anchor: () => anchor });
  const tab: any = { id: 't1', url: SITE, title: 'Shop', kind: 'tab', chatId: CHAT };
  const st: any = { intent: null, clicks: 0, typed: 0 };
  const tabs: any = {
    resolve: async () => tab,
    run: async (_t: any, fn: () => any) => fn(),
    awaitUser: async (_t: any, p: Promise<any>) => p,
    ready: async () => ({ w: 800, h: 600 }),
    list: () => [tab],
    current: () => tab,
    point: async () => ({ x: 10, y: 20, name: 'Button' }),
    scrollTo: async () => {},
    settle: async () => {},
    click: async () => void st.clicks++,
    typeText: async () => void st.typed++,
    keys: async () => {},
    handleDialog: async () => 'Accepted the dialog.',
    intent: async () => st.intent,
    readPage: async () => ({ lines: [], truncated: false }),
    state: () => 'STATE',
  };
  const tools = createBrowserTools({ tabs, grants: g });
  const call = (name: string, args: any) => tools.find((x: any) => x.name === name).handler(args, ctx);
  return { g, confirmed, st, tab, call };
}

/* ---------- the Codex Browser plugin's iab backend over a fake pane tab ---------- */

function pluginBackend(anchor: string) {
  const { g, confirmed } = grantsWith('iab', { anchor: () => anchor });
  const dbg: any = Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand: async () => ({}) });
  const sent: string[] = [];
  const tab: any = {
    id: 'tab_1',
    chatId: CHAT,
    kind: 'tab',
    url: SITE,
    title: '',
    closed: false,
    signin: null,
    takenOver: false,
    dialog: null,
    frames: new Map(),
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
    async send(m: string) {
      sent.push(m);
      return {};
    },
    async agent() {
      return { count: 0 };
    },
  };
  const host: any = Object.create(BrowserTabs.prototype);
  Object.assign(host, {
    o: {},
    chats: new Map([[CHAT, { tabs: new Map([[tab.id, tab]]) }]]),
    useSeq: 0,
    downloadListeners: new Set(),
    pageListeners: new Set(),
    turnsEnded: new Map(),
    intentAt: null as any,
    focus: null as any,
    emit() {},
    list: () => [tab],
    current: () => tab,
    select() {},
    mark() {},
    async intent(_t: any, target: any) {
      return target?.point ? host.intentAt : host.focus;
    },
  });
  const b = new IabBackend({ threadId: 'thread-1', chatOf: () => CHAT, tabs: () => host, grants: () => g, enabled: () => true });
  b.peers.add({ notify() {} } as any);
  const cdp = (method: string, commandParams: any = {}) =>
    b.handle('executeCdp', { session_id: 'thread-1', turn_id: 'turn-1', target: { tabId: b.idOf(tab) }, method, commandParams });
  return { g, confirmed, host, tab, sent, cdp };
}

/* ---------- Your Chrome's tools over a fake Playwright MCP instance ---------- */

async function chromeCall(anchor: string, name: string, args: any, intent: any, snapshot = '') {
  const { g, confirmed } = grantsWith('chrome', { anchor: () => anchor });
  const calls: string[] = [];
  const inst: any = {
    url: SITE,
    needsSnapshot: false,
    async call(tool: string) {
      calls.push(tool);
      if (tool === 'browser_evaluate')
        return { content: [{ type: 'text', text: `### Result\n${JSON.stringify({ mopilot_intent: true, ...intent }, null, 2)}\n` }] };
      return { content: [{ type: 'text', text: `Page URL: ${inst.url}\n${snapshot}` }] };
    },
  };
  const [tool] = chromeTools({
    channel: { instance: async () => inst },
    grants: g,
    schemas: [{ name, inputSchema: { type: 'object', properties: {} } }],
  });
  let error: any = null;
  try {
    await tool.handler(args, ctx);
  } catch (e) {
    error = e;
  }
  return { confirmed, calls, error };
}

/* ---------- cases ---------- */

test('CM-J01: browser_* in Full access runs an ordinary delete, purchase, booking, transfer, message or form submit without a card; Ask and Auto still ask', async () => {
  for (const anchor of ['full', 'ask', 'auto']) {
    for (const [what, intent] of COVERED) {
      const w = iabTools(anchor);
      w.st.intent = intent;
      await w.call('browser_computer', { action: 'left_click', ref: 'ref_1' });
      assert.equal(w.st.clicks, 1, `${anchor}: ${what} ran`);
      assert.equal(w.confirmed.length, anchor === 'full' ? 0 : 1, `${anchor}: ${what}`);
    }
    // accepting a "Delete this item?" dialog, and Enter in a form whose submit sends a message
    const w = iabTools(anchor);
    w.tab.dialog = { type: 'confirm', message: 'Delete this item?' };
    await w.call('browser_handle_dialog', { accept: true });
    w.tab.dialog = null;
    w.st.intent = { editable: true, form: { payment: false, secrets: 0, newPassword: false, submit: 'Send message' } };
    await w.call('browser_computer', { action: 'key', text: 'Enter' });
    assert.equal(w.confirmed.length, anchor === 'full' ? 0 : 2, `${anchor}: dialog accept and Enter submit`);
  }
});

test('CM-J02: browser_* in Full access still asks for payment details and a password change, on a high-risk site, and refuses a password field', async () => {
  for (const [what, action, intent] of STILL_ASK) {
    const w = iabTools('full');
    w.st.intent = intent;
    if (action.kind === 'type') await w.call('browser_computer', { action: 'type', text: '4242', ref: 'ref_2' });
    else await w.call('browser_computer', { action: 'left_click', ref: 'ref_1' });
    assert.equal(w.confirmed.length, 1, `${what} asks`);
    assert.ok(['submit payment details', 'enter payment details', 'change a password'].includes(w.confirmed[0].sensitive.verb), what);
  }
  // a high-risk site asks for every action, a covered delete included, and the card still names the delete
  const bank = iabTools('full');
  bank.tab.url = 'https://www.chase.com/accounts';
  bank.st.intent = { button: true, name: 'Delete payee' };
  await bank.call('browser_computer', { action: 'left_click', ref: 'ref_1' });
  assert.deepEqual(
    [bank.confirmed.length, bank.confirmed[0].sensitive?.verb, bank.confirmed[0].risk?.category],
    [1, 'delete something', 'banking'],
  );
  // typing into a password field is refused before any card, whatever the mode
  const pw = iabTools('full');
  pw.st.intent = { editable: true, secret: true, name: 'Password' };
  await assert.rejects(pw.call('browser_computer', { action: 'type', text: 'hunter2' }), (e: any) => e.code === 'password_field');
  assert.equal(pw.st.typed, 0);
  // a read-only chat refuses the write even for a covered kind
  const ro = iabTools('readOnly');
  ro.st.intent = COVERED[0][1];
  await assert.rejects(ro.call('browser_computer', { action: 'left_click', ref: 'ref_1' }), (e: any) => e.code === 'read_only');
});

test('CM-J03: Your Chrome follows the same rule: Full access runs an order or a dialog accept without a card, payment details still ask', async () => {
  const order = { button: true, name: 'Place order' };
  assert.equal((await chromeCall('full', 'browser_click', { target: 'e1', element: 'Place order' }, order)).confirmed.length, 0);
  assert.equal((await chromeCall('ask', 'browser_click', { target: 'e1', element: 'Place order' }, order)).confirmed.length, 1);
  assert.equal((await chromeCall('auto', 'browser_click', { target: 'e1', element: 'Place order' }, order)).confirmed.length, 1);
  // the page can't be read: the agent's element name decides, and Full access covers it the same way
  const unread = await chromeCall('full', 'browser_click', { target: 'e1', element: 'Delete account' }, { none: true });
  assert.equal(unread.confirmed.length, 0);
  assert.equal(unread.calls.at(-1), 'browser_click');
  const dialog = '### Modal state\n- ["confirm" dialog with message "Delete this repository?"]: can be handled by browser_handle_dialog';
  assert.equal((await chromeCall('full', 'browser_handle_dialog', { accept: true }, {}, dialog)).confirmed.length, 0);
  // payment details: a card number in a form fill, and Enter in a payment form
  const fill = await chromeCall(
    'full',
    'browser_fill_form',
    { fields: [{ target: 'e3', value: '4242' }] },
    { editable: true, payment: true },
  );
  assert.equal(fill.confirmed[0]?.sensitive.verb, 'enter payment details');
  const pay = await chromeCall(
    'full',
    'browser_press_key',
    { key: 'Enter' },
    { editable: true, form: { payment: true, secrets: 0, submit: 'Pay' } },
  );
  assert.equal(pay.confirmed[0]?.sensitive.verb, 'submit payment details');
  assert.equal(pay.confirmed[0]?.browser, 'chrome');
  const payClick = await chromeCall(
    'full',
    'browser_click',
    { target: 'e5', element: 'Pay $49.99' },
    { button: true, name: 'Pay $49.99', submits: true, form: { payment: true, secrets: 0, submit: 'Pay $49.99' } },
  );
  assert.equal(payClick.confirmed[0]?.sensitive.verb, 'submit payment details');
  // a password field is still refused
  const pw = await chromeCall('full', 'browser_type', { target: 'e4', text: 'x' }, { editable: true, secret: true });
  assert.equal(pw.error?.code, 'password_field');
});

test('CM-J04: the Codex Browser plugin on the pane follows the same rule: Full access runs a delete click, a dialog accept and an upload; a card number asks', async () => {
  const full = pluginBackend('full');
  full.host.intentAt = { button: true, name: 'Delete' };
  await full.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
  await full.cdp('DOM.setFileInputFiles', { files: ['/tmp/report.pdf'], nodeId: 3 });
  full.tab.dialog = { type: 'confirm', message: 'Delete this file?' };
  await full.cdp('Page.handleJavaScriptDialog', { accept: true });
  full.tab.dialog = null;
  assert.equal(full.confirmed.length, 0);
  assert.ok(full.sent.includes('Input.dispatchMouseEvent'));
  full.host.focus = { editable: true, payment: true, name: 'Card number' };
  await full.cdp('Input.insertText', { text: '4242' });
  assert.deepEqual(
    full.confirmed.map((c: any) => c.sensitive.verb),
    ['enter payment details'],
  );
  // in Ask the delete click and the upload ask, as before
  const ask = pluginBackend('ask');
  ask.host.intentAt = { button: true, name: 'Delete' };
  await ask.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
  await ask.cdp('DOM.setFileInputFiles', { files: ['/tmp/report.pdf'], nodeId: 3 });
  assert.deepEqual(
    ask.confirmed.map((c: any) => c.sensitive.verb),
    ['delete something', 'upload files'],
  );
});

test('CM-J05: every harness’s Full access mode gets the rule and every other mode keeps the card', async () => {
  const modes: [string, any, 'full' | 'ask' | 'auto' | 'readOnly'][] = [
    ['Claude Code bypassPermissions', { harness: 'claude', permission: 'bypassPermissions' }, 'full'],
    ['Codex full-access', { harness: 'codex', permission: 'full-access' }, 'full'],
    ['ACP mode mapped to full', { harness: 'acp:gemini', acp: { modes: { currentModeId: 'yolo' }, anchors: { yolo: 'full' } } }, 'full'],
    ['Claude Code default', { harness: 'claude', permission: 'default' }, 'ask'],
    ['Claude Code acceptEdits', { harness: 'claude', permission: 'acceptEdits' }, 'auto'],
    ['Codex auto-review', { harness: 'codex', permission: 'auto-review' }, 'auto'],
    ['ACP unmapped mode', { harness: 'acp:gemini', acp: { modes: { currentModeId: 'default' }, anchors: {} } }, 'ask'],
  ];
  const del = { kind: 'delete', verb: 'delete something', detail: 'Delete' };
  const pay = { kind: 'payment', verb: 'submit payment details', detail: 'Pay' };
  for (const [name, o, expected] of modes) {
    const anchor = anchorOf(o);
    assert.equal(anchor, expected, name);
    for (const browser of ['iab', 'chrome'] as const) {
      const { g, confirmed } = grantsWith(browser, { anchor: () => anchor });
      assert.equal(await g.act(SITE, ctx, { tool: 'click', sensitive: del }), anchor !== 'full', `${name} ${browser}: delete`);
      assert.equal(await g.act(SITE, ctx, { tool: 'click', sensitive: pay }), true, `${name} ${browser}: payment`);
      assert.equal(await g.act(SITE, ctx, { tool: 'click' }), false, `${name} ${browser}: an ordinary click`);
      assert.equal(confirmed.length, anchor === 'full' ? 1 : 2);
    }
  }
});

test('CM-J06: a chat that switches harness gets the rule of the segment that calls, decided on every call', async () => {
  // Claude Code in bypassPermissions, then Codex in its default mode, then back to Claude Code
  let session: any = { permission: 'bypassPermissions', acp: null };
  let harness = 'claude';
  const deps = {
    sessions: { get: () => session },
    controller: { ref: () => ({ kind: harness }) },
    prefs: () => ({ permission: 'default' }),
  };
  const { g, confirmed } = grantsWith('iab', { anchor: () => chatAnchorOf(CHAT, deps) });
  const del = { kind: 'delete', verb: 'delete something', detail: 'Delete' };
  await g.act(SITE, ctx, { sensitive: del });
  assert.equal(confirmed.length, 0, 'Claude Code in bypassPermissions');
  harness = 'codex';
  session = { permission: 'auto-review', acp: null };
  await g.act(SITE, ctx, { sensitive: del });
  assert.equal(confirmed.length, 1, 'the Codex segment in Auto asks');
  session = { permission: 'full-access', acp: null };
  await g.act(SITE, ctx, { sensitive: del });
  assert.equal(confirmed.length, 1, 'Codex switched to Full access runs it');
  harness = 'claude';
  session = { permission: null, acp: null };
  await g.act(SITE, ctx, { sensitive: del });
  assert.equal(confirmed.length, 2, 'back on Claude Code with no mode of its own: the app default asks');
});

test('CM-J07: guard: one rule names what Full access covers, every sensitive kind is either covered or asks, and no browser path decides it alone', () => {
  // a page tool (WebMCP) the page itself marks consequential is covered as a purchase is (#3571 G6)
  assert.deepEqual([...FULL_ACCESS_COVERS].sort(), ['consequential', 'delete', 'purchase', 'send_message', 'transfer', 'upload']);
  // every kind sensitiveAction names is decided: the payment and password kinds, granting an app access to the account
  // (OAuth consent, #1619) and a target nobody read ask, the rest are covered
  const asks = Object.keys(VERBS).filter((k) => !fullAccessCovers({ kind: k }));
  assert.deepEqual(asks.sort(), ['oauth_consent', 'password_change', 'payment', 'payment_entry', 'unread_target', 'unreadable_frame']);
  // an unknown kind, or none, still asks (fails closed)
  assert.equal(fullAccessCovers({ kind: 'mystery' }), false);
  assert.equal(fullAccessCovers({ verb: 'something' }), false);
  assert.equal(fullAccessCovers(null), false);
  // the names behind the benchmark's stalls are covered kinds
  for (const name of ['Place your order', 'Checkout', 'Send', 'Delete', 'Confirm booking'])
    assert.ok(fullAccessCovers(sensitiveByName(name)), name);
  assert.equal(sensitiveAction({ button: true, name: 'Next' }, { kind: 'click' }), null);
  // OriginGrants.act is where every browser action is confirmed; the browser paths pass `sensitive` to it and
  // never drop it by reading the anchor themselves
  for (const file of ['hostTools.cjs', 'iabBackend/backend.cjs', 'iabBackend/handlers.cjs', 'extension.cjs', 'tools.cjs']) {
    const src = fs.readFileSync(new URL(`electron/capabilities/browser/${file}`, ROOT), 'utf8');
    assert.doesNotMatch(
      src,
      /anchor\w*\(\)?[^\n]{0,40}'full'[^\n]{0,80}sensitive\s*=/,
      `${file} decides Full access for a sensitive action itself`,
    );
  }
  const origins = fs.readFileSync(new URL('electron/capabilities/browser/origins.cjs', ROOT), 'utf8');
  assert.match(origins, /return confirmBrowserAction\(this, url, ctx, what\)/);
  const actions = fs.readFileSync(new URL('electron/capabilities/browser/originAction.cjs', ROOT), 'utf8');
  assert.match(actions, /anchor === 'full' && fullAccessCovers\(sensitive\)/);
});

// Found by the real-app edge-case suite (scenario `checkout`, IAB×Codex): the Codex Browser plugin clicked "Pay $49.00"
// in a card form inside a cross-origin checkout iframe in Full access, and no card asked: a click at a point on a
// cross-origin frame read as `{ frame: true }` in the top frame and the intent never looked inside that frame.
// Now the top frame names the frame (its owner's ref and the point inside it) and the intent follows it there; the
// siblings (focus, the plugin's frame sessions, same-process frames, Your Chrome) are CM-J09 to CM-J16.
test('CM-J08: a click at a point inside a cross-origin frame is judged by the element it hits there (a payment submit asks)', async (t) => {
  const { drive, flush, setup, tabOf } = await import('./support/browser-host-kit.ts');
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  tab.wc.debugger.event('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { type: 'iframe', targetId: 'frame-1' } });
  await flush();
  tab.wc.ownerFrames.ref_10 = 'frame-1';
  const answers: Record<string, any> = {
    '': { frame: true, owner: 'ref_10', x: 20, y: 30 },
    F1: { tag: 'button', name: 'Pay $49.00', button: true, submits: true, form: { payment: true, submit: 'Pay $49.00' } },
  };
  tab.wc.ops.intent = (_args: any, sid?: string) => answers[sid ?? ''];
  const intent = await drive(t, h.tabs.intent(tab, { point: { x: 120, y: 280 } }));
  assert.equal(sensitiveAction(intent, { kind: 'click' })?.kind, 'payment');
});
