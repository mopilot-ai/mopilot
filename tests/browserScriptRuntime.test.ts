// The API a browser_script sees (electron/capabilities/browser/scriptRuntime.cjs), run in this process
// with a fake channel to the main process: locator building and selector parsing, every call it sends,
// how answers and failures come back, the value and log formatting, the last-expression rewrite, the
// worker entry (with a real node:vm context) and the realm hardening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scriptRuntime, persist, withReturn, workerMain, hardenRealm } = require('../electron/capabilities/browser/scriptRuntime.cjs');

test('runtime facade preserves helper identities and transformations run in an isolated realm', async () => {
  const transforms = require('../electron/capabilities/browser/scriptTransform.cjs');
  const workerEntry = require('../electron/capabilities/browser/scriptWorker.cjs');
  assert.equal(persist, transforms.persist);
  assert.equal(withReturn, transforms.withReturn);
  assert.equal(workerMain, workerEntry.workerMain);
  assert.equal(hardenRealm, workerEntry.hardenRealm);
  const ctx = vm.createContext({ compiler: vm });
  const transform = vm.runInContext(`(${withReturn})(compiler, (${persist})('const total = 40;\\ntotal + 2'))`, ctx);
  assert.equal(await vm.runInContext(`(async () => {\n${transform}\n})()`, ctx), 42);
  assert.equal(vm.runInContext('total', ctx), 40);
});

type Handler = (op: string, args: any) => any;

/** The runtime over a fake main process: `handler` answers each call (a throw is a failure reply). */
function harness(handler: Handler = () => null, init: any = { current: null, platform: 'linux', doc: 'DOC' }) {
  const sent: any[] = [];
  const calls: any[] = [];
  let rt: any;
  const post = (json: string) => {
    const m = JSON.parse(json);
    sent.push(m);
    if (m.t !== 'call') return;
    calls.push([m.op, m.args]);
    setImmediate(async () => {
      try {
        const value = await handler(m.op, m.args);
        rt.receive(JSON.stringify({ id: m.id, ok: true, value: value ?? null }));
      } catch (e: any) {
        rt.receive(JSON.stringify({ id: m.id, ok: false, error: { message: e.message, code: e.code ?? 'failed' } }));
      }
    });
  };
  rt = scriptRuntime(post, init);
  const g = rt.globals;
  return { rt, g, sent, calls, tab: g.tab, pw: g.tab.playwright, last: () => calls[calls.length - 1] };
}
/** A harness whose current tab is t1 (no binding call). */
const bound = (handler?: Handler, platform = 'linux') => harness(handler, { current: 't1', platform, doc: 'DOC' });
const stepsOf = (l: any) => l._steps;

test('show: JSON where possible, named functions, bigints, RegExps, errors, maps, sets and cycles; never throws', () => {
  const { rt } = harness();
  const show = rt.show;
  assert.equal(
    show(function named() {}),
    '[Function named]',
  );
  assert.equal(
    show(() => {}),
    '[Function anonymous]',
  );
  assert.equal(show(5n), '5n');
  assert.equal(show(undefined), 'undefined');
  assert.equal(show(Symbol('s')), 'Symbol(s)');
  const cyc: any = { a: 1 };
  cyc.self = cyc;
  assert.equal(
    show({
      n: 2n,
      f: function g() {},
      anon: Object.assign(() => {}, {}),
      re: /x/i,
      e: new TypeError('bad'),
      m: new Map([[1, 'a']]),
      s: new Set([1]),
      cyc,
      u: undefined,
      nil: null,
    }),
    '{"n":"2n","f":"[Function g]","anon":"[Function anonymous]","re":"/x/i","e":{"name":"TypeError","message":"bad"},"m":{"Map":[[1,"a"]]},"s":{"Set":[1]},"cyc":{"a":1,"self":"[Circular]"},"nil":null}',
  );
  assert.equal(show([1, 2], 2), '[\n  1,\n  2\n]');
  assert.equal(
    show({
      toJSON() {
        throw new Error('nope');
      },
    }),
    '[unserializable: nope]',
  );
  assert.equal(
    show({
      toJSON() {
        throw 'x';
      },
    }),
    '[unserializable: undefined]',
  );
  const anonFn = [function () {}];
  assert.equal(show(anonFn), '["[Function anonymous]"]');
});

test('console posts each level as one line; sleep asks the main process', async () => {
  const { g, sent, calls } = harness();
  g.console.log('a', { b: 1 }, 2);
  g.console.warn('w');
  g.console.error('e');
  g.console.info('i');
  g.console.debug('d');
  assert.deepEqual(
    sent.map((m) => [m.level, m.text]),
    [
      ['log', 'a {"b":1} 2'],
      ['warn', 'w'],
      ['error', 'e'],
      ['info', 'i'],
      ['debug', 'd'],
    ],
  );
  assert.equal(await g.sleep(25), undefined);
  await g.sleep('soon');
  assert.deepEqual(calls, [
    ['sleep', { ms: 25 }],
    ['sleep', { ms: 0 }],
  ]);
});

test('answers: unknown ids are ignored; failures are BrowserError or TimeoutError with the code and the calling stack', async () => {
  const { rt, g } = bound((op) => {
    if (op === 'tab.title') throw Object.assign(new Error('Not allowed'), { code: 'denied' });
    throw Object.assign(new Error('Too slow'), { code: 'timeout' });
  });
  rt.receive(JSON.stringify({ id: 999, ok: true, value: 1 }));
  const e = await g.tab.title().catch((x: any) => x);
  assert.deepEqual([e.name, e.message, e.code], ['BrowserError', 'Not allowed', 'denied']);
  assert.match(e.site, /browserScriptRuntime\.test\.ts/);
  const t = await g.tab.url().catch((x: any) => x);
  assert.deepEqual([t.name, t.code], ['TimeoutError', 'timeout']);
});

