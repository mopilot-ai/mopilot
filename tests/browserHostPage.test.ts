// The browser host's page actions (electron/capabilities/browser/host.cjs): navigation and history, reading and
// finding elements across frames, locating points, queries, inspecting, exec, waiting for a load, intent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { flush, drive, setup, tabOf, navTab, framedTab } from './support/browser-host-kit.ts';

const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');

test('navigate: loads the URL and waits for it; failures, a closed tab and slow pages are reported', async (t) => {
  const h = setup(t);
  const tab = navTab(t, h);
  tab.wc.handlers['Page.navigate'] = (p: any) => {
    setTimeout(() => {
      tab.wc.url = p.url;
      tab.wc.title = 'Loaded';
      tab.wc.emit('did-stop-loading');
    }, 30);
    return { loaderId: 'L1', frameId: 'main' };
  };
  assert.deepEqual(await drive(t, h.tabs.navigate(tab, 'https://a.test/')), { url: 'https://a.test/', title: 'Loaded' });
  assert.equal(tab.navigating, false);
  // a same-document navigation has no loader: nothing to wait for
  tab.wc.handlers['Page.navigate'] = () => ({ frameId: 'main' });
  assert.deepEqual(await drive(t, h.tabs.navigate(tab, 'https://a.test/#x')), { url: 'https://a.test/', title: 'Loaded' });
  tab.wc.handlers['Page.navigate'] = () => undefined;
  assert.ok(await drive(t, h.tabs.navigate(tab, 'https://a.test/#y')));
  // CDP says it failed
  tab.wc.handlers['Page.navigate'] = () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  await assert.rejects(drive(t, h.tabs.navigate(tab, 'https://nope.test/')), {
    code: 'failed',
    message: /^Couldn't open https:\/\/nope\.test\/: the site's address wasn't found \(net::ERR_NAME_NOT_RESOLVED\)\. Check/,
  });
  // the load failed in the main frame
  tab.wc.handlers['Page.navigate'] = () => {
    setTimeout(() => {
      tab.wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'u', true);
      tab.wc.emit('did-stop-loading');
    }, 10);
    return { loaderId: 'L2' };
  };
  await assert.rejects(drive(t, h.tabs.navigate(tab, 'http://localhost:1/')), {
    code: 'failed',
    message: /^Couldn't load this page: the site refused to connect \(ERR_CONNECTION_REFUSED\)\. Try once more/,
  });
  // still loading after LOAD_MS
  tab.wc.handlers['Page.navigate'] = () => {
    tab.wc.loading = true;
    return { loaderId: 'L4' };
  };
  assert.deepEqual(await drive(t, h.tabs.navigate(tab, 'https://slow.test/'), { step: 1000 }), {
    url: 'https://a.test/',
    title: 'Loaded',
    note: 'The page is still loading.',
  });
  // the wait timed out but the page is done: it settles normally
  tab.wc.handlers['Page.navigate'] = () => {
    tab.wc.loading = false;
    return { loaderId: 'L5' };
  };
  assert.deepEqual(await drive(t, h.tabs.navigate(tab, 'https://quiet.test/'), { step: 1000 }), {
    url: 'https://a.test/',
    title: 'Loaded',
  });
  // the command itself rejects
  tab.wc.handlers['Page.navigate'] = () => {
    throw new Error('Target closed');
  };
  await assert.rejects(drive(t, h.tabs.navigate(tab, 'https://a.test/')), /Target closed/);
  assert.equal(tab.navigating, false);
  assert.equal(tab.dialogWaiters.size, 0, 'the dialog wait is dropped');
  // the tab closed while loading
  tab.wc.handlers['Page.navigate'] = () => {
    setTimeout(() => tab.wc.emit('destroyed'), 10);
    return { loaderId: 'L3' };
  };
  await assert.rejects(drive(t, h.tabs.navigate(tab, 'https://a.test/2')), {
    code: 'tab_closed',
    message: 'Tab tab_aaaaaa closed while loading.',
  });
});

