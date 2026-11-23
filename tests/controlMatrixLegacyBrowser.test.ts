// The control matrix (docs/control-plane/matrix.md), one no-go list on every browser path: the older built-in
// sage_browser_click and sage_browser_type (served while the browser_* switch is off) read what they act on and get
// browser_*'s checks, so a password field refuses typing and a sensitive action asks by the same rule, Full access
// included where browser_* ask. Case ids (CM-J..) start every title. PanelBrowser, the legacy tools, OriginGrants,
// siteRisk and the Registry are real; the page's debugger is a fake that answers with what the element is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/'];

const require = createRequire(import.meta.url);
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');
const { panelBrowserTools } = require('../electron/capabilities/browser/tools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { browserWorld } = require('./helpers/browser.cjs');

const SITE = 'https://shop.test/account';

/** What the page agent's facts say the element is (chromeIntent.cjs INTENT_OF), or how reading it goes. */
type Element = Record<string, unknown> | 'none' | 'unreadable';

/** A chat with the legacy tools on one built-in browser tab at SITE, in `anchor`, whose target element is `el`. */
function rig(anchor: string, el: Element) {
  const w = browserWorld();
  w.root.url = SITE;
  const sent: string[] = [];
  w.root.command = (method: string) => {
    sent.push(method);
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 2 };
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
    if (method === 'DOM.resolveNode') {
      if (el === 'unreadable') throw new Error('Cannot find context with specified id');
      return { object: { objectId: 'o1' } };
    }
    if (method === 'Runtime.callFunctionOn')
      return { result: { value: el === 'none' ? { mopilot_intent: true, none: true } : { mopilot_intent: true, ...(el as object) } } };
    return {};
  };
  const panel = new PanelBrowser({ ...w, open: () => false });
  panel.attach('chat', w.root, w.host);
  const confirmed: any[] = [];
  const grants = new OriginGrants({
    browser: 'iab',
    anchor: () => anchor,
    ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async (req: any) => (confirmed.push(req), true),
  });
  grants.set('https://shop.test', 'write');
  const r = new Registry();
  for (const t of panelBrowserTools({ panel, grants })) r.register(t);
  const call = (tool: string, args: any) => r.invoke('chat', 'seg', tool, args);
  const acted = () => sent.filter((m) => m === 'Input.dispatchMouseEvent' || m === 'Input.insertText').length;
  return { call, confirmed, acted, sent, panel };
}

const DELETE = { tag: 'button', type: '', role: 'button', name: 'Delete account', button: true, submits: false, editable: false };
const PASSWORD = { tag: 'input', type: 'password', role: '', name: 'Password', editable: true, secret: true, payment: false };
const CARD = { tag: 'input', type: 'text', role: '', name: 'Card number', editable: true, secret: false, payment: true };
const PLAIN = { tag: 'button', type: '', role: 'button', name: 'Show more', button: true, submits: false, editable: false };

test('CM-J20: the older built-in sage_browser_click asks before a delete in Ask and runs it in Full access, as browser_* do', async () => {
  const ask = rig('ask', DELETE);
  const r = await ask.call('sage_browser_click', { selector: '#del' });
  assert.equal(r.ok, true);
  assert.deepEqual(
    ask.confirmed.map((c) => c.sensitive?.kind),
    ['delete'],
  );
  assert.match(ask.confirmed[0].summary, /click #del/);
  assert.ok(ask.acted() > 0, 'the approved click ran');
  const full = rig('full', DELETE);
  assert.equal((await full.call('sage_browser_click', { selector: '#del' })).ok, true);
  assert.equal(full.confirmed.length, 0);
  // an ordinary button asks nobody in Ask either
  const plain = rig('ask', PLAIN);
  assert.equal((await plain.call('sage_browser_click', { selector: '#more' })).ok, true);
  assert.equal(plain.confirmed.length, 0);
  // nothing at the target: nothing sensitive
  const none = rig('ask', 'none');
  assert.equal((await none.call('sage_browser_click', { selector: '#x' })).ok, true);
  assert.equal(none.confirmed.length, 0);
});

test('CM-J21: sage_browser_type never types into a password field, and entering card details asks in Full access too', async () => {
  const pw = rig('full', PASSWORD);
  const r = await pw.call('sage_browser_type', { selector: '#pw', text: 'hunter2' });
  assert.equal(r.error.code, 'password_field');
  assert.equal(pw.acted(), 0, 'nothing was typed');
  const card = rig('full', CARD);
  assert.equal((await card.call('sage_browser_type', { selector: '#cc', text: '4242', submit: true })).ok, true);
  assert.deepEqual(
    card.confirmed.map((c) => c.sensitive?.kind),
    ['payment_entry'],
  );
  // Enter in a field whose form sends a password change asks for that (the key, after the typing)
  const form = {
    ...PLAIN,
    tag: 'input',
    type: 'text',
    editable: true,
    button: false,
    form: { secrets: 2, newPassword: true, payment: false, submit: 'Save' },
  };
  const change = rig('full', form);
  assert.equal((await change.call('sage_browser_type', { selector: '#f', text: 'x', submit: true })).ok, true);
  assert.equal(change.confirmed.length, 1);
  assert.match(change.confirmed[0].summary, /and press Enter/);
});

test('CM-J22: a page the older tools can’t read is unknown, so a click asks, in Full access too', async () => {
  // read for the chat's selected tab when no tab is passed
  assert.equal((await rig('ask', DELETE).panel.intent('chat', { selector: '#del' })).name, 'Delete account');
  const t = rig('full', 'unreadable');
  assert.equal((await t.call('sage_browser_click', { selector: '#del' })).ok, true);
  assert.deepEqual(
    t.confirmed.map((c) => c.sensitive?.kind),
    ['unreadable_frame'],
  );
  // an answer that isn't the page agent's facts reads as unknown too
  const odd = rig('full', { mopilot_intent: false });
  assert.equal((await odd.call('sage_browser_click', { selector: '#del' })).ok, true);
  assert.deepEqual(
    odd.confirmed.map((c) => c.sensitive?.kind),
    ['unreadable_frame'],
  );
});