test("the default tab binds to the chat's current tab on first use; a known tab id is used as is", async () => {
  const h = harness((op) => (op === 'tab.resolve' ? { id: 'tab_9' } : op === 'tab.title' ? 'T' : null));
  assert.equal(h.tab.id, null);
  assert.equal(JSON.stringify(h.tab), '"Tab (current)"');
  assert.equal(await h.tab.title(), 'T');
  assert.equal(await h.tab.title(), 'T');
  assert.deepEqual(h.calls, [
    ['tab.resolve', {}],
    ['tab.title', { tab: 'tab_9' }],
    ['tab.title', { tab: 'tab_9' }],
  ]);
  assert.equal(h.tab.id, 'tab_9');
  assert.equal(JSON.stringify(h.tab), '"Tab tab_9"');
  const b = bound();
  await b.tab.reload();
  assert.deepEqual(b.calls, [['tab.reload', { tab: 't1' }]]);
});

test('selectors: CSS by default, XPath by its prefix, engines, >> chains outside quotes, and clear errors', () => {
  const { pw } = bound();
  const s = (sel: string) => stepsOf(pw.locator(sel));
  assert.deepEqual(s('button.primary'), [{ k: 'css', s: 'button.primary' }]);
  assert.deepEqual(s('//div'), [{ k: 'xpath', s: '//div' }]);
  assert.deepEqual(s('..'), [{ k: 'xpath', s: '..' }]);
  assert.deepEqual(s('css=a >> xpath=b'), [
    { k: 'css', s: 'a' },
    { k: 'xpath', s: 'b' },
  ]);
  assert.deepEqual(s('text="Save"'), [{ k: 'text', m: { s: 'Save', exact: true } }]);
  assert.deepEqual(s("text='Save'"), [{ k: 'text', m: { s: 'Save', exact: true } }]);
  assert.deepEqual(s('text=/sa.e/i'), [{ k: 'text', m: { re: 'sa.e', flags: 'i' } }]);
  assert.deepEqual(s('text=Save'), [{ k: 'text', m: { s: 'Save', exact: false } }]);
  assert.deepEqual(s('id=main'), [{ k: 'css', s: '[id="main"]' }]);
  assert.deepEqual(s('data-testid="go"'), [{ k: 'attr', name: 'data-testid', m: { s: 'go', exact: true } }]);
  assert.deepEqual(s('data-testid=go'), [{ k: 'attr', name: 'data-testid', m: { s: 'go', exact: true } }]);
  assert.deepEqual(s('li >> nth=-1'), [
    { k: 'css', s: 'li' },
    { k: 'nth', i: -1 },
  ]);
  assert.deepEqual(s('li >> visible=true >> visible=false'), [
    { k: 'css', s: 'li' },
    { k: 'visible', v: true },
    { k: 'visible', v: false },
  ]);
  assert.deepEqual(s('aria-ref=ref_4'), [{ k: 'ref', ref: 'ref_4' }]);
  assert.deepEqual(s('ref=ref_5'), [{ k: 'ref', ref: 'ref_5' }]);
  assert.deepEqual(s('div:has-text("a >> b") >> span'), [
    { k: 'css', s: 'div:has-text("a >> b")' },
    { k: 'css', s: 'span' },
  ]);
  assert.deepEqual(s("a[title='x>>y']"), [{ k: 'css', s: "a[title='x>>y']" }]);
  assert.throws(() => pw.locator(''), { name: 'TypeError', message: 'A selector must be a non-empty string.' });
  assert.throws(() => pw.locator(5), TypeError);
  assert.throws(() => pw.locator('a >> '), { name: 'SyntaxError', message: 'Invalid selector "a >> ": nothing around ">>".' });
  assert.throws(() => pw.locator('nth=first'), { name: 'SyntaxError', message: 'Invalid selector "nth=first": nth= takes an integer.' });
  assert.throws(() => pw.locator('role=button'), { name: 'SyntaxError', message: /^Unsupported selector engine "role="/ });
  assert.throws(() => pw.locator('text=/(/'), SyntaxError);
});

test('getBy* build steps with text matchers and readable descriptions', () => {
  const { pw } = bound();
  const role = pw.getByRole('Button', { name: 'Save', exact: true, checked: false, level: 2, includeHidden: true, bogus: 1 });
  assert.deepEqual(stepsOf(role), [
    { k: 'role', role: 'button', checked: false, level: 2, includeHidden: true, name: { s: 'Save', exact: true } },
  ]);
  assert.equal(String(role), 'getByRole("Button", { name: "Save", exact: true, checked: false, level: 2, includeHidden: true, bogus: 1 })');
  assert.equal(String(pw.getByRole('link', { name: /more/i })), 'getByRole("link", { name: /more/i })');
  assert.deepEqual(stepsOf(pw.getByRole('link', { name: /more/i })), [{ k: 'role', role: 'link', name: { re: 'more', flags: 'i' } }]);
  assert.equal(String(pw.getByRole('row')), 'getByRole("row")');
  assert.deepEqual(stepsOf(pw.getByText('Hi')), [{ k: 'text', m: { s: 'Hi', exact: false } }]);
  assert.deepEqual(stepsOf(pw.getByText('Hi', { exact: true })), [{ k: 'text', m: { s: 'Hi', exact: true } }]);
  assert.deepEqual(stepsOf(pw.getByLabel('Email')), [{ k: 'label', m: { s: 'Email', exact: false } }]);
  assert.deepEqual(stepsOf(pw.getByPlaceholder('Search', { exact: true })), [
    { k: 'attr', name: 'placeholder', m: { s: 'Search', exact: true } },
  ]);
  assert.deepEqual(stepsOf(pw.getByAltText('Logo')), [{ k: 'attr', name: 'alt', m: { s: 'Logo', exact: false } }]);
  assert.deepEqual(stepsOf(pw.getByTitle('Info')), [{ k: 'attr', name: 'title', m: { s: 'Info', exact: false } }]);
  assert.deepEqual(stepsOf(pw.getByTestId('go')), [{ k: 'attr', name: 'data-testid', m: { s: 'go', exact: true } }]);
  assert.deepEqual(stepsOf(pw.getByTestId(/^go/)), [{ k: 'attr', name: 'data-testid', m: { re: '^go', flags: '' } }]);
  assert.equal(String(pw.getByLabel('E', { exact: undefined })), 'getByLabel("E")');
  assert.throws(() => pw.getByRole(''), { name: 'TypeError', message: 'getByRole needs a role such as "button".' });
  assert.throws(() => pw.getByRole(3), TypeError);
  assert.throws(() => pw.getByText(42), { name: 'TypeError', message: 'Expected a string or a RegExp, got 42.' });
});