test('navigate: a dialog opening before or while the page loads ends the wait with a note', async (t) => {
  const h = setup(t);
  const tab = navTab(t, h);
  await drive(t, tab.attach());
  tab.wc.url = 'https://a.test/';
  // (a beforeunload while navigating is accepted automatically; a confirm blocks)
  tab.wc.handlers['Page.navigate'] = () => {
    tab.wc.debugger.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave?' });
    return new Promise(() => {});
  };
  assert.deepEqual(await drive(t, h.tabs.navigate(tab, 'https://b.test/')), {
    url: 'https://a.test/',
    title: '',
    note: 'A dialog opened before the page could load.',
  });
  tab.dialog = null;
  tab.wc.handlers['Page.navigate'] = () => {
    setTimeout(() => tab.wc.debugger.event('Page.javascriptDialogOpening', { type: 'prompt', message: 'Name' }), 10);
    return { loaderId: 'L' };
  };
  assert.deepEqual(await drive(t, h.tabs.navigate(tab, 'https://b.test/')), {
    url: 'https://a.test/',
    title: '',
    note: 'A dialog opened while the page loaded.',
  });
  // a file chooser counts as blocking too
  tab.dialog = null;
  tab.wc.handlers['Page.navigate'] = () => {
    tab.wc.debugger.event('Page.fileChooserOpened', { mode: 'selectSingle' });
    return new Promise(() => {});
  };
  assert.equal((await drive(t, h.tabs.navigate(tab, 'https://b.test/'))).note, 'A dialog opened before the page could load.');
  // the navigation fails after the dialog won: no caller is left, so the failure is recorded
  clearIgnored();
  tab.dialog = null;
  let late: (e: Error) => void = () => {};
  tab.wc.handlers['Page.navigate'] = () => {
    tab.wc.debugger.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave?' });
    return new Promise((_resolve, reject) => (late = reject));
  };
  assert.equal((await drive(t, h.tabs.navigate(tab, 'https://b.test/'))).note, 'A dialog opened before the page could load.');
  late(new Error('Target closed'));
  await drive(t, new Promise((r) => setTimeout(r, 0)));
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['navigate a tab a dialog interrupted', 'Target closed']],
  );
  clearIgnored();
});

test('history: back, forward and reload with their target URL; the wait ends on a load or a same-page move', async (t) => {
  const h = setup(t);
  const tab = navTab(t, h);
  tab.wc.entries = [{ url: 'https://a.test/0' }, { url: 'https://a.test/1' }, {} as any];
  tab.wc.index = 1;
  assert.equal(h.tabs.historyTarget(tab, 'back'), 'https://a.test/0');
  assert.equal(h.tabs.historyTarget(tab, 'forward'), null, 'an entry without a URL');
  tab.wc.index = 0;
  assert.equal(h.tabs.historyTarget(tab, 'back'), null);
  tab.wc.index = 2;
  assert.equal(h.tabs.historyTarget(tab, 'forward'), null);
  tab.wc.entries = [{ url: 'https://a.test/0' }, { url: 'https://a.test/1' }];
  tab.wc.index = 0;
  tab.wc.navigationHistory.getEntryAtIndex = () => undefined as any;
  assert.equal(h.tabs.historyTarget(tab, 'forward'), null);

  tab.wc.url = 'https://a.test/0';
  tab.wc.title = 'Zero';
  setTimeout(() => tab.wc.emit('did-navigate-in-page'), 20);
  assert.deepEqual(await drive(t, h.tabs.history(tab, 'back')), { url: 'https://a.test/0', title: 'Zero' });
  setTimeout(() => tab.wc.emit('did-stop-loading'), 20);
  await drive(t, h.tabs.history(tab, 'forward'));
  setTimeout(() => tab.wc.emit('did-stop-loading'), 20);
  await drive(t, h.tabs.history(tab, 'reload'));
  assert.deepEqual(tab.wc.navs, ['back', 'forward', 'reload']);
});

test('readPage: the tree with cross-origin frames expanded in place, refs noted per frame, and the budget kept', async (t) => {
  const h = setup(t);
  const tab = framedTab(t, h);
  // an orphan frame whose owner can't be found is skipped while matching
  tab.frames.set('F9', { sessionId: 'F9', parent: '', frameId: 'frame-9', world: null, ownerRef: null });
  tab.wc.handlers['DOM.getFrameOwner'] = () => {
    throw new Error('No frame');
  };
  const trees: any[] = [];
  tab.wc.ops.tree = (args: any, s?: string) => {
    trees.push({ args, s });
    if (!s)
      return { lines: ['- main', '- button "Go" [ref_1]', '\u0001FRAME ref_10 1\u0001', '\u0001FRAME ref_77 1\u0001'], truncated: false };
    if (s === 'F1') return { lines: ['- link "In frame" [ref_11]', '\u0001FRAME ref_20 0\u0001'], truncated: true };
    return { lines: ['- text "deep"'], truncated: false };
  };
  const out = await drive(t, h.tabs.readPage(tab, { filter: 'all', depth: 3, maxChars: 50000 }));
  // a frame's lines are indented by the depth its placeholder gives (the iframe element's children)
  assert.deepEqual(out.lines, [
    '- main',
    '- button "Go" [ref_1]',
    '  - link "In frame" [ref_11]',
    '  - text "deep"',
    '  - (frame content unavailable)',
  ]);
  assert.equal(out.truncated, true);
  assert.deepEqual(
    trees.map((x) => [x.s, x.args.depth, x.args.filter]),
    [
      [undefined, 3, 'all'],
      ['F1', 2, 'all'],
      ['F2', 2, 'all'],
    ],
  );
  assert.equal(tab.frameOf('ref_11'), 'F1');
  assert.equal(tab.frameOf('ref_1'), '');
  // defaults; a depth used up by the frame's own depth is not expanded; the budget runs out
  trees.length = 0;
  tab.wc.ops.tree = (args: any, s?: string) => {
    trees.push({ args, s });
    return s ? { lines: ['- x'.repeat(10)] } : { lines: ['- top', '\u0001FRAME ref_10 15\u0001'] };
  };
  assert.deepEqual((await drive(t, h.tabs.readPage(tab))).lines, ['- top']);
  assert.deepEqual(trees[0].args, { filter: 'visible', depth: 15, ref: null, maxChars: 50000 });
  tab.wc.ops.tree = () => ({ lines: ['x'.repeat(2000), '\u0001FRAME ref_10 1\u0001'] });
  const small = await drive(t, h.tabs.readPage(tab, { maxChars: 1000 }));
  assert.deepEqual([small.lines.length, small.truncated], [1, true]);
});

