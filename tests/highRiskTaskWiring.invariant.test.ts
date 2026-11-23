// Financial task consent is classified at the shared browser tool gate and Codex plugin gate, rechecked after a card, and fenced by each harness's existing call signal.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { checkout, harnesses, plugin } from './support/sensitive-frames-kit.ts';
import { acpSession } from './support/control-matrix-kit.ts';
import { drive } from './support/browser-host-kit.ts';

export const GUARDS = ['electron/', 'shared/'];
const require = createRequire(import.meta.url);
const { TurnTokens } = require('../electron/capabilities/contract/turnTokens.cjs');
const { turnLedger } = require('../electron/capabilities/turnEnd.cjs');
const { passiveInput } = require('../electron/capabilities/browser/iabBackend/policy.cjs');
const { taskCovers } = require('../electron/capabilities/browser/taskGrants.cjs');
const AMEX = 'https://www.travel.americanexpress.com/';
const ordinary = (name = 'Search hotels') => ({
  tag: 'button',
  role: 'button',
  name,
  button: true,
  editable: false,
  secret: false,
  payment: false,
  consent: null,
  submits: false,
  form: null,
});
const field = () => ({ ...ordinary('Destination'), tag: 'input', role: 'textbox', button: false, editable: true });

test('browser tools pass positive classification for Claude, Codex, switched chats and admitted ACP', async (t) => {
  const w = checkout(t);
  w.wc.url = AMEX;
  w.answers[''] = ordinary();
  const calls = await harnesses(w.w);
  const acp = await acpSession(w.w, { chatId: 'c' });
  calls.ACP = (name, args) => acp.call(name, args);
  for (const [name, call] of Object.entries(calls)) {
    w.cards.length = 0;
    await drive(t, call('browser_computer', { action: 'left_click', coordinate: [40, 50] }));
    assert.equal(w.cards.at(-1).task, true, name);
    w.answers[''] = ordinary('Confirm');
    await drive(t, call('browser_computer', { action: 'left_click', coordinate: [40, 50] }));
    assert.equal(w.cards.at(-1).task, false, name);
    w.answers[''] = field();
    await drive(t, call('browser_computer', { action: 'type', text: 'Taipei' }));
    assert.equal(w.cards.at(-1).task, true, name);
    await drive(t, call('browser_computer', { action: 'type', text: 'Taipei\n' }));
    assert.equal(w.cards.at(-1).task, false, name);
    w.answers[''] = ordinary();
  }
});

test('the Codex IAB and Chrome backends classify input and never cover scripts or uploads', async () => {
  for (const browser of ['iab', 'chrome']) {
    const p = plugin();
    (p.b as any).browser = browser;
    const tokens = new TurnTokens();
    p.b.turns = () => tokens;
    p.tab.url = AMEX;
    p.answers[''] = ordinary();
    await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 50 });
    assert.equal(p.cards.at(-1).task, true, browser);
    p.answers[''] = ordinary('Confirm');
    await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 50 });
    assert.equal(p.cards.at(-1).task, false, browser);
    await p.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 50 });
    assert.equal(p.cards.at(-1).task, false, browser + ' committing releases cannot borrow task consent');
    p.answers[''] = field();
    await p.cdp('Input.insertText', { text: 'Taipei' });
    assert.equal(p.cards.at(-1).task, true, browser);
    await p.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r' });
    assert.equal(p.cards.at(-1).task, false, browser);
    await p.cdp('Runtime.evaluate', { expression: 'document.forms[0].submit()' });
    assert.equal(p.cards.at(-1).task, false, browser);
    await p.cdp('DOM.setFileInputFiles', { files: ['/tmp/fixture.txt'] });
    assert.equal(p.cards.at(-1).task, false, browser);
    p.answers[''] = null;
    await p.cdp('Input.insertText', { text: 'Taipei' });
    assert.equal(p.cards.at(-1).task, false, browser);
  }
});

