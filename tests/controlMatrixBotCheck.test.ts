// The control matrix (docs/control-plane/matrix.md), group J: a bot check or CAPTCHA is the user's to complete (#1615,
// edge case E-S4b). A click, key, typing, check or drag an agent aims at a recognized one is refused before anything
// reaches the page and before any card, with the route's hand-off, on every executor: browser_* for Claude Code,
// Codex, a chat that switched harness and an ACP session (browser_computer and browser_script), the Codex Browser
// plugin's iab and Chrome backends (a native thread's cua.* clicks arrive there as CDP input), Your Chrome and the
// older sage_browser_* tools. An ordinary checkbox runs as before. BrowserTabs and its frame walk, the browser tools,
// IabBackend, the Your Chrome check, PanelBrowser, OriginGrants and the Registry are real; pages, CDP and Chrome are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drive } from './support/browser-host-kit.ts';
import { acpSession } from './support/control-matrix-kit.ts';
import { CARD, PAY, checkout, grantsIn, harnesses, plugin, yourChrome } from './support/sensitive-frames-kit.ts';
import { answers, tool } from './support/browser-script/fixture.ts';

export const GUARDS = ['electron/capabilities/', 'electron/harness/', 'electron/platform/', 'electron/session/', 'shared/'];

const require = createRequire(import.meta.url);
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { panelBrowserTools } = require('../electron/capabilities/browser/tools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { browserWorld } = require('./helpers/browser.cjs');

/** The edge suite's "I'm not a robot" checkbox, as the page agent reports it (botCheck.cjs). */
const ROBOT = { tag: 'input', type: 'checkbox', role: '', name: "I'm not a robot", button: false, editable: false, botCheck: true };
/** An ordinary consent checkbox. */
const AGREE = { tag: 'input', type: 'checkbox', role: '', name: 'I agree to the terms', button: false, editable: false };

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text ?? '').join('\n');

/** The checkout kit's tab with the bot check at the top of the page, and every harness that drives it. */
async function botPage(t: any, anchor = 'full') {
  const k = checkout(t, anchor);
  k.answers[''] = ROBOT;
  const via = await harnesses(k.w);
  const acp = await acpSession(k.w, { chatId: 'c' });
  via.ACP = (name: string, args: any) => acp.call(name, args);
  return { ...k, via };
}

test('CM-J25: a click, key or typing on an "I\'m not a robot" checkbox is refused with browser_request_signin for Claude Code, Codex, a chat that switched and ACP; nothing reaches the page and no card shows', async (t) => {
  const { via, cards, clicks, wc } = await botPage(t);
  const keys = () => wc.debugger.calls.filter((c: any) => /^Input\.(dispatchKeyEvent|insertText)$/.test(c.method));
  for (const [harness, call] of Object.entries(via))
    for (const args of [
      { action: 'left_click', coordinate: [40, 60] },
      { action: 'double_click', coordinate: [40, 60] },
      { action: 'key', text: 'space' },
      { action: 'type', text: 'x' },
      { action: 'left_click_drag', start_coordinate: [40, 60], coordinate: [300, 60] },
    ]) {
      const r = await drive(t, call('browser_computer', args));
      assert.equal(r.isError, true, `${harness} ${args.action}`);
      assert.match(text(r), /"I'm not a robot" is part of a bot check/, `${harness} ${args.action}`);
      assert.match(text(r), /<refusal reason="bot_check" retryable="false">\nnext: Call (?:browser_)?request_signin/, harness);
    }
  assert.deepEqual([clicks().length, keys().length, cards.length], [0, 0, 0]);
  // in Ask mode too: refused, never a card that could be allowed
  const ask = await botPage(t, 'ask');
  const r = await drive(t, ask.via.Codex('browser_computer', { action: 'left_click', coordinate: [40, 60] }));
  assert.deepEqual([r.isError, ask.cards.length, ask.clicks().length], [true, 0, 0]);
});