test('readPage: a ref reads that element in its own frame; a stale ref fails', async (t) => {
  const h = setup(t);
  const tab = framedTab(t, h);
  tab.noteRefs(['[ref_11]'], 'F1');
  const seen: any[] = [];
  tab.wc.ops.tree = (args: any, s?: string) => (
    seen.push([args.ref, s]), args.ref === 'ref_11' ? { lines: ['- link [ref_11]'] } : { error: 'stale' }
  );
  assert.deepEqual((await drive(t, h.tabs.readPage(tab, { ref: 'ref_11' }))).lines, ['- link [ref_11]']);
  assert.deepEqual(seen, [['ref_11', 'F1']]);
  tab.noteRefs(['[ref_12]'], '');
  await assert.rejects(drive(t, h.tabs.readPage(tab, { ref: 'ref_12' })), { code: 'stale_ref' });
  await assert.rejects(h.tabs.readPage(tab, { ref: 'ref_404' }), { code: 'stale_ref' });
});

test('find: matches in the top frame and its cross-origin frames, up to the limit', async (t) => {
  const h = setup(t);
  const tab = framedTab(t, h);
  const calls: any[] = [];
  tab.wc.ops.find = (args: any, s?: string) => {
    calls.push([s, args.limit]);
    if (!s) return { lines: ['- button "Sign in" [ref_1]'], frames: ['ref_10', 'ref_404'] };
    if (s === 'F1') return { lines: ['- link "Sign in help" [ref_11]'], frames: ['ref_20'] };
    return { lines: ['- a [ref_21]', '- b [ref_22]', '- c [ref_23]'], frames: [] };
  };
  const lines = await drive(t, h.tabs.find(tab, 'sign in', 4));
  assert.deepEqual(lines, ['- button "Sign in" [ref_1]', '- link "Sign in help" [ref_11]', '- a [ref_21]', '- b [ref_22]']);
  assert.deepEqual(calls, [
    [undefined, 4],
    ['F1', 3],
    ['F2', 2],
  ]);
  assert.equal(tab.frameOf('ref_22'), 'F2');
  // the limit reached: frames are not visited
  calls.length = 0;
  // the deepEqual above narrowed calls (an assertion signature); the next calls are single frame ids
  tab.wc.ops.find = (args: any, s?: string) => ((calls as any[]).push(s), { lines: ['- x [ref_1]'], frames: ['ref_10'] });
  assert.deepEqual(await drive(t, h.tabs.find(tab, 'x', 1)), ['- x [ref_1]']);
  assert.deepEqual(calls, [undefined]);
  calls.length = 0;
  assert.equal((await drive(t, h.tabs.find(tab, 'x'))).length, 2);
  assert.deepEqual(calls, [undefined, 'F1'], 'the default limit (20) leaves room for the frame');
});

