// The control matrix (docs/control-plane/matrix.md), group J: the sensitive-action check sees the element an action
// really acts on in every frame. A click at a point, a click by ref, Enter and typing inside a cross-origin frame (its
// own process, or its parent's when it is the same site), through open shadow roots and same-origin frames, are judged
// by that element, so a payment submit in a checkout iframe asks once in Full access, as design D4 says (CM-J02), for
// Claude Code, Codex, a chat that switched harness, the Codex Browser plugin's iab backend, Your Chrome and MoPilot's own extension. A frame nothing can read fails closed. BrowserTabs, the page agent's intent, OriginGrants,
// siteRisk, the browser_* tools, IabBackend and the Your Chrome check are real; pages, CDP and Chrome are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeFiles } from '../scripts/source-tree.mjs';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { drive } from './support/browser-host-kit.ts';
import { PAY, CARD, SAVED, checkout, harnesses, plugin, yourChrome, SNAPSHOT_FOCUS_IN_FRAME } from './support/sensitive-frames-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { BrowserTabs } = require('../electron/capabilities/browser/host.cjs');
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const { pageAgent } = require('../electron/capabilities/browser/pageAgent.cjs');
const { ELEMENT_INTENT, FOCUS_INTENT, focusedInFrame } = require('../electron/capabilities/browser/chromeIntent.cjs');
const { UNREADABLE_FRAME, sensitiveAction, fullAccessCovers } = require('../electron/capabilities/browser/siteRisk.cjs');

/* ---------- cases ---------- */

test('CM-J09: a click at a point inside a cross-origin checkout frame is judged by the element it hits there: "Pay" asks once in Full access, for every harness', async (t) => {
  const { w, cards, asked, clicks } = checkout(t);
  const via = await harnesses(w);
  for (const [harness, call] of Object.entries(via)) {
    cards.length = 0;
    asked.length = 0;
    await drive(t, call('browser_computer', { action: 'left_click', coordinate: [120, 280] }));
    assert.equal(cards.length, 1, `${harness}: exactly one card`);
    assert.equal(cards[0].sensitive.verb, 'submit payment details', harness);
    assert.match(cards[0].summary, /Pay \$49\.00/, harness);
    // the frame under the point was asked at the point inside it
    assert.deepEqual(asked.slice(0, 2), [
      [{ x: 120, y: 280 }, ''],
      [{ x: 20, y: 30 }, 'F1'],
    ]);
  }
  assert.equal(clicks().length, 4, 'each click ran once the user said yes');
});

test("CM-J10: the Codex Browser plugin's mouse press in a cross-origin checkout frame asks once in Full access; a press sent to the frame's own session is read there; the release asks nothing", async () => {
  const p = plugin('full');
  await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 280, button: 'left', clickCount: 1 });
  await p.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 120, y: 280, button: 'left', clickCount: 1 });
  assert.deepEqual(
    p.cards.map((c: any) => c.sensitive?.verb),
    ['submit payment details'],
  );
  // read at the point, and again once the card was answered (a bot check may have appeared there meanwhile, CM-J32)
  const atPoint = [
    [{ x: 120, y: 280 }, ''],
    [{ x: 20, y: 30 }, 'F1'],
  ];
  assert.deepEqual(p.asked, [...atPoint, ...atPoint]);
  // input the plugin sends to the frame's own session uses that frame's coordinates
  p.asked.length = 0;
  await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 1 }, { sessionId: 'F1' });
  assert.deepEqual(p.asked, [
    [{ x: 5, y: 6 }, 'F1'],
    [{ x: 5, y: 6 }, 'F1'],
  ]);
  assert.equal(p.cards.length, 2);
  // Enter with the focus in the frame's card form asks too; a saved-card order in the frame is a purchase Full access runs
  p.answers[''] = { frame: true, owner: 'ref_10' };
  p.answers.F1 = CARD;
  await p.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r' });
  assert.equal(p.cards.at(-1).sensitive.verb, 'submit payment details');
  p.answers[''] = { frame: true, owner: 'ref_10', x: 1, y: 1 };
  p.answers.F1 = SAVED;
  const before = p.cards.length;
  await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 280, button: 'left', clickCount: 1 });
  assert.equal(p.cards.length, before, 'design D4: a purchase without payment details runs in Full access');
});