test("CM-J26: a click into a provider's cross-origin frame (reCAPTCHA, hCaptcha, Turnstile) is refused whether the frame reads as a bot check, as an ordinary control, or not at all", async (t) => {
  const { via, answers, cards, clicks, tab } = await botPage(t);
  answers[''] = { frame: true, owner: 'ref_10', x: 20, y: 30, botCheck: true };
  for (const inner of [ROBOT, { tag: 'span', name: '', role: '', button: false }, null]) {
    answers.F1 = inner;
    const r = await drive(t, via['Claude Code']('browser_computer', { action: 'left_click', coordinate: [120, 280] }));
    assert.match(text(r), /reason="bot_check"/, JSON.stringify(inner));
  }
  // the frame went away before it could be read: still the provider's, still refused
  tab.frames.clear();
  answers[''] = { frame: true, owner: 'ref_10', x: 20, y: 30, botCheck: true };
  const t2 = await drive(t, via.Codex('browser_computer', { action: 'left_click', coordinate: [120, 280] }));
  assert.match(text(t2), /reason="bot_check"/);
  // a frame marker without an owner (nothing to follow) inside the provider's frame is refused too
  answers[''] = { frame: true, botCheck: true };
  const t3 = await drive(t, via.ACP('browser_computer', { action: 'left_click', coordinate: [120, 280] }));
  assert.match(text(t3), /reason="bot_check"/);
  assert.deepEqual([clicks().length, cards.length], [0, 0]);
});

test('CM-J27: browser_script refuses a cua click, cua drag, space bar and locator check on a bot check through the same gate, and nothing reaches the page', async () => {
  const t = tool((w) => {
    w.send({ t: 'call', id: 1, op: 'cua.click', args: { tab: 't1', x: 40, y: 60 } });
    w.send({
      t: 'call',
      id: 2,
      op: 'cua.drag',
      args: {
        tab: 't1',
        path: [
          { x: 40, y: 60 },
          { x: 300, y: 60 },
        ],
      },
    });
    w.send({ t: 'call', id: 3, op: 'cua.keys', args: { tab: 't1', keys: 'Space' } });
    w.send({ t: 'call', id: 4, op: 'loc.act', args: { tab: 't1', steps: [], desc: 'the checkbox', action: 'check', value: true } });
    setTimeout(() => w.send({ t: 'done', ok: true, value: '1', undef: false }), 20);
  });
  t.tabs.intentValue = ROBOT;
  t.tabs.st = { visible: true, enabled: true, editable: false, checked: false, tag: 'input', type: 'checkbox' };
  await t.call({ code: 'x' });
  const posted = answers(t.worker()).sort((a: any, b: any) => a.id - b.id);
  assert.deepEqual(
    posted.map((a: any) => [a.id, a.error?.code]),
    [
      [1, 'bot_check'],
      [2, 'bot_check'],
      [3, 'bot_check'],
      [4, 'bot_check'],
    ],
  );
  assert.match(posted[0].error.message, /Call browser_request_signin/);
  for (const op of ['click', 'drag', 'keys', 'formInput']) assert.equal(t.tabs.called(op).length, 0, op);
  // the locator check and the drag read the element they act on: the checkbox's ref, the drag's start point
  const read = t.tabs.called('intent').map((c: any) => c[1]);
  assert.deepEqual(read.at(1), { point: { x: 40, y: 60 } });
  assert.ok(read.some((target: any) => typeof target?.ref === 'string'));
});

test("CM-J28: the Codex Browser plugin's mouse press (a native thread's cua click or drag), key and typing on a bot check are refused naming the in-app browser; its Chrome backend names the user's Chrome", async () => {
  const p = plugin('full');
  p.answers[''] = ROBOT;
  const refused = async (method: string, params: any) => {
    const e = await p.cdp(method, params).then(
      () => null,
      (err: any) => err,
    );
    assert.equal(e?.code, 'bot_check', method);
    return e;
  };
  const press = await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 60, button: 'left', clickCount: 1 });
  assert.match(press.message, /in the browser pane/);
  assert.match(press.message, /<refusal reason="bot_check" retryable="false" browser="iab">/);
  await refused('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', text: ' ' });
  await refused('Input.insertText', { text: 'x' });
  await refused('Runtime.callFunctionOn', { functionDeclaration: 'function () { this.click(); }', userGesture: true });
  assert.equal(p.cards.length, 0);
  assert.equal(p.sent.filter(([m]: any) => m.startsWith('Input.')).length, 0, 'nothing was sent to the page');
  // a mouse move or release on it reads nothing and asks nothing
  await p.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 60 });
  // MoPilot's Chrome backend for the same thread names the user's Chrome
  p.b.browser = 'chrome';
  const chrome = await refused('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 60, button: 'left', clickCount: 1 });
  assert.match(chrome.message, /in their Chrome/);
  assert.match(chrome.message, /browser="chrome"/);
});