test('an ordinary control changed to Confirm while a card was open is refused before input', async (t) => {
  const w = checkout(t);
  w.wc.url = AMEX;
  w.answers[''] = ordinary();
  const calls = await harnesses(w.w);
  // The fixture's live OriginGrants callback is reached by each tool, without a window.
  const p = plugin();
  p.tab.url = AMEX;
  p.answers[''] = ordinary();
  p.b.grants().confirmAction = async () => {
    p.answers[''] = ordinary('Confirm');
    return 'task';
  };
  await assert.rejects(p.b.gateWrite(p.tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 }), { code: 'page_changed' });
  w.wc.ops.intent = () => (w.asked.length++ ? ordinary('Confirm') : ordinary());
  const result: any = await drive(t, calls['Claude Code']('browser_computer', { action: 'left_click', coordinate: [40, 50] }));
  assert.match(JSON.stringify(result), /control changed/i);
  assert.equal(w.clicks().length, 0);
});

test('the real shared page agent supplies the positive field proof consumed by both browser hosts', async () => {
  const { load, run, agent } = await import('./support/page-agent/fixture.ts');
  const $ = load('<input id="destination" aria-label="Destination"><button id="search">Search hotels</button>');
  const ref = agent.refFor($('destination')).ref;
  const intent = run('intent', { ref });
  assert.equal(taskCovers(intent, { kind: 'type', text: 'Taipei' }), true);
  const click = run('intent', { ref: agent.refFor($('search')).ref });
  assert.equal(taskCovers(click, { kind: 'click' }), true);
});

test('every tool harness supplies executor tokens before task consent, and a delayed turn cleanup cannot lend it forward', async (t) => {
  const w = checkout(t);
  w.wc.url = AMEX;
  w.answers[''] = ordinary();
  const calls = await harnesses(w.w);
  const acp = await acpSession(w.w, { chatId: 'c' });
  calls.ACP = (name, args) => acp.call(name, args);
  let asked = 0;
  w.grants.confirmAction = async () => {
    asked++;
    return 'task';
  };
  for (const [name, call] of Object.entries(calls)) {
    w.grants.forget('c');
    w.w.r.turns.retire('c');
    const click = () => drive(t, call('browser_computer', { action: 'left_click', coordinate: [40, 50] }));
    const before = asked;
    await click();
    await click();
    assert.equal(asked, before + 1, name + ' supplies a reusable executor token');
    let release: any;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const ledger = turnLedger({
      steps: [
        async () => {
          await wait;
          w.grants.turnEnded('c');
        },
      ],
      retire: (chat: string, thread: string | null) => w.w.r.turns.retireTurn(chat, thread),
      chatOf: () => 'c',
      running: () => false,
      tracked: () => true,
    });
    ledger.begin('c');
    const ending = ledger.end('c');
    ledger.begin('c');
    await click();
    assert.equal(asked, before + 2, name + ' cannot reuse consent while cleanup waits');
    release();
    await ending;
    await click();
    assert.equal(asked, before + 2, name + ' keeps the newer live scope after old cleanup');
  }
});

test('native IAB and Chrome executeCdp dispatch supplies the task token, including the next turn before old cleanup', async () => {
  for (const browser of ['iab', 'chrome']) {
    const p = plugin();
    (p.b as any).browser = browser;
    const tokens = new TurnTokens();
    p.b.turns = () => tokens;
    p.tab.url = AMEX;
    p.answers[''] = ordinary();
    let asked = 0;
    p.grants.confirmAction = async () => {
      asked++;
      return 'task';
    };
    const click = () => p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 50 });
    await click();
    await click();
    assert.equal(asked, 1, browser);
    await p.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 50 });
    assert.equal(asked, 1, browser + ' classifies the release against the same read ordinary control');
    await p.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 40, y: 50, deltaY: 100 });
    await p.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 50, buttons: 0 });
    assert.equal(asked, 1, browser + ' covers passive pointer input');
    tokens.retireTurn('c', 'thread-1');
    await click();
    assert.equal(asked, 2, browser);
    p.grants.turnEnded('c');
    await click();
    assert.equal(asked, 2, browser + ' preserves the live newer native scope');
  }
});

test('passive native pointer classification never covers a press, drag or another protocol method', () => {
  assert.equal(passiveInput('Input.dispatchKeyEvent', { type: 'mouseMoved' }), null);
  assert.equal(passiveInput('Input.dispatchMouseEvent', { type: 'mousePressed' }), null);
  assert.equal(passiveInput('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1 }), null);
  assert.deepEqual(passiveInput('Input.dispatchMouseEvent', { type: 'mouseMoved' }), { kind: 'hover' });
  assert.deepEqual(passiveInput('Input.dispatchMouseEvent', { type: 'mouseWheel' }), { kind: 'scroll' });
});