test("pageText, scrollTo and formInput run in the element's frame and report stale refs and field errors", async (t) => {
  const h = setup(t);
  const tab = framedTab(t, h);
  tab.wc.ops.text = (args: any) => ({ text: 'hello', maxChars: args.maxChars });
  assert.deepEqual(await drive(t, h.tabs.pageText(tab, 1234)), { text: 'hello', maxChars: 1234 });
  tab.noteRefs(['[ref_11]'], 'F1');
  tab.noteRefs(['[ref_1]'], '');
  const where: any[] = [];
  tab.wc.ops.scrollTo = (args: any, s?: string) => (where.push(s), args.ref === 'ref_11' ? { ok: true } : { error: 'stale' });
  await drive(t, h.tabs.scrollTo(tab, 'ref_11'));
  await assert.rejects(drive(t, h.tabs.scrollTo(tab, 'ref_1')), { code: 'stale_ref' });
  assert.deepEqual(where, ['F1', undefined]);
  tab.wc.ops.formInput = (args: any) =>
    args.ref === 'ref_1'
      ? { error: 'This field is disabled.' }
      : args.value === 'stale'
        ? { error: 'stale' }
        : { ok: true, value: args.value };
  assert.deepEqual(await drive(t, h.tabs.formInput(tab, 'ref_11', 'x')), { ok: true, value: 'x' });
  await assert.rejects(drive(t, h.tabs.formInput(tab, 'ref_1', 'x')), { code: 'bad_args', message: 'This field is disabled.' });
  await assert.rejects(drive(t, h.tabs.formInput(tab, 'ref_11', 'stale')), { code: 'stale_ref' });
  tab.wc.ops.formInput = () => undefined;
  assert.equal(await drive(t, h.tabs.formInput(tab, 'ref_11', 'x')), undefined);
  tab.wc.ops.scrollTo = () => undefined;
  await drive(t, h.tabs.scrollTo(tab, 'ref_11'));
});

/* ------------------------------------------------------------------ */
/* pointing and input                                                  */
/* ------------------------------------------------------------------ */

test("locate: a ref's center in top-frame coordinates, through nested cross-origin frames", async (t) => {
  const h = setup(t);
  const tab = framedTab(t, h);
  tab.noteRefs(['[ref_21]'], 'F2');
  tab.noteRefs(['[ref_1]'], '');
  tab.wc.ops.locate = (args: any, s?: string) => {
    if (args.ref === 'ref_21') return { x: 5, y: 6, tag: 'button', name: 'Pay', content: { x: 0, y: 0 } };
    if (args.ref === 'ref_20') return { x: 0, y: 0, content: { x: 100, y: 200 }, scrollArg: args.scroll, s };
    if (args.ref === 'ref_10') return { x: 0, y: 0, content: { x: 10, y: 20 } };
    if (args.ref === 'ref_1') return { x: 1, y: 2, tag: 'a', name: 42 };
    return { error: 'stale' };
  };
  assert.deepEqual(await drive(t, h.tabs.locate(tab, 'ref_21')), { x: 115, y: 226, tag: 'button', name: 'Pay' });
  const outer = tab.wc.agentCalls.filter((c) => c.args.ref === 'ref_20')[0];
  assert.deepEqual([outer.args.scroll, outer.sessionId], [false, 'F1']);
  // a frame owner whose name the page could not read is recorded too
  clearIgnored();
  const located = tab.wc.ops.locate;
  tab.wc.ops.locate = (args: any, s?: string) =>
    args.ref === 'ref_10' ? { ...located(args, s), nameError: 'Error: no name' } : located(args, s);
  assert.equal((await drive(t, h.tabs.locate(tab, 'ref_21'))).x, 115);
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['read the name of the element a browser action targets', 'Error: no name']],
  );
  tab.wc.ops.locate = located;
  assert.deepEqual(await drive(t, h.tabs.locate(tab, 'ref_1')), { x: 1, y: 2, tag: 'a', name: '' });
  // stale: the element, its frame owner, or a frame that went away on the way up
  tab.noteRefs(['[ref_2]'], '');
  await assert.rejects(drive(t, h.tabs.locate(tab, 'ref_2')), { code: 'stale_ref' });
  tab.frames.get('F2').ownerRef = 'ref_99';
  await assert.rejects(drive(t, h.tabs.locate(tab, 'ref_21')), { code: 'stale_ref', message: /^ref_21 is stale/ });
  tab.frames.get('F2').ownerRef = 'ref_20';
  tab.wc.ops.locate = (args: any) => {
    if (args.ref === 'ref_21') return { x: 5, y: 6, tag: 'b', name: '' };
    tab.frames.delete('F1');
    return { x: 0, y: 0, content: { x: 1, y: 1 } };
  };
  await assert.rejects(drive(t, h.tabs.locate(tab, 'ref_21')), { code: 'stale_ref' });
});