test("CM-J29: Your Chrome's browser_click, browser_type and browser_press_key on a bot check are refused naming the user's Chrome, before any card", async () => {
  const snap = '- checkbox "I\'m not a robot" [ref=e2]';
  for (const [name, args] of [
    ['browser_click', { target: 'e2', element: "I'm not a robot" }],
    ['browser_type', { target: 'e2', text: 'x' }],
    ['browser_press_key', { key: ' ' }],
  ] as const) {
    const e = await yourChrome('full', name, args, () => ROBOT, snap).then(
      () => null,
      (err: any) => err,
    );
    assert.equal(e?.code, 'bot_check', name);
    assert.match(e.message, /complete the check themselves in their Chrome/);
  }
  // an ordinary checkbox runs without a card in Full access
  const ok = await yourChrome('full', 'browser_click', { target: 'e3', element: 'I agree' }, () => AGREE, snap);
  assert.equal(ok.cards.length, 0);
});

test("CM-J29b: browser_* driving the user's Chrome (the Your Chrome channel) refuse a bot check with the Chrome hand-off, since browser_request_signin can't reach it", async (t) => {
  const k = checkout(t);
  k.answers[''] = ROBOT;
  const tools = createBrowserTools({ tabs: k.h.tabs, grants: grantsIn('full').g, chromeRoute: () => "the user's Chrome" });
  const computer = tools.find((x: any) => x.name === 'browser_computer');
  const e = await drive(t, computer.handler({ action: 'left_click', coordinate: [40, 60] }, { chatId: 'c', segmentId: 's' })).then(
    () => null,
    (err: any) => err,
  );
  assert.equal(e?.code, 'bot_check');
  assert.match(e.message, /complete the check themselves in their Chrome/);
  // the chrome_* tools run the same browser_* gate over Chrome's own site table: the Chrome hand-off too
  const chromeTools = createBrowserTools({ tabs: k.h.tabs, grants: grantsIn('full', 'chrome').g });
  const viaChrome = await drive(
    t,
    chromeTools
      .find((x: any) => x.name === 'browser_computer')
      .handler({ action: 'left_click', coordinate: [40, 60] }, { chatId: 'c', segmentId: 's' }),
  ).then(
    () => null,
    (err: any) => err,
  );
  assert.match(viaChrome?.message, /complete the check themselves in their Chrome/);
  // and it names the user's Chrome, so the chat's strips act there and show the Chrome hand-off (#1639)
  assert.match(viaChrome?.message, /<refusal reason="bot_check" retryable="false" browser="chrome">/);
  assert.doesNotMatch(e.message, /browser="chrome"/, 'the Your Chrome channel keeps its own refusal shape');
  assert.equal(k.clicks().length, 0);
  // a password field in the user's Chrome: no sign-in tool reaches it, so the user signs in there (#1639, #1584's class)
  k.answers[''] = { tag: 'input', type: 'password', name: 'Password', editable: true, secret: true };
  for (const [via, browser] of [
    [chromeTools, ' browser="chrome"'],
    [tools, ''],
  ] as const) {
    const typed = await drive(
      t,
      via.find((x: any) => x.name === 'browser_computer').handler({ action: 'type', text: 'hunter2' }, { chatId: 'c', segmentId: 's' }),
    ).then(
      () => null,
      (err: any) => err,
    );
    assert.equal(typed?.code, 'password_field');
    assert.match(
      typed.message,
      /agents never type passwords\. Ask the user in chat to sign in themselves in their Chrome, then continue\./,
    );
    assert.doesNotMatch(typed.message, /browser_request_signin|browser_request_credentials/);
    assert.match(typed.message, new RegExp(`<refusal reason="password_field" retryable="false"${browser}>`));
  }
});