test("CM-J11: browser_* Enter and typing with the focus in a cross-origin frame (out of process, or in its parent's process) are judged by the focused field", async (t) => {
  const { w, cards, answers, asked, tab, wc } = checkout(t);
  const call = (await harnesses(w)).Codex;
  answers[''] = { frame: true, owner: 'ref_10' };
  answers.F1 = CARD;
  await drive(t, call('browser_computer', { action: 'key', text: 'Enter' }));
  assert.deepEqual([cards.length, cards[0].sensitive.verb], [1, 'submit payment details']);
  assert.deepEqual(asked.slice(0, 2), [
    [{}, ''],
    [{}, 'F1'],
  ]);
  await drive(t, call('browser_computer', { action: 'type', text: '4242' }));
  assert.equal(cards[1].sensitive.verb, 'enter payment details');
  // a same-site checkout frame on another origin shares the page's process: it is read in its own world
  answers[''] = { frame: true, owner: 'ref_30' };
  wc.ownerFrames.ref_30 = 'checkout-frame';
  answers['inproc:checkout-frame'] = CARD;
  await drive(t, call('browser_computer', { action: 'key', text: 'Enter' }));
  assert.equal(cards[2].sensitive.verb, 'submit payment details');
  assert.equal(tab.frames.size, 1, 'no session was invented for it');
  // Ask mode: still one card per action, never two
  const ask = checkout(t, 'ask');
  await drive(t, (await harnesses(ask.w))['Claude Code']('browser_computer', { action: 'left_click', coordinate: [120, 280] }));
  assert.equal(ask.cards.length, 1);
});

test('CM-J12: Your Chrome reads Enter with the focus in a cross-origin frame by the field Playwright marks active there; with none marked it asks', async () => {
  const card = { tag: 'input', editable: true, payment: true, name: 'Card number', form: PAY.form };
  const focusInFrame = (target: string) => (target ? (target === 'f1e2' ? card : null) : { frame: true });
  const r = await yourChrome('full', 'browser_press_key', { key: 'Enter' }, focusInFrame, SNAPSHOT_FOCUS_IN_FRAME);
  // read again after the card: a submit is rechecked whenever it asked (#3879)
  assert.deepEqual(r.evaluated, ['', 'f1e2', '', 'f1e2']);
  assert.deepEqual(
    r.cards.map((c: any) => c.sensitive?.verb),
    ['submit payment details'],
  );
  // nothing marked active in the frame (or the field can't be read): the frame is unknown, and it asks
  const blind = await yourChrome('full', 'browser_press_key', { key: 'Enter' }, focusInFrame, '- iframe [active] [ref=e3]:');
  assert.equal(blind.cards[0].sensitive.verb, 'act inside a frame MoPilot could not read');
  const gone = await yourChrome(
    'full',
    'browser_press_key',
    { key: 'Enter' },
    (target) => (target ? { none: true } : { frame: true }),
    SNAPSHOT_FOCUS_IN_FRAME,
  );
  assert.equal(gone.cards[0].sensitive.kind, 'unreadable_frame');
  assert.equal(focusedInFrame(''), null);
  assert.equal(focusedInFrame('- button "Go" [active]'), null, 'an active line without a ref');
  // a click on a frame's ref is read in that frame as before (Playwright's refs reach into frames)
  const click = await yourChrome('full', 'browser_click', { target: 'f1e3', element: 'Pay' }, () => PAY, SNAPSHOT_FOCUS_IN_FRAME);
  assert.deepEqual([click.evaluated, click.cards.length], [['f1e3', 'f1e3'], 1]);
});

test("CM-J13: Your Chrome's focus reader goes through open shadow roots and same-origin frames, and marks a cross-origin frame", () => {
  const win = new Window({ url: 'https://shop.test/' });
  const doc: any = win.document;
  doc.body.innerHTML = '<iframe id="same"></iframe><iframe id="cross"></iframe><span id="host"></span>';
  const read = () => new win.Function(`return (${FOCUS_INTENT})`)()();
  const same: any = doc.getElementById('same');
  same.contentDocument.body.innerHTML = '<form><input id="cc" name="cardnumber"><button>Pay</button></form>';
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => same });
  Object.defineProperty(same.contentDocument, 'activeElement', {
    configurable: true,
    get: () => same.contentDocument.getElementById('cc'),
  });
  assert.deepEqual([read().payment, read().form.payment], [true, true]);
  const cross: any = doc.getElementById('cross');
  Object.defineProperty(cross, 'contentDocument', {
    configurable: true,
    get: () => {
      throw new win.DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
    },
  });
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => cross });
  assert.equal(read().frame, true);
  Object.defineProperty(cross, 'contentDocument', { get: () => null });
  assert.equal(read().frame, true);
  const sr = doc.getElementById('host').attachShadow({ mode: 'open' });
  sr.innerHTML = '<input id="pin" type="password">';
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => doc.getElementById('host') });
  Object.defineProperty(sr, 'activeElement', { configurable: true, get: () => sr.getElementById('pin') });
  assert.equal(read().secret, true);
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => null });
  assert.equal(read().none, true);
  win.close();
});