test('point: a ref or a coordinate, checked against the viewport', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const st = { w: 800, h: 600 };
  tab.noteRefs(['[ref_1]', '[ref_2]'], '');
  tab.wc.ops.locate = (args: any) =>
    args.ref === 'ref_1' ? { x: 10, y: 20, tag: 'button', name: 'OK' } : { x: 10, y: 20, tag: 'div', name: '' };
  assert.deepEqual(await drive(t, h.tabs.point(tab, st, { ref: 'ref_1' })), { x: 10, y: 20, name: 'OK' });
  assert.deepEqual(await drive(t, h.tabs.point(tab, st, { ref: 'ref_2' })), { x: 10, y: 20 });
  assert.deepEqual(await h.tabs.point(tab, st, { coordinate: ['5', 6] }), { x: 5, y: 6 });
  for (const coordinate of [undefined, [1], [1, 'x'], [1, 2, 3], 'nope'])
    await assert.rejects(h.tabs.point(tab, st, { coordinate }), { code: 'bad_args', message: 'Give a coordinate [x, y] or a ref.' });
  for (const coordinate of [
    [-1, 0],
    [0, -1],
    [800, 0],
    [0, 600],
  ])
    await assert.rejects(h.tabs.point(tab, st, { coordinate }), { code: 'outside_viewport' });
  await assert.rejects(h.tabs.point(tab, st, { coordinate: [900.4, 10] }), {
    message: '(900, 10) is outside the 800x600 viewport. Scroll first, or take a new screenshot.',
  });
});

/* ------------------------------------------------------------------ */
/* JavaScript, dialogs, files, emulation                               */
/* ------------------------------------------------------------------ */

test('locate with hit or without scrolling also reports the size and what covers the center', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.noteRef('ref_1', '');
  tab.wc.ops.locate = (args: any) => ({
    x: 10,
    y: 20,
    w: 30,
    h: 40,
    tag: 'button',
    name: 'OK',
    cover: args.hit ? '<div#overlay>' : undefined,
  });
  assert.deepEqual(await drive(t, h.tabs.locate(tab, 'ref_1', { hit: true })), {
    x: 10,
    y: 20,
    tag: 'button',
    name: 'OK',
    w: 30,
    h: 40,
    cover: '<div#overlay>',
  });
  assert.deepEqual(tab.wc.agentCalls.at(-1).args, { ref: 'ref_1', scroll: true, hit: true });
  assert.deepEqual(await drive(t, h.tabs.locate(tab, 'ref_1', { scroll: false })), {
    x: 10,
    y: 20,
    tag: 'button',
    name: 'OK',
    w: 30,
    h: 40,
    cover: null,
  });
  assert.deepEqual(tab.wc.agentCalls.at(-1).args, { ref: 'ref_1', scroll: false, hit: false });
  assert.deepEqual(await drive(t, h.tabs.locate(tab, 'ref_1')), { x: 10, y: 20, tag: 'button', name: 'OK' });
  assert.deepEqual(tab.wc.agentCalls.at(-1).args, { ref: 'ref_1' });
  // a name the page could not read is left empty, and why is recorded
  clearIgnored();
  tab.wc.ops.locate = () => ({ x: 1, y: 2, tag: 'button', name: '', nameError: 'layout gone' });
  assert.deepEqual(await drive(t, h.tabs.locate(tab, 'ref_1')), { x: 1, y: 2, tag: 'button', name: '' });
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['read the name of the element a browser action targets', 'layout gone']],
  );
});

test('query: refs from the top frame are noted; bad selectors and ambiguous frames fail', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.ops.query = (args: any) =>
    args.steps[0].k === 'bad'
      ? { error: 'Invalid locator: x' }
      : args.steps[0].k === 'two'
        ? { error: 'The frame locator matched 2 elements', strict: true }
        : { refs: ['ref_5'], count: 1, desc: ['button "Go"'] };
  assert.deepEqual(await drive(t, h.tabs.query(tab, [{ k: 'css', s: 'button' }])), {
    sessionId: '',
    refs: ['ref_5'],
    count: 1,
    desc: ['button "Go"'],
  });
  assert.deepEqual(tab.wc.agentCalls.at(-1).args, { steps: [{ k: 'css', s: 'button' }], limit: 1000 });
  assert.equal(tab.frameOf('ref_5'), '');
  await drive(t, h.tabs.query(tab, [{ k: 'css', s: 'button' }], { limit: 1 }));
  assert.equal(tab.wc.agentCalls.at(-1).args.limit, 1);
  await assert.rejects(drive(t, h.tabs.query(tab, [{ k: 'bad' }])), { code: 'bad_args', message: 'Invalid locator: x' });
  await assert.rejects(drive(t, h.tabs.query(tab, [{ k: 'two' }])), { code: 'strict' });
});