test('locators chain: scoped locators, nth/first/last, filter, and/or, frame locators', () => {
  const { pw, g } = bound();
  const list = pw.locator('ul');
  const item = list
    .getByRole('listitem')
    .filter({ hasText: 'Apple', hasNotText: /sold/, has: pw.locator('button'), hasNot: pw.getByText('x'), visible: 1 });
  assert.equal(String(item), 'locator("ul").getByRole("listitem").filter({"hasText":"Apple","hasNotText":"/sold/","visible":1})');
  assert.deepEqual(stepsOf(item).at(-1), {
    k: 'filter',
    hasText: { s: 'Apple', exact: false },
    hasNotText: { re: 'sold', flags: '' },
    has: [{ k: 'css', s: 'button' }],
    hasNot: [{ k: 'text', m: { s: 'x', exact: false } }],
    visible: true,
  });
  assert.deepEqual(stepsOf(list.filter()).at(-1), { k: 'filter' });
  assert.deepEqual(stepsOf(pw.locator('li', { hasText: 'A' })).at(-1), { k: 'filter', hasText: { s: 'A', exact: false } });
  assert.deepEqual(stepsOf(list.nth(2)).at(-1), { k: 'nth', i: 2 });
  assert.equal(String(list.first()), 'locator("ul").first()');
  assert.deepEqual(stepsOf(list.last()).at(-1), { k: 'nth', i: -1 });
  assert.equal(String(list.nth(1)), 'locator("ul").nth(1)');
  assert.throws(() => list.nth(1.5), { name: 'TypeError', message: 'nth needs an integer.' });
  assert.deepEqual(stepsOf(list.and(pw.locator('.x'))).at(-1), { k: 'and', steps: [{ k: 'css', s: '.x' }] });
  assert.equal(String(list.or(pw.locator('ol'))), 'locator("ul").or(locator("ol"))');
  assert.deepEqual(stepsOf(list.or(pw.locator('ol'))).at(-1), { k: 'or', steps: [{ k: 'css', s: 'ol' }] });
  assert.throws(() => list.and('ol'), { name: 'TypeError', message: 'and needs a locator of the same tab.' });
  const other = bound().pw.locator('ol');
  assert.throws(() => list.or(other), { name: 'TypeError', message: 'or needs a locator of the same tab.' });
  assert.throws(() => list.filter({ has: pw.frameLocator('iframe').locator('b') }), {
    name: 'TypeError',
    message: "filter({ has }) can't take a locator inside a frame.",
  });
  assert.throws(() => list.filter({ hasNot: 3 }), { message: 'filter({ hasNot }) needs a locator of the same tab.' });
  assert.equal(JSON.stringify(list), '"Locator locator(\\"ul\\")"');
  // frame locators: the steps up to the frame, a frame step, then the steps inside
  const fl = g.tab.frameLocator('#pay');
  assert.deepEqual(stepsOf(fl.getByRole('button')), [{ k: 'css', s: '#pay' }, { k: 'frame' }, { k: 'role', role: 'button' }]);
  assert.equal(String(fl.locator('input')), 'frameLocator("#pay").locator("input")');
  assert.deepEqual(stepsOf(fl.first().getByText('A')), [
    { k: 'css', s: '#pay' },
    { k: 'nth', i: 0 },
    { k: 'frame' },
    { k: 'text', m: { s: 'A', exact: false } },
  ]);
  assert.deepEqual(stepsOf(fl.last().locator('a')).slice(1, 3), [{ k: 'nth', i: -1 }, { k: 'frame' }]);
  assert.equal(String(fl.nth(1).locator('a')), 'frameLocator("#pay").nth(1).locator("a")');
  assert.deepEqual(stepsOf(fl.owner()), [{ k: 'css', s: '#pay' }]);
  assert.equal(String(fl.owner()), 'frameLocator("#pay").owner()');
  assert.deepEqual(stepsOf(fl.frameLocator('#inner').locator('b')), [
    { k: 'css', s: '#pay' },
    { k: 'frame' },
    { k: 'css', s: '#inner' },
    { k: 'frame' },
    { k: 'css', s: 'b' },
  ]);
  assert.deepEqual(stepsOf(list.frameLocator('iframe').getByLabel('Card')), [
    { k: 'css', s: 'ul' },
    { k: 'css', s: 'iframe' },
    { k: 'frame' },
    { k: 'label', m: { s: 'Card', exact: false } },
  ]);
});