test('CM-J14: a "Pay" button in a form whose card fields live in a payment provider\'s frame (Stripe, Braintree) asks in Full access, in both browsers; a frame of something else does not make a form a payment', () => {
  const html =
    '<form><iframe name="__privateStripeFrame5" title="Secure card payment input frame"></iframe><button id="pay" type="button">Pay $49.00</button></form>' +
    '<form><iframe id="braintree-hosted-field-number"></iframe><button id="order">Place order</button></form>' +
    '<form><iframe title="Video"></iframe><button id="buy" type="button">Buy now</button></form>' +
    '<form id="co"><iframe title="Secure card number input frame"></iframe></form><button id="outside" type="button" form="co">Pay now</button>' +
    '<section><div><iframe title="Secure card payment input frame"></iframe></div><div><button id="panel">Complete purchase</button></div></section>' +
    '<section><button id="plain">Buy it again</button></section>' +
    '<section><iframe title="Secure card payment input frame"></iframe><div><div><div><div><div><div><div><button id="deep">Buy</button></div></div></div></div></div></div></div></section>';
  // the in-app browser's page agent
  const win = new Window({ url: 'https://shop.test/' });
  const G: any = globalThis;
  const saved = { document: G.document, getComputedStyle: G.getComputedStyle };
  win.document.body.innerHTML = html;
  G.document = win.document;
  G.getComputedStyle = (el: any) => win.getComputedStyle(el);
  try {
    const agent = pageAgent();
    const iab = (id: string) => agent.call('intent', { ref: agent.refFor(win.document.getElementById(id)).ref }).value;
    // Your Chrome's reader
    const chrome = new win.Function(`return (${ELEMENT_INTENT})`)();
    for (const read of [iab, (id: string) => chrome(win.document.getElementById(id))]) {
      for (const [id, verb] of [
        ['pay', 'submit payment details'],
        ['order', 'submit payment details'],
        ['buy', 'make a purchase'],
        // tied to a card form by form=, or a formless Stripe Payment Element panel
        ['outside', 'submit payment details'],
        ['panel', 'submit payment details'],
        ['plain', 'make a purchase'],
        ['deep', 'make a purchase'],
      ]) {
        const s = sensitiveAction(read(id), { kind: 'click' });
        assert.equal(s.verb, verb, id);
        assert.equal(fullAccessCovers(s), verb === 'make a purchase', id);
      }
    }
  } finally {
    Object.assign(G, saved);
    win.close();
  }
});

test('CM-J15: a click, Enter or typing in a frame nothing can read asks in Full access; scrolling or a key that types nothing there does not', () => {
  for (const action of [{ kind: 'click' }, { kind: 'key', keys: 'Enter' }, { kind: 'type' }, { kind: 'fill' }]) {
    const s = sensitiveAction(UNREADABLE_FRAME, action);
    assert.equal(s?.kind, 'unreadable_frame', action.kind);
    assert.equal(fullAccessCovers(s), false);
  }
  assert.equal(sensitiveAction(UNREADABLE_FRAME, { kind: 'key', keys: 'ArrowDown' }), null);
  assert.equal(sensitiveAction(UNREADABLE_FRAME, { kind: 'drag' }), null);
  // a frame marker that is not unreadable judges nothing by itself (main follows it first)
  assert.equal(sensitiveAction({ frame: true, owner: 'ref_1' }, { kind: 'click' }), null);
});

test('CM-J16: guard: every executor judges an action by one frame-following reader', () => {
  const read = (f: string) => fs.readFileSync(new URL(`../electron/capabilities/browser/${f}`, import.meta.url), 'utf8');
  // only hostPage.cjs asks a page agent for an intent; the tools, the plugin backend and the extension host go through it
  const dir = fileURLToPath(new URL('../electron/capabilities/browser/', import.meta.url));
  for (const file of treeFiles(dir, /\.cjs$/, { skip: (p) => p === path.join(dir, 'hostPage.cjs') })) {
    const f = path.relative(dir, file);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /agent\(\s*'intent'/, `${f} reads an intent without following frames`);
  }
  assert.match(read('hostPage.cjs'), /place = await tab\.childFrame\(place, r\.owner\)/);
  // MoPilot's extension and the relay drive Chrome tabs through the same BrowserTabs.intent
  const chrome = chromeBrowserTabs({ relay: { on() {}, off() {} }, images: {}, modelOf: () => '', onChange() {} });
  assert.equal(chrome.intent, BrowserTabs.prototype.intent);
  // the page agent never answers a bare frame marker: it names the frame for main to follow
  assert.doesNotMatch(read('pageAgent.cjs'), /return \{ frame: true \};/);
  // Your Chrome's reader follows the focus into a frame
  assert.match(read('chromeIntent.cjs'), /focusedInFrame\(snapshotText\)/);
  // the plugin's raw key events are named by one reader (Enter's keypress and the space bar too, #1384), never by hand
  // browser_script's steps go through the same action gate as browser_computer
  assert.match(
    read('hostTools.cjs'),
    /act: async \(tab, action\) => \{\s+const asked = await explained\(actionGate\(tab, asking, action\)(?:, refused)?\)/,
  );
  const backend = read('iabBackend/backend.cjs');
  assert.match(backend, /const key = keyPressed\(method, p\)/);
  assert.doesNotMatch(backend, /p\.key === 'Enter'|p\.text === '\\r'/);
});