test('query: frame steps hop into cross-origin frames; a frame not attached yet matches nothing; a ref starts in its frame', async (t) => {
  const h = setup(t);
  const tab = framedTab(t, h);
  const seen: any[] = [];
  tab.wc.ops.query = (args: any, s?: string) => {
    seen.push([s, args.steps.map((x: any) => x.k)]);
    if (!s) return { hop: 'ref_10', rest: args.steps.slice(2) };
    if (s === 'F1') return { hop: 'ref_20', rest: args.steps.slice(1) };
    return { refs: ['ref_30', 'ref_31'], count: 2, desc: ['a', 'b'] };
  };
  const steps = [{ k: 'css', s: 'iframe' }, { k: 'frame' }, { k: 'frame' }, { k: 'text', m: { s: 'x' } }];
  assert.deepEqual(await drive(t, h.tabs.query(tab, steps)), { sessionId: 'F2', refs: ['ref_30', 'ref_31'], count: 2, desc: ['a', 'b'] });
  assert.deepEqual(seen, [
    [undefined, ['css', 'frame', 'frame', 'text']],
    ['F1', ['frame', 'text']],
    ['F2', ['text']],
  ]);
  assert.deepEqual([tab.frameOf('ref_10'), tab.frameOf('ref_20'), tab.frameOf('ref_31')], ['', 'F1', 'F2']);
  // the owner matches no attached frame (still loading): nothing matches yet
  tab.wc.ops.query = () => ({ hop: 'ref_77', rest: [] });
  assert.deepEqual(await drive(t, h.tabs.query(tab, steps)), { sessionId: '', refs: [], count: 0, desc: [] });
  // an aria-ref step starts in the frame the ref came from
  tab.noteRef('ref_40', 'F1');
  seen.length = 0;
  tab.wc.ops.query = (_args: any, s?: string) => ((seen as any[]).push(s), { refs: ['ref_40'], count: 1, desc: ['x'] });
  assert.equal((await drive(t, h.tabs.query(tab, [{ k: 'ref', ref: 'ref_40' }]))).sessionId, 'F1');
  assert.deepEqual(seen, ['F1']);
  await assert.rejects(h.tabs.query(tab, [{ k: 'ref', ref: 'ref_404' }]), { code: 'stale_ref' });
});

test("inspect, focus and selectOptions run in the element's frame and report stale refs and errors", async (t) => {
  const h = setup(t);
  const tab = framedTab(t, h);
  tab.noteRef('ref_11', 'F1');
  tab.wc.ops.inspect = (args: any, s?: string) => args.refs.map((r: string) => `${r}:${args.what}:${args.name}:${s}`);
  assert.deepEqual(await drive(t, h.tabs.inspect(tab, 'F1', ['ref_11'], 'attr', 'href')), ['ref_11:attr:href:F1']);
  tab.wc.ops.focus = (args: any, s?: string) => (s === 'F1' && args.ref === 'ref_11' ? { ok: true } : { error: 'stale' });
  await drive(t, h.tabs.focus(tab, 'ref_11'));
  tab.noteRef('ref_1', '');
  await assert.rejects(drive(t, h.tabs.focus(tab, 'ref_1')), { code: 'stale_ref' });
  tab.wc.ops.select = (args: any) =>
    args.ref === 'ref_1'
      ? { error: 'stale' }
      : args.wants[0] === 'bad'
        ? { error: 'No option matches "bad".' }
        : { ok: true, values: args.wants };
  assert.deepEqual(await drive(t, h.tabs.selectOptions(tab, 'ref_11', ['a', { index: 1 }])), ['a', { index: 1 }]);
  await assert.rejects(drive(t, h.tabs.selectOptions(tab, 'ref_1', ['a'])), { code: 'stale_ref' });
  await assert.rejects(drive(t, h.tabs.selectOptions(tab, 'ref_11', ['bad'])), { code: 'bad_args', message: 'No option matches "bad".' });
  tab.wc.ops.select = () => undefined;
  await assert.rejects(drive(t, h.tabs.selectOptions(tab, 'ref_11', [])), TypeError);
  tab.wc.ops.focus = () => undefined;
  await drive(t, h.tabs.focus(tab, 'ref_11'));
});