test('locator actions send loc.act with their value, options and timeout', async () => {
  const { pw, calls } = bound((op, a) => (a.action === 'select' ? ['v'] : null), 'darwin');
  const b = pw.getByRole('button');
  const base = { steps: stepsOf(b), desc: 'getByRole("button")', tab: 't1' };
  assert.equal(
    await b.click({
      button: 'right',
      modifiers: ['ControlOrMeta', 'Shift'],
      position: { x: 1, y: 2 },
      timeout: 500,
      force: true,
      delay: 3000,
      junk: 1,
    }),
    undefined,
  );
  await b.click({ messageKind: 'ordinary' });
  await b.dblclick({ modifiers: 'Alt+cmd' });
  await b.hover({ position: { x: 3, y: 4 } });
  await b.fill(12);
  await b.clear();
  await b.type('ab');
  await b.pressSequentially('cd', { timeoutMs: 50 });
  await b.press('ControlOrMeta+A', { delay: 1000, messageKind: 'commits' });
  await b.check();
  await b.uncheck();
  await b.setChecked(1);
  assert.deepEqual(await b.selectOption(['a', { label: 'B', junk: 1 }]), ['v']);
  await b.selectOption('c');
  await b.focus();
  await b.scrollIntoViewIfNeeded();
  const act = (action: string, value: any, options: any = {}, timeoutMs: any = null) => [
    'loc.act',
    { ...base, action, value, options, timeoutMs },
  ];
  assert.deepEqual(calls, [
    act('click', null, { force: true, button: 'right', modifiers: 'meta+shift', position: { x: 1, y: 2 }, delay: 3000 }, 500),
    act('click', null, { messageKind: 'ordinary', modifiers: '' }),
    act('click', null, { clickCount: 2, modifiers: 'alt+meta' }),
    act('hover', null, { position: { x: 3, y: 4 } }),
    act('fill', '12'),
    act('fill', ''),
    act('type', 'ab'),
    act('type', 'cd', {}, 50),
    act('press', 'Meta+A', { delay: 1000, messageKind: 'commits' }),
    act('check', true),
    act('check', false),
    act('check', true),
    act('select', ['a', { label: 'B' }]),
    act('select', ['c']),
    act('focus', null),
    act('scroll', null),
  ]);
  const linux = bound();
  await linux.pw.locator('a').press('ControlOrMeta+c');
  await linux.pw.locator('a').click({ modifiers: ['ControlOrMeta', 'Hyper'] });
  assert.deepEqual([linux.calls[0][1].value, linux.calls[1][1].options.modifiers], ['Control+c', 'ctrl+Hyper']);
});

test('locator reads and waits send loc.read and loc.waitFor; all() makes one locator per match', async () => {
  const answers: Record<string, any> = { count: 2, isVisible: true, isEnabled: false };
  const { pw, calls } = bound((op, a) => (op === 'loc.waitFor' ? null : (answers[a.what] ?? `${a.what}!`)));
  const l = pw.locator('p');
  assert.equal(await l.count(), 2);
  const all = await l.all();
  assert.deepEqual(all.map(String), ['locator("p").nth(0)', 'locator("p").nth(1)']);
  assert.equal(await l.innerText({ timeoutMs: 5 }), 'innerText!');
  assert.equal(await l.textContent(), 'textContent!');
  assert.equal(await l.innerHTML(), 'innerHTML!');
  assert.equal(await l.getAttribute(7), 'attr!');
  assert.equal(await l.inputValue(), 'value!');
  assert.equal(await l.allTextContents(), 'allTextContents!');
  assert.equal(await l.allInnerTexts(), 'allInnerTexts!');
  assert.equal(await l.isVisible(), true);
  assert.equal(await l.isHidden(), false);
  assert.equal(await l.isEnabled(), false);
  assert.equal(await l.isDisabled(), true);
  assert.equal(await l.isEditable(), 'isEditable!');
  assert.equal(await l.isChecked(), 'isChecked!');
  assert.equal(await l.boundingBox(), 'boundingBox!');
  assert.equal(await l.screenshot({ timeout: 9 }), 'screenshot!');
  assert.equal(await l.waitFor(), undefined);
  await l.waitFor({ state: 'detached', timeoutMs: 3 });
  const reads = calls.filter((c) => c[0] === 'loc.read').map((c) => [c[1].what, c[1].timeoutMs, c[1].name]);
  assert.deepEqual(reads, [
    ['count', null, undefined],
    ['count', null, undefined],
    ['innerText', 5, undefined],
    ['textContent', null, undefined],
    ['innerHTML', null, undefined],
    ['attr', null, '7'],
    ['value', null, undefined],
    ['allTextContents', null, undefined],
    ['allInnerTexts', null, undefined],
    ['isVisible', null, undefined],
    ['isVisible', null, undefined],
    ['isEnabled', null, undefined],
    ['isEnabled', null, undefined],
    ['isEditable', null, undefined],
    ['isChecked', null, undefined],
    ['boundingBox', null, undefined],
    ['screenshot', 9, undefined],
  ]);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'loc.waitFor').map((c) => [c[1].state, c[1].timeoutMs]),
    [
      ['visible', null],
      ['detached', 3],
    ],
  );
  assert.throws(() => l.evaluate(), { name: 'TypeError', message: /^locator\.evaluate is not available in browser_script\./ });
  assert.throws(() => l.evaluateAll(), { message: /^locator\.evaluateAll is not available/ });
});