test('CM-J32: a bot check that appears under the target while a card is open is refused after the user allows the card, on browser_* and the Codex Browser plugin', async (t) => {
  // browser_*: "Pay" asks in Full access; while the card is open the page swaps a human check in at that point
  const k = checkout(t);
  let reads = 0;
  k.wc.ops.intent = () => (reads++ === 0 ? PAY : ROBOT);
  const r = await drive(t, (await harnesses(k.w)).Codex('browser_computer', { action: 'left_click', coordinate: [40, 60] }));
  assert.equal(k.cards.length, 1, 'the card for the payment was shown');
  assert.match(text(r), /reason="bot_check"/);
  assert.equal(k.clicks().length, 0);
  // typing after a card is read again too: a password field there still refuses as before
  reads = 0;
  k.wc.ops.intent = () => (reads++ === 0 ? CARD : { tag: 'input', type: 'password', name: 'Password', editable: true, secret: true });
  const typed = await drive(t, (await harnesses(k.w)).Codex('browser_computer', { action: 'type', text: '4242' }));
  assert.match(text(typed), /The focus moved to a password field/);
  // the plugin's press: the card for "Pay", then the bot check now under the point
  const p = plugin('full');
  let pReads = 0;
  p.tab.agent = async (op: string) => (op !== 'intent' ? { count: 0 } : pReads++ === 0 ? PAY : ROBOT);
  const e = await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 60, button: 'left', clickCount: 1 }).then(
    () => null,
    (err: any) => err,
  );
  assert.equal(p.cards.length, 1);
  assert.equal(e?.code, 'bot_check');
  // a key after a card is read at the focus
  pReads = 0;
  p.tab.agent = async (op: string) => (op !== 'intent' ? { count: 0 } : pReads++ === 0 ? PAY : ROBOT);
  const key = await p.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r' }).then(
    () => null,
    (err: any) => err,
  );
  assert.equal(key?.code, 'bot_check');
});

test("CM-J33: Your Chrome's key press with the focus in a CAPTCHA provider's frame is refused even when nothing inside the frame can be read", async () => {
  const snap = '- iframe [active] [ref=e3]:';
  for (const inner of [null, { tag: 'span', name: '' }]) {
    const e = await yourChrome(
      'full',
      'browser_press_key',
      { key: ' ' },
      (target) => (target ? inner : { frame: true, botCheck: true }),
      inner ? `${snap}\n    - checkbox [active] [ref=f1e2]` : snap,
    ).then(
      () => null,
      (err: any) => err,
    );
    assert.equal(e?.code, 'bot_check', JSON.stringify(inner));
  }
});

test('CM-J30: the older sage_browser_click and sage_browser_type refuse a bot check (no hand-off tool there: the user is asked in chat); an ordinary checkbox is clicked', async () => {
  const rig = (el: Record<string, unknown>) => {
    const w = browserWorld();
    w.root.url = 'https://shop.test/';
    const sent: string[] = [];
    w.root.command = (method: string) => {
      sent.push(method);
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 2 };
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'o1' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { mopilot_intent: true, ...el } } };
      return {};
    };
    const panel = new PanelBrowser({ ...w, open: () => false });
    panel.attach('chat', w.root, w.host);
    const grants = new OriginGrants({
      browser: 'iab',
      anchor: () => 'full',
      ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
      confirmAction: async () => true,
    });
    grants.set('https://shop.test', 'write');
    const r = new Registry();
    for (const tool of panelBrowserTools({ panel, grants })) r.register(tool);
    const acted = () => sent.filter((m) => m === 'Input.dispatchMouseEvent' || m === 'Input.insertText').length;
    return { call: (tool: string, args: any) => r.invoke('chat', 'seg', tool, args), acted };
  };
  const bot = rig(ROBOT);
  for (const [tool, args] of [
    ['sage_browser_click', { selector: '#human' }],
    ['sage_browser_type', { selector: '#human', text: 'x' }],
  ] as const) {
    const r = await bot.call(tool, args);
    assert.equal(r.ok, false, tool);
    assert.equal(r.error.code, 'bot_check');
    assert.match(r.error.message, /complete the check themselves in the browser/);
  }
  assert.equal(bot.acted(), 0);
  const agree = rig(AGREE);
  assert.equal((await agree.call('sage_browser_click', { selector: '#agree' })).ok, true);
  assert.ok(agree.acted() > 0);
});

test('CM-J31: an ordinary "I agree" checkbox is clicked as before on every harness, with no card in Full access', async (t) => {
  const { via, answers, cards, clicks } = await botPage(t);
  answers[''] = AGREE;
  for (const [harness, call] of Object.entries(via)) {
    const r = await drive(t, call('browser_computer', { action: 'left_click', coordinate: [40, 60] }));
    assert.notEqual(r.isError, true, harness);
  }
  assert.deepEqual([clicks().length, cards.length], [Object.keys(via).length, 0]);
});