test('waitForLoad: DOM parsed, loaded, or network idle; times out; a closed tab fails', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  let ready = 'loading';
  tab.wc.ops.state = () => ({ ready });
  const parsed = h.tabs.waitForLoad(tab, 'domcontentloaded', 5000);
  setTimeout(() => (ready = 'interactive'), 300);
  await drive(t, parsed);
  tab.wc.loading = true;
  ready = 'complete';
  const loaded = h.tabs.waitForLoad(tab);
  setTimeout(() => (tab.wc.loading = false), 300);
  await drive(t, loaded);
  // network idle: no request in flight for 500 ms
  tab.inflight.add('x');
  tab.lastNet = Date.now();
  const idle = h.tabs.waitForLoad(tab, 'networkidle', 5000);
  setTimeout(() => {
    tab.inflight.clear();
    tab.lastNet = Date.now();
  }, 200);
  const started = Date.now();
  await drive(t, idle);
  assert.ok(Date.now() - started >= 700);
  // a page between documents (its agent fails) is not loaded: the wait times out, and says why its state was unknown
  tab.wc.handlers['Runtime.evaluate'] = () => {
    throw new Error('boom');
  };
  await assert.rejects(drive(t, h.tabs.waitForLoad(tab, 'load', 300)), {
    code: 'timeout',
    message: 'Timed out after 300 ms waiting for the page to reach "load". Its load state could not be read: boom',
  });
  tab.wc.handlers['Runtime.evaluate'] = () => {
    throw 'no context';
  };
  await assert.rejects(drive(t, h.tabs.waitForLoad(tab, 'load', 300)), {
    code: 'timeout',
    message: /Its load state could not be read: /,
  });
  // a page that reads as still loading times out without a reason to add
  delete tab.wc.handlers['Runtime.evaluate'];
  ready = 'loading';
  await assert.rejects(drive(t, h.tabs.waitForLoad(tab, 'load', 300)), {
    code: 'timeout',
    message: 'Timed out after 300 ms waiting for the page to reach "load".',
  });
  tab.wc.destroy();
  await assert.rejects(h.tabs.waitForLoad(tab, 'load', 300), { code: 'tab_closed' });
});

test('intent: by ref (in its frame), by point, or the focused element, following a cross-origin frame; unknown is null', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  tab.wc.debugger.event('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { type: 'iframe', targetId: 'frame-1' } });
  tab.wc.debugger.event('Target.attachedToTarget', { sessionId: 'F2', targetInfo: { type: 'iframe', targetId: 'frame-2' } });
  await flush();
  const asked: any[] = [];
  const answers: Record<string, any> = { '': { tag: 'button', name: 'Go' } };
  tab.wc.ops.intent = (args: any, sid?: string) => {
    asked.push([args, sid ?? '']);
    const a = answers[sid ?? ''];
    if (a instanceof Error) throw a;
    return a;
  };
  tab.noteRefs(['- button "Pay" [ref_7]'], 'F1');
  answers.F1 = { tag: 'button', name: 'Pay' };
  assert.deepEqual(await drive(t, h.tabs.intent(tab, { ref: 'ref_7' })), { tag: 'button', name: 'Pay' });
  assert.deepEqual(asked.pop(), [{ ref: 'ref_7' }, 'F1']);
  assert.equal(await drive(t, h.tabs.intent(tab, { ref: 'ref_404' })), null, 'a stale ref');
  assert.deepEqual(await drive(t, h.tabs.intent(tab, { point: { x: 3, y: 4 } })), { tag: 'button', name: 'Go' });
  assert.deepEqual(asked.pop(), [{ x: 3, y: 4 }, '']);
  assert.deepEqual(await drive(t, h.tabs.intent(tab)), { tag: 'button', name: 'Go' }, 'focus in the top frame');
  // focus in a cross-origin frame: the frame its owner names is asked (more in controlMatrixSensitiveFrames.test.ts)
  tab.wc.ownerFrames.ref_2 = 'frame-2';
  answers[''] = { frame: true, owner: 'ref_2' };
  answers.F2 = { tag: 'input', secret: true };
  asked.length = 0;
  assert.deepEqual(await drive(t, h.tabs.intent(tab, {})), { tag: 'input', secret: true });
  assert.deepEqual(asked, [
    [{}, ''],
    [{}, 'F2'],
  ]);
  answers[''] = null;
  assert.equal(await drive(t, h.tabs.intent(tab, {})), null);
  tab.wc.destroy();
  assert.equal(await drive(t, h.tabs.intent(tab, {})), null, 'a failure is unknown, never an error');
});