test('tab: navigation, info, marks, screenshots and dialogs', async () => {
  const { tab, calls } = bound((op) => {
    if (op === 'tab.title') return 'Title';
    if (op === 'tab.url') return 'https://a.test/';
    if (op === 'tab.screenshot') return { screenshot: 1 };
    if (op === 'tab.dialog')
      return calls.filter((c) => c[0] === 'tab.dialog').length > 1 ? { type: 'prompt', message: 'Name?', defaultValue: 'x' } : null;
    return 'ignored';
  });
  for (const m of ['back', 'forward', 'reload', 'close', 'select', 'bringToFront', 'markDeliverable', 'markHandoff'])
    assert.equal(await tab[m](), undefined);
  assert.equal(await tab.goto(42), undefined);
  assert.equal(await tab.title(), 'Title');
  assert.equal(await tab.url(), 'https://a.test/');
  assert.deepEqual(await tab.screenshot({ fullPage: true, clip: { x: 1 }, junk: 2 }), { screenshot: 1 });
  await tab.screenshot();
  assert.equal(await tab.getJsDialog(), undefined);
  const d = await tab.getJsDialog();
  assert.deepEqual([d.type, d.message, d.defaultValue], ['prompt', 'Name?', 'x']);
  assert.equal(await d.accept('Bob'), undefined);
  await d.accept();
  await d.dismiss();
  assert.deepEqual(
    calls.map((c) => [c[0], { ...c[1], tab: undefined }]),
    [
      ['tab.back', {}],
      ['tab.forward', {}],
      ['tab.reload', {}],
      ['tab.close', {}],
      ['tab.select', {}],
      ['tab.select', {}],
      ['tab.mark', { status: 'deliverable' }],
      ['tab.mark', { status: 'handoff' }],
      ['tab.goto', { url: '42' }],
      ['tab.title', {}],
      ['tab.url', {}],
      ['tab.screenshot', { clip: { x: 1 }, fullPage: true }],
      ['tab.screenshot', {}],
      ['tab.dialog', {}],
      ['tab.dialog', {}],
      ['tab.dialog.answer', { accept: true, text: 'Bob' }],
      ['tab.dialog.answer', { accept: true, text: null }],
      ['tab.dialog.answer', { accept: false, text: null }],
    ].map(([op, a]: any) => [op, { ...a, tab: undefined }]),
  );
});

test('tab.playwright: snapshot, load and URL waits, timeouts, page JavaScript and unsupported calls; tab aliases', async () => {
  let url = 'https://a.test/start';
  const { tab, pw, calls } = bound((op) => {
    if (op === 'tab.url') {
      const now = url;
      url = 'https://a.test/done/x';
      return now;
    }
    if (op === 'tab.domSnapshot') return '- button "Go" [ref_1]';
    if (op === 'tab.evaluate') return { ok: 1 };
    return null;
  });
  assert.equal(await pw.domSnapshot(), '- button "Go" [ref_1]');
  assert.equal(await pw.waitForLoadState(), undefined);
  await pw.waitForLoadState('networkidle', { timeoutMs: 7 });
  await pw.waitForLoadState({ state: 'domcontentloaded', timeout: 8 });
  await pw.waitForLoadState(null);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'tab.waitForLoadState').map((c) => [c[1].state, c[1].timeoutMs]),
    [
      ['load', null],
      ['networkidle', 7],
      ['domcontentloaded', 8],
      ['load', null],
    ],
  );
  calls.length = 0;
  await pw.waitForURL('**/done/*');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['tab.url', 'sleep', 'tab.url', 'tab.waitForLoadState'],
  );
  calls.length = 0;
  await pw.waitForURL(/done/, { waitUntil: 'commit' });
  await pw.waitForURL((u: string) => u.endsWith('/x'), { waitUntil: 'domcontentloaded' });
  await pw.waitForURL('https://a.test/done/x');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'tab.waitForLoadState').map((c) => c[1].state),
    ['domcontentloaded', 'load'],
  );
  url = 'https://a.test/(x)?y+z';
  await tab.waitForURL('https://a.test/(x)?y+z');
  const e = await pw.waitForURL('https://other.test/*', { timeoutMs: 0 }).catch((x: any) => x);
  assert.deepEqual(
    [e.name, e.code, e.message],
    ['TimeoutError', 'timeout', 'Timed out after 0 ms waiting for the URL to match "https://other.test/*" (it is https://a.test/done/x).'],
  );
  assert.match(e.site, /browserScriptRuntime\.test\.ts/);
  calls.length = 0;
  assert.equal(await pw.waitForTimeout(3), undefined);
  await tab.waitForTimeout(4);
  assert.deepEqual(await pw.evaluate((a) => a.n + 1, { n: 1 }), { ok: 1 });
  await pw.evaluate(() => document.title);
  await tab.evaluate('document.title');
  assert.deepEqual(
    calls.map((c) => [c[0], c[1].ms ?? c[1].expression]),
    [
      ['sleep', 3],
      ['sleep', 4],
      ['tab.evaluate', '((a) => a.n + 1)({"n":1})'],
      ['tab.evaluate', '(() => document.title)()'],
      ['tab.evaluate', 'document.title'],
    ],
  );
  for (const m of ['elementInfo', 'elementScreenshot', 'expectNavigation', 'waitForEvent'])
    assert.throws(() => pw[m](), { name: 'TypeError', message: new RegExp(`^${m} is not available in browser_script\\.`) });
  // tab aliases of tab.playwright
  calls.length = 0;
  for (const [m, arg] of [
    ['locator', 'a'],
    ['getByRole', 'link'],
    ['getByText', 't'],
    ['getByLabel', 'l'],
    ['getByPlaceholder', 'p'],
    ['getByAltText', 'a'],
    ['getByTitle', 't'],
    ['getByTestId', 'id'],
  ])
    assert.deepEqual(stepsOf(tab[m](arg)), stepsOf(pw[m](arg)));
  assert.deepEqual(stepsOf(tab.frameLocator('f').locator('a')), stepsOf(pw.frameLocator('f').locator('a')));
  assert.equal(await tab.domSnapshot(), '- button "Go" [ref_1]');
  await tab.waitForLoadState('load');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['tab.domSnapshot', 'tab.waitForLoadState'],
  );
});

test('raw input: tab.cua, tab.mouse and tab.keyboard map to cua.* calls; dev.logs reads the console', async () => {
  const { tab, calls } = bound((op) => (op === 'tab.logs' ? [{ level: 'log', text: 'x' }] : 'ignored'), 'darwin');
  assert.equal(await tab.cua.click({ x: 1, y: 2 }), undefined);
  await tab.cua.click({ x: 1, y: 2, button: 3, keypress: ['CTRL', 'shift'] });
  await tab.cua.click({ x: 1, y: 2, button: 9, keys: 'alt' });
  await tab.cua.double_click({ x: 3, y: 4, keypress: ['META'] });
  await tab.cua.double_click({ x: 3, y: 4, keys: 'shift' });
  await tab.cua.move({ x: 5, y: 6 });
  await tab.cua.scroll({ x: 7, y: 8, scrollY: 300 });
  await tab.cua.scroll({ x: 7, y: 8, scrollX: -10, scrollY: 0 });
  await tab.cua.scroll({ x: 7, y: 8, scrollX: 5 });
  await tab.cua.type({ text: 42 });
  await tab.cua.keypress({ keys: ['CMD', 'A'] });
  await tab.cua.keypress({ keys: 'ENTER' });
  await tab.cua.drag({
    path: [
      { x: 0, y: 0 },
      { x: 9, y: 9 },
    ],
  });
  await tab.mouse.click(1, 2);
  await tab.mouse.click(1, 2, { button: 'middle', clickCount: 2, modifiers: ['Shift'], delay: 1500 });
  await tab.mouse.click(1, 2, { button: 'nope' });
  await tab.mouse.dblclick(3, 4);
  await tab.mouse.move(5, 6);
  await tab.mouse.wheel(0, 120);
  await tab.keyboard.press('ControlOrMeta+K', { delay: 2000 });
  await tab.keyboard.type('hi');
  await tab.keyboard.insertText(7);
  assert.deepEqual(await tab.dev.logs({ onlyErrors: true, junk: 1 }), [{ level: 'log', text: 'x' }]);
  await tab.dev.logs();
  assert.deepEqual(
    calls.map((c) => [c[0], { ...c[1], tab: undefined }]),
    [
      ['cua.click', { x: 1, y: 2, button: 'left', modifiers: '' }],
      ['cua.click', { x: 1, y: 2, button: 'right', modifiers: 'ctrl+shift' }],
      ['cua.click', { x: 1, y: 2, button: 'left', modifiers: 'alt' }],
      ['cua.click', { x: 3, y: 4, clickCount: 2, modifiers: 'meta' }],
      ['cua.click', { x: 3, y: 4, clickCount: 2, modifiers: 'shift' }],
      ['cua.move', { x: 5, y: 6 }],
      ['cua.scroll', { x: 7, y: 8, dx: 0, dy: 300 }],
      ['cua.scroll', { x: 7, y: 8, dx: -10, dy: 0 }],
      ['cua.scroll', { x: 7, y: 8, dx: 5, dy: 0 }],
      ['cua.type', { text: '42' }],
      ['cua.keys', { keys: 'CMD+A' }],
      ['cua.keys', { keys: 'ENTER' }],
      [
        'cua.drag',
        {
          path: [
            { x: 0, y: 0 },
            { x: 9, y: 9 },
          ],
        },
      ],
      ['cua.click', { x: 1, y: 2, button: 'left', clickCount: 1, modifiers: '' }],
      ['cua.click', { x: 1, y: 2, button: 'middle', clickCount: 2, modifiers: 'shift', delay: 1500 }],
      ['cua.click', { x: 1, y: 2, button: 'left', clickCount: 1, modifiers: '' }],
      ['cua.click', { x: 3, y: 4, clickCount: 2 }],
      ['cua.move', { x: 5, y: 6 }],
      ['cua.scroll', { x: null, y: null, dx: 0, dy: 120 }],
      ['cua.keys', { keys: 'Meta+K', delay: 2000 }],
      ['cua.type', { text: 'hi' }],
      ['cua.type', { text: '7' }],
      ['tab.logs', { onlyErrors: true }],
      ['tab.logs', {}],
    ].map(([op, a]: any) => [op, { ...a, tab: undefined }]),
  );
});

test('tabs and browser: new, list, selected, get; documentation; agent.browsers returns this browser', async () => {
  const { g, calls } = harness(
    (op, a) => {
      if (op === 'tabs.new') return { id: 'tab_n' };
      if (op === 'tabs.list') return [{ id: 'a' }];
      if (op === 'tabs.selected') return calls.filter((c) => c[0] === 'tabs.selected').length > 1 ? { id: 'tab_s' } : null;
      if (op === 'tabs.get') return { id: a.id };
      return null;
    },
    { current: null, platform: 'linux' },
  );
  const t = await g.tabs.new();
  assert.equal(t.id, 'tab_n');
  await g.browser.tabs.new('https://a.test');
  await g.tabs.new({ url: 'https://b.test' });
  await g.tabs.new({});
  assert.deepEqual(
    calls.filter((c) => c[0] === 'tabs.new').map((c) => c[1].url),
    [null, 'https://a.test', 'https://b.test', null],
  );
  assert.deepEqual(await g.tabs.list(), [{ id: 'a' }]);
  assert.equal(await g.tabs.selected(), undefined);
  assert.equal((await g.tabs.selected()).id, 'tab_s');
  assert.equal((await g.tabs.get(5)).id, '5');
  await t.title();
  assert.deepEqual(calls.at(-1), ['tab.title', { tab: 'tab_n' }]);
  assert.equal(await g.browser.documentation(), '');
  assert.equal(await harness().g.browser.documentation(), 'DOC');
  assert.equal(await g.browser.nameSession('x'), undefined);
  for (const m of ['get', 'getDefault', 'getForUrl']) assert.equal(await g.agent.browsers[m]('iab'), g.browser);
  assert.deepEqual(await g.agent.browsers.list(), [{ id: 'iab', name: 'MoPilot built-in browser' }]);
});