test('intent: a frame that cannot be followed is unreadable, never an element nor an error', async (t) => {
  const { UNREADABLE_FRAME } = createRequire(import.meta.url)('../electron/capabilities/browser/siteRisk.cjs');
  const h = setup(t);
  const tab = framedTab(t, h);
  await drive(t, tab.attach());
  const answers: Record<string, any> = { F1: { tag: 'button', name: 'Pay' } };
  tab.wc.ops.intent = (_args: any, sid?: string) => {
    const a = answers[sid ?? ''];
    if (a instanceof Error) throw a;
    return a;
  };
  const at = (o: any = {}) => drive(t, h.tabs.intent(tab, o));
  // input sent to a frame's own session starts there; one the tab doesn't know is unreadable
  assert.deepEqual(await at({ point: { x: 1, y: 2 }, session: 'F1' }), { tag: 'button', name: 'Pay' });
  assert.equal(await at({ point: { x: 1, y: 2 }, session: 'F9' }), UNREADABLE_FRAME);
  // a frame marker without an owner (an older page agent)
  answers[''] = { frame: true };
  assert.equal(await at(), UNREADABLE_FRAME);
  // the frame went away while it was read
  answers[''] = { frame: true, owner: 'ref_10' };
  answers.F1 = new Error('frame gone');
  clearIgnored();
  assert.equal(await at(), UNREADABLE_FRAME);
  assert.match(recentIgnored().at(-1).context, /inside a frame/);
  // a frame in its parent's process holding an out-of-process one: followed through both
  answers[''] = { frame: true, owner: 'ref_30' };
  tab.wc.ownerFrames.ref_30 = 'same-site';
  answers['inproc:same-site'] = { frame: true, owner: 'ref_31' };
  tab.wc.ownerFrames.ref_31 = 'frame-2';
  answers.F2 = { tag: 'input', secret: true };
  assert.deepEqual(await at(), { tag: 'input', secret: true });
  // an owner whose element is gone
  answers['inproc:same-site'] = { frame: true, owner: 'ref_gone' };
  assert.equal(await at(), UNREADABLE_FRAME);
  // frames that point back at themselves stop after a bounded number of hops
  tab.frames.set('S', { sessionId: 'S', parent: 'S', frameId: 'frame-s', world: null, ownerRef: 'ref_s' });
  tab.wc.ownerFrames.ref_s = 'frame-s';
  answers.S = { frame: true, owner: 'ref_s' };
  assert.equal(await at({ session: 'S' }), UNREADABLE_FRAME);
});

test("childFrame and agentAt: a frame element leads to its own session or to its frame in the parent's process; a missing owner, a non-frame or a script failure is an error", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  tab.wc.ownerFrames.ref_3 = 'inner';
  tab.wc.ops.probe = (args: any, sid?: string) => ({ args, sid });
  tab.wc.seq = 77;
  const inner = await drive(t, tab.childFrame({ sessionId: '' }, 'ref_3'));
  assert.deepEqual(inner, { sessionId: '', frameId: 'inner' });
  assert.equal(tab.wc.debugger.sent('Runtime.releaseObject').length, 1, 'the element handle is let go');
  // letting go fails when the frame is gone: noted, and the frame is still found
  tab.wc.handlers['Runtime.releaseObject'] = () => {
    throw new Error('frame gone');
  };
  clearIgnored();
  assert.deepEqual(await drive(t, tab.childFrame({ sessionId: '' }, 'ref_3')), inner);
  assert.match(recentIgnored().at(-1).context, /let go of a frame element/);
  assert.deepEqual(await drive(t, tab.agentAt(inner, 'probe', { a: 1 })), { args: { a: 1 }, sid: 'inproc:inner' });
  // the frame in a same-process frame's own process: the session's main world
  assert.deepEqual(await drive(t, tab.agentAt({ sessionId: '' }, 'probe', {})), { args: {}, sid: undefined });
  assert.equal(tab.refSeq, 77, 'refs made there never repeat');
  await assert.rejects(drive(t, tab.childFrame({ sessionId: '' }, 'ref_none')), { code: 'stale_ref' });
  tab.wc.ownerFrames.ref_div = '';
  await assert.rejects(drive(t, tab.childFrame({ sessionId: '' }, 'ref_div')), { code: 'failed', message: /Couldn't find this frame/ });
  /** the fake's own answer, under the handler that replaces it */
  const plain = (method: string, p: any, sid?: string) => {
    const mine = tab.wc.handlers[method];
    delete tab.wc.handlers[method];
    try {
      return tab.wc.cdp(method, p, sid);
    } finally {
      tab.wc.handlers[method] = mine;
    }
  };
  const failing = (answer: any) => (p: any, sid?: string) =>
    p.expression.includes('.call("probe"') && !p.expression.startsWith('globalThis') ? answer : plain('Runtime.evaluate', p, sid);
  tab.wc.handlers['Runtime.evaluate'] = failing({ exceptionDetails: { exception: { description: 'TypeError: boom' } } });
  await assert.rejects(drive(t, tab.agentAt(inner, 'probe')), { code: 'failed', message: /TypeError: boom/ });
  tab.wc.handlers['Runtime.evaluate'] = failing({ exceptionDetails: { text: 'Uncaught' } });
  await assert.rejects(drive(t, tab.agentAt(inner, 'probe')), { message: /Uncaught/ });
  tab.wc.handlers['Runtime.evaluate'] = failing({});
  assert.equal(await drive(t, tab.agentAt(inner, 'probe')), undefined, 'no answer');
});