test('start reports the outcome: a value as JSON, undefined, an error with its code and stack, or a thrown non-error', async () => {
  const outcome = async (fn: () => Promise<any>) => {
    const h = harness();
    h.rt.start(fn);
    await new Promise((r) => setImmediate(r));
    return h.sent.find((m) => m.t === 'done');
  };
  assert.deepEqual(await outcome(async () => ({ a: 1 })), { t: 'done', ok: true, value: '{\n  "a": 1\n}', undef: false });
  assert.deepEqual(await outcome(async () => undefined), { t: 'done', ok: true, value: null, undef: true });
  const coded = await outcome(async () => {
    throw Object.assign(new Error('boom'), { code: 'strict', site: 'SITE' });
  });
  assert.deepEqual(coded.error, { name: 'Error', message: 'boom', code: 'strict', stack: 'SITE' });
  const plain = await outcome(async () => {
    throw new RangeError('r');
  });
  assert.deepEqual([plain.error.name, plain.error.code], ['RangeError', null]);
  assert.match(plain.error.stack, /RangeError: r/);
  const odd = await outcome(async () => {
    throw Object.assign(new Error('o'), { code: 5, stack: undefined });
  });
  assert.deepEqual([odd.error.code, odd.error.stack], [null, '']);
  assert.deepEqual(
    (
      await outcome(async () => {
        throw 'nope';
      })
    ).error,
    { name: 'Error', message: 'Uncaught "nope"', code: null, stack: '' },
  );
  assert.deepEqual(
    (
      await outcome(async () => {
        throw null;
      })
    ).error.message,
    'Uncaught null',
  );
});

test('withReturn returns the last expression like a REPL, keeping line numbers; statements stay as they are', () => {
  assert.equal(withReturn(vm, 'const a = 1;\na + 1;'), 'const a = 1;\nreturn (a + 1\n)');
  assert.equal(withReturn(vm, 'await tab.title()'), 'return (await tab.title()\n)');
  assert.equal(withReturn(vm, 'const x = await f(\n  1,\n)\n'), 'const x = await f(\n  1,\n)\n');
  assert.equal(withReturn(vm, 'foo(\n  1\n)'), 'return (foo(\n  1\n)\n)');
  assert.equal(withReturn(vm, 'x()\n// done'), 'return (x()\n// done\n)');
  assert.equal(withReturn(vm, 'return 5'), 'return 5');
  assert.equal(withReturn(vm, 'if (a) {\n  b()\n}'), 'if (a) {\n  b()\n}');
  assert.equal(withReturn(vm, 'x()\n\n   \n'), 'return (x()\n)');
  assert.equal(withReturn(vm, ''), '');
  // only the last 40 lines are tried
  const long = `f(\n${'1,\n'.repeat(45)})`;
  assert.equal(withReturn(vm, long), long);
});

/** A fake worker port: what the worker posts, and a way to answer it. */
function port({ throws = false } = {}) {
  const posted: any[] = [];
  let listener: any = null;
  return {
    posted,
    closed: 0,
    close() {
      this.closed++;
    },
    postMessage: (m: string) => {
      if (throws) throw new Error('closed');
      posted.push(JSON.parse(m));
    },
    on: (_e: string, f: any) => (listener = f),
    answer: (m: any) => listener(JSON.stringify(m)),
    listener: (raw: string) => listener(raw),
  };
}
const RUNTIME = `(${scriptRuntime})`;
const settle = () => new Promise((r) => setTimeout(r, 5));
/** A worker over a fake port, as script.cjs starts it. */
const worker = (p: any, init: any = {}, toBody: any = withReturn, keep: any = persist) =>
  workerMain(p, vm, RUNTIME, { init }, toBody, keep);
const runMsg = (p: any, run: number, code: string, current: any = undefined) => p.answer({ t: 'run', run, code, current });

test('workerMain: each run is one call in the same context: only the API globals, answers come back, declarations stay', async () => {
  const p = port();
  worker(p, { platform: 'linux' });
  runMsg(
    p,
    1,
    'console.log(typeof require, typeof process, typeof setTimeout, typeof tab.goto)\nconst t = await tab.title()\nlet n = 41\nfunction inc(x) { return x + 1 }\nt + "!"',
    't1',
  );
  await settle();
  const call = p.posted.find((m) => m.t === 'call');
  assert.deepEqual([call.op, call.args], ['tab.title', { tab: 't1' }]);
  p.answer({ id: call.id, ok: true, value: 'Hi' });
  await settle();
  assert.deepEqual(p.posted.find((m) => m.t === 'log').text, 'undefined undefined undefined function');
  assert.deepEqual(p.posted.at(-1), { t: 'done', run: 1, ok: true, value: '"Hi!"', undef: false });
  // the next call sees the earlier declarations; tab is the chat's current tab at its start (here, none yet)
  runMsg(p, 2, '[t, inc(n), tab.id]');
  await settle();
  assert.deepEqual(p.posted.at(-1), { t: 'done', run: 2, ok: true, value: '[\n  "Hi",\n  42,\n  null\n]', undef: false });
  // anything that isn't JSON is ignored; other messages are answers
  p.answer('nope');
  p.listener('not json');
  p.answer(null);
  assert.equal(p.posted.length, 4);
});

test("workerMain: no code from strings, syntax errors name their line, a form that doesn't compile runs as written, and a broken port ends the worker", async () => {
  const p = port();
  worker(p);
  runMsg(p, 1, 'return (() => {}).constructor("return 1")()');
  await settle();
  assert.match(p.posted.at(-1).error.message, /Code generation from strings disallowed/);
  runMsg(p, 2, 'const a = 1\nconst = 2');
  assert.deepEqual(
    { ...p.posted.at(-1), error: { ...p.posted.at(-1).error, message: undefined } },
    { t: 'done', run: 2, ok: false, error: { name: 'SyntaxError', message: undefined, code: 'syntax', line: 2, stack: '' } },
  );
  // the kept form fails to compile: the code runs as written, its declarations local
  const k = port();
  worker(k, {}, withReturn, () => 'this is not javascript (');
  runMsg(k, 1, 'let local = 5\nlocal');
  await settle();
  assert.equal(k.posted.at(-1).value, '5');
  runMsg(k, 2, 'typeof local');
  await settle();
  assert.equal(k.posted.at(-1).value, '"undefined"');
  const r = port();
  worker(r, {}, () => {
    throw new Error('rewrite failed');
  });
  runMsg(r, 1, 'x');
  assert.deepEqual(r.posted.at(-1).error, { name: 'Error', message: 'rewrite failed', code: 'syntax', line: null, stack: '' });
  // a port that can't carry the answer is closed, which ends the worker: main reports its exit to the caller
  const closed = port({ throws: true });
  worker(closed);
  runMsg(closed, 1, '1');
  await settle();
  assert.deepEqual(closed.posted, []);
  assert.equal(closed.closed > 0, true);
});

test('persist: top-level declarations become assignments to globals; nested ones, strings, comments and regexps stay', () => {
  assert.equal(
    persist('let a = 1, b;\nconst { c, d: e } = obj\nvar [f] = arr;'),
    ';(a = 1, b = undefined);\n;({ c, d: e } = obj)\n;([f] = arr);',
  );
  assert.equal(
    persist('for (let i = 0; i < 2; i++) { let j = i }\nif (x) { const y = 1 }'),
    'for (let i = 0; i < 2; i++) { let j = i }\nif (x) { const y = 1 }',
  );
  assert.equal(
    persist('function g() {}\nasync function* h() {}\nconst k = function inner() {}'),
    'globalThis.g = g; globalThis.h = h; function g() {}\nasync function* h() {}\n;(k = function inner() {})',
  );
  assert.equal(persist('class H extends mix(A) { m() { let x = 1 } }\nx'), 'H = class H extends mix(A) { m() { let x = 1 } };\nx');
  assert.equal(
    persist('const s = "let z = 1"; // let y = 2\n/* let q = 1\n*/ let w = `a\nlet v = ${1}`'),
    ';(s = "let z = 1"); // let y = 2\n/* let q = 1\n*/ ;(w = `a\nlet v = ${1}`)',
  );
  assert.equal(
    persist('const r = /let [\'"[\\]/] = 3/g\nlet t = x\n  .y()\nlet u = 1 +\n2\nlet last'),
    ';(r = /let [\'"[\\]/] = 3/g)\n;(t = x\n  .y())\n;(u = 1 +\n2)\n;(last = undefined)',
  );
  // what is not a declaration at the start of a statement stays
  assert.equal(persist('x.let = 1; a = b / c / d; foo(let_)\nlet = 3\nlet(5)'), 'x.let = 1; a = b / c / d; foo(let_)\nlet = 3\nlet(5)');
  assert.equal(persist('const x = a == b, y = c => d, z = e >= f\nlet q = (1, 2)'), ';(x = a == b, y = c => d, z = e >= f)\n;(q = (1, 2))');
  // unbalanced code ends the statement where its block does; an unterminated comment or literal runs to the end
  assert.equal(persist('let a = 1 }'), ';(a = 1 )}');
  assert.equal(persist('let a = 1 /* open'), ';(a = 1 /* open)');
  assert.equal(persist('let a = "open'), ';(a = "open)');
  assert.equal(persist('class Open { m() {'), 'Open = class Open { m() {;');
  assert.equal(persist('// just a comment'), '// just a comment');
});

test('persist: kept declarations work across calls in one context, and its output keeps the line numbers', async () => {
  const ctx = vm.createContext({});
  const run = (code: string) => vm.runInContext(`(async () => {\n${persist(code)}\n})()`, ctx);
  await run('let a = 1\nconst { b } = { b: 2 }\nfunction f() { return a + b }\nclass C { v() { return 3 } }');
  assert.equal(await run('return f() + new C().v()'), 6);
  const code = 'let a = 1\nconst s = `x\ny`\nlet t = 2';
  assert.equal(persist(code).split('\n').length, code.split('\n').length);
});

test('hardenRealm leaves the constructors leading nowhere and takes Node and network globals away', () => {
  const ctors = [{ prototype: { constructor: 'F' } }, { prototype: { constructor: 'AF' } }];
  const g: any = {
    process: 1,
    require: 1,
    module: 1,
    exports: 1,
    Buffer: 1,
    fetch: 1,
    WebSocket: 1,
    EventSource: 1,
    XMLHttpRequest: 1,
    eval: 1,
    keep: 1,
  };
  hardenRealm(g, ctors);
  assert.deepEqual(g, { keep: 1 });
  for (const c of ctors) {
    assert.equal(c.prototype.constructor, undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(c.prototype, 'constructor'), {
      value: undefined,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
});

test('reserved raw button and modifier names use the ordinary script input fallbacks', async () => {
  const { tab, calls } = bound();
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    await tab.cua.click({ x: 1, y: 2, button: name, keypress: [name] });
    assert.deepEqual(calls.at(-1), ['cua.click', { x: 1, y: 2, button: 'left', modifiers: name, tab: 't1' }]);
    await tab.mouse.click(3, 4, { button: name, modifiers: [name] });
    assert.deepEqual(calls.at(-1), ['cua.click', { x: 3, y: 4, button: 'left', clickCount: 1, modifiers: name, tab: 't1' }]);
  }
});
