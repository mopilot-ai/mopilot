// One browser host tab (electron/capabilities/browser/tab.cjs): its CDP session, throttling, page load signals,
// console, network and dialog events, frame sessions, the page agent world and refs. Timers and Date are mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BUFFER_MAX, PAGE_BACKDROP, raw, flush, drive, setup, tabOf, ownSetup } from './support/browser-host-kit.ts';

const { runBeforePage, AUTO_ATTACH } = createRequire(import.meta.url)('../electron/capabilities/browser/documentScripts.cjs');

/* ------------------------------------------------------------------ */
/* the CDP session                                                     */
/* ------------------------------------------------------------------ */

test('attach (CDP): the debugger is attached once, domains enabled best-effort, and an attached debugger is reused', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.handlers['Log.enable'] = () => {
    throw new Error('not supported');
  };
  await drive(t, tab.attach());
  await drive(t, tab.attach());
  const dbg = tab.wc.debugger;
  assert.equal(dbg.attaches, 1);
  assert.deepEqual(
    dbg.calls.filter(ownSetup).map((c) => c.method),
    [
      'Page.enable',
      'Runtime.enable',
      'Network.enable',
      'Log.enable',
      'Page.setInterceptFileChooserDialog',
      'Target.setAutoAttach',
      'Emulation.setDefaultBackgroundColorOverride',
    ],
  );
  assert.deepEqual(dbg.calls[5].params, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  // a page with no background of its own is shown (and captured) on the pane's white, not transparent
  assert.deepEqual(dbg.calls[6].params, { color: { r: 255, g: 255, b: 255, a: 1 } });
  assert.deepEqual(PAGE_BACKDROP, { color: { r: 255, g: 255, b: 255, a: 1 } });
  // already attached by someone else (sage_browser_*): not attached twice
  const other = tabOf(h, 'tab_bbbbbb');
  other.wc.debugger.attached = true;
  await drive(t, other.attach());
  assert.equal(other.wc.debugger.attaches, 0);
  // a CDP detach (DevTools took over) forgets the agent's worlds; the next attach listens again
  tab.world = 3;
  tab.wc.debugger.emit('detach');
  assert.equal(tab.world, null);
  assert.equal(tab.listening, false);
  // its listeners go with it, so attaching again (after any number of detaches) listens once, not once per detach
  assert.equal(tab.wc.debugger.listenerCount('message'), 0);
  tab.wc.debugger.attached = false;
  await drive(t, tab.attach());
  tab.wc.debugger.emit('detach');
  tab.wc.debugger.attached = false;
  await drive(t, tab.attach());
  assert.equal(tab.wc.debugger.listenerCount('message'), 2, "the tab's own and its WebMCP catalog's (webmcp.cjs)");
  assert.equal(tab.wc.debugger.listenerCount('detach'), 1);
  // a page that went away has no debugger to unhook: the tab still forgets its CDP state
  other.listening = true;
  other.wc.destroyed = true;
  other.onDetach();
  assert.equal(other.listening, false);
});

test('send: commands go to the top frame or a frame session, after checking the target', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.handlers['X.cmd'] = (p: any, s?: string) => ({ p, s });
  assert.deepEqual(await drive(t, tab.send('X.cmd', { a: 1 })), { p: { a: 1 }, s: undefined });
  assert.deepEqual(await drive(t, tab.send('X.cmd', undefined, 'S1')), { p: {}, s: 'S1' });
  tab.closed = true;
  await assert.rejects(tab.send('X.cmd'), { code: 'tab_closed' });
});

test('hold and detach: throttling is off while an agent holds a tab and restored when it lets go', (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  h.log.changes.length = 0;
  tab.hold();
  tab.hold();
  assert.deepEqual(tab.wc.throttling, [false]);
  assert.deepEqual(h.log.changes, ['c']);
  tab.wc.debugger.attached = true;
  tab.world = 1;
  tab.frames.set('S', {});
  tab.emulated = { w: 1 };
  tab.fileChooser = { mode: 'selectSingle' };
  tab.detach();
  assert.equal(tab.wc.debugger.attached, false);
  assert.deepEqual(tab.wc.throttling, [false, true]);
  assert.deepEqual([tab.held, tab.world, tab.frames.size, tab.emulated, tab.fileChooser], [false, null, 0, null, null]);
  // the emulation ending and the hold going are both announced (the pane drops its device badge)
  assert.deepEqual(h.log.changes, ['c', 'c', 'c']);
  // a second detach: nothing held, nothing to announce; detach and throttling failures are ignored
  tab.wc.debugger.attached = true;
  tab.wc.debugger.detachThrows = true;
  tab.wc.throttleThrows = true;
  tab.detach();
  assert.deepEqual(h.log.changes, ['c', 'c', 'c']);
  tab.hold();
  assert.equal(tab.held, true);
  // a destroyed page: no debugger to touch, nothing to hold
  tab.wc.destroyed = true;
  tab.detach();
  assert.equal(tab.held, false);
  tab.hold();
  assert.equal(tab.held, false);
  assert.equal(tab.url, '');
  assert.equal(tab.title, '');
});

test('page load signals: a main-frame failure is remembered until the next load; aborts and subframes are not failures', (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  h.log.changes.length = 0;
  tab.wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'u', true);
  tab.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'u', false);
  assert.equal(tab.failure, null);
  tab.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'u', true);
  assert.equal(tab.failure, 'ERR_NAME_NOT_RESOLVED');
  tab.wc.emit('did-start-loading');
  assert.equal(tab.failure, null);
  tab.wc.emit('did-fail-load', {}, -2, '', 'u', true);
  assert.equal(tab.failure, '-2');
  tab.wc.emit('did-navigate');
  tab.wc.emit('did-navigate-in-page');
  assert.deepEqual(h.log.changes, ['c', 'c'], 'the pane hears about page changes');
});

test('CDP events: console, exceptions and log entries are buffered with level and source (at most BUFFER_MAX)', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  const ev = (m: string, p?: any, s?: string) => tab.wc.debugger.event(m, p, s);
  ev('Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ value: 'hi' }, { value: { a: 1 } }, { unserializableValue: 'NaN' }, { description: 'Error: x' }, { type: 'undefined' }],
    stackTrace: { callFrames: [{ url: 'https://a.test/app.js', lineNumber: 9 }] },
  });
  ev('Runtime.consoleAPICalled', { type: 'error' });
  ev('Runtime.consoleAPICalled', { type: 'assert', args: [] });
  ev('Runtime.consoleAPICalled', { type: 'warning', args: [] });
  ev('Runtime.consoleAPICalled', { type: 'debug', args: [] });
  ev('Runtime.consoleAPICalled', { type: 'info', args: [] });
  // the passkey watch's reports to main stay out of the page's console log
  ev('Runtime.consoleAPICalled', { type: 'debug', args: [{ value: 'mopilot-passkey:1' }] });
  ev('Runtime.exceptionThrown', {
    exceptionDetails: { exception: { description: 'TypeError: y' }, url: 'https://a.test/b.js', lineNumber: 4 },
  });
  ev('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', url: 'https://a.test/c.js' } });
  ev('Runtime.exceptionThrown', {});
  ev('Log.entryAdded', { entry: { level: 'warning', text: 'w', url: 'https://a.test/' } });
  ev('Log.entryAdded', { entry: { level: 'error', source: 'network' } });
  ev('Log.entryAdded', { entry: { level: 'verbose', text: 'v' } });
  ev('Log.entryAdded', { entry: { level: 'info', text: 'i' } });
  ev('Log.entryAdded', undefined);
  assert.deepEqual(
    tab.console.map((e: any) => [e.level, e.text, e.source]),
    [
      ['log', 'hi {"a":1} NaN Error: x undefined', 'https://a.test/app.js:10'],
      ['error', '', ''],
      ['error', '', ''],
      ['warning', '', ''],
      ['debug', '', ''],
      ['log', '', ''],
      ['error', 'TypeError: y', 'https://a.test/b.js:5'],
      ['error', 'Uncaught', 'https://a.test/c.js:1'],
      ['error', 'Uncaught exception', ''],
      ['warning', 'w', 'https://a.test/'],
      ['error', '', 'network'],
      ['debug', 'v', ''],
      ['log', 'i', ''],
      ['log', '', ''],
    ],
  );
  for (let i = 0; i < BUFFER_MAX; i++) ev('Runtime.consoleAPICalled', { type: 'log', args: [{ value: `m${i}` }] });
  assert.equal(tab.console.length, BUFFER_MAX);
  assert.equal(tab.console[0].text, 'm0');
  // filters: errors only, a pattern, a limit
  assert.equal(
    h.tabs
      .console(tab, { limit: 2 })
      .map((e: any) => e.text)
      .join(),
    `m${BUFFER_MAX - 2},m${BUFFER_MAX - 1}`,
  );
  assert.equal(h.tabs.console(tab, { pattern: 'M49' }).length, 11);
  assert.equal(h.tabs.console(tab, { onlyErrors: true }).length, 0);
  assert.equal(h.tabs.console(tab).length, 100);
  assert.equal(h.tabs.console(tab, { limit: 0 }).length, 1);
  ev('Unknown.event', {});
});

test('CDP events: network requests are logged per frame session, redirects update in place, and the log is capped', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  t.mock.timers.tick(1000);
  const ev = (m: string, p?: any, s?: string) => tab.wc.debugger.event(m, p, s);
  ev('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: 'https://a.test/api?token=x' }, type: 'XHR' });
  ev('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://a.test/redirected' }, type: 'XHR' });
  ev('Network.requestWillBeSent', { requestId: 'ws', type: 'WebSocket' });
  ev('Network.requestWillBeSent', { requestId: 'r2' }, 'S1');
  assert.deepEqual([...tab.inflight], [':r1', 'S1:r2']);
  assert.equal(tab.lastNet, 1000);
  t.mock.timers.tick(20);
  ev('Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'application/json' } });
  ev('Network.responseReceived', { requestId: 'r2', response: {} }, 'S1');
  ev('Network.responseReceived', { requestId: 'nope' });
  ev('Network.loadingFinished', { requestId: 'r1' });
  ev('Network.loadingFailed', { requestId: 'r2', canceled: true }, 'S1');
  ev('Network.loadingFailed', { requestId: 'ws', errorText: 'net::ERR_FAILED' });
  ev('Network.loadingFailed', { requestId: 'nope' });
  ev('Network.requestWillBeSent', { requestId: 'r3', request: { url: 'https://a.test/3' } });
  ev('Network.loadingFailed', { requestId: 'r3' });
  assert.equal(tab.inflight.size, 0);
  const list = h.tabs.requests(tab);
  assert.deepEqual(
    list.map((r: any) => [r.id, r.method, r.url, r.type, r.status, r.mime, r.error, r.ms]),
    [
      ['r1', 'GET', 'https://a.test/redirected', 'XHR', 200, 'application/json', null, 20],
      ['ws', 'GET', '', 'WebSocket', null, '', 'net::ERR_FAILED', 20],
      ['r2', 'GET', '', '', null, '', 'canceled', 20],
      ['r3', 'GET', 'https://a.test/3', '', null, '', 'failed', 0],
    ],
  );
  assert.deepEqual(
    h.tabs.requests(tab, { urlPattern: 'redirected' }).map((r: any) => r.id),
    ['r1'],
  );
  assert.deepEqual(
    h.tabs.requests(tab, { limit: 1 }).map((r: any) => r.id),
    ['r3'],
  );
  for (let i = 0; i < BUFFER_MAX; i++) ev('Network.requestWillBeSent', { requestId: `n${i}`, type: 'Image' });
  assert.equal(tab.network.size, BUFFER_MAX);
  assert.equal(tab.network.has(':r1'), false, 'the oldest requests leave the log');
  assert.equal(h.tabs.requests(tab, { limit: 9999 }).length, BUFFER_MAX);
});

test("response bodies: text or a binary size, from the request's frame session; unknown ids fail", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  tab.wc.debugger.event('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://a.test/' } }, 'S1');
  tab.wc.debugger.event('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://a.test/i.png' } });
  tab.wc.handlers['Network.getResponseBody'] = (p: any, s?: string) =>
    p.requestId === 'r1' ? { body: `text from ${s}`, base64Encoded: false } : { body: 'AAAA', base64Encoded: true };
  assert.equal((await drive(t, h.tabs.responseBody(tab, 'r1'))).body, 'text from S1');
  const bin = await drive(t, h.tabs.responseBody(tab, 'r2'));
  assert.equal(bin.body, '(binary, 3 bytes)');
  assert.equal(bin.request.url, 'https://a.test/i.png');
  await assert.rejects(h.tabs.responseBody(tab, 'zz'), { code: 'bad_args', message: "No request zz in this tab's log." });
});

test("a turn joining a page's debugger takes up the frames its early script attached before (CDP reports them only once)", async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const dbg = tab.wc.debugger;
  // the page's passkey wrapper (documentScripts.cjs) holds the debugger from the start, and a frame came meanwhile
  runBeforePage(tab.wc, 'S');
  dbg.event('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { type: 'iframe', targetId: 'frame-1' } });
  dbg.event('Target.attachedToTarget', { sessionId: 'F2', targetInfo: { type: 'iframe', targetId: 'frame-2' } }, 'F1');
  await flush();
  dbg.calls.length = 0;
  await drive(t, tab.attach());
  assert.equal(dbg.attaches, 1);
  assert.deepEqual(tab.frames.get('F1'), { sessionId: 'F1', parent: '', frameId: 'frame-1', world: null, ownerRef: null });
  assert.deepEqual(tab.frames.get('F2'), { sessionId: 'F2', parent: 'F1', frameId: 'frame-2', world: null, ownerRef: null });
  assert.deepEqual(
    dbg.calls.filter((c) => c.sessionId === 'F2' && ownSetup(c)).map((c) => c.method),
    ['Page.enable', 'Runtime.enable', 'Network.enable', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'],
  );
  // both clients run auto-attach the same way, so neither undoes the other's
  assert.deepEqual(dbg.sent('Target.setAutoAttach').at(-1).params, AUTO_ATTACH);
  // a frame the tab already has is not set up twice
  tab.detach();
  tab.frames.set('F1', { sessionId: 'F1', parent: '', frameId: 'frame-1', world: 3, ownerRef: null });
  dbg.calls.length = 0;
  await drive(t, tab.attach());
  assert.equal(tab.frames.get('F1').world, 3);
});

test('CDP events: iframe targets get their own session and world; other targets are just resumed', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  const dbg = tab.wc.debugger;
  dbg.calls.length = 0;
  tab.wc.handlers['Runtime.runIfWaitingForDebugger'] = () => {
    throw new Error('gone');
  };
  dbg.event('Target.attachedToTarget', { sessionId: 'W1', targetInfo: { type: 'worker' } });
  dbg.event('Target.attachedToTarget', { sessionId: 'X1' });
  dbg.event('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { type: 'iframe', targetId: 'frame-1' } });
  dbg.event('Target.attachedToTarget', { sessionId: 'F2', targetInfo: { type: 'iframe', targetId: 'frame-2' } }, 'F1');
  await flush();
  assert.deepEqual(
    dbg.calls.filter(ownSetup).map((c) => [c.method, c.sessionId]),
    [
      ['Runtime.runIfWaitingForDebugger', 'W1'],
      ['Runtime.runIfWaitingForDebugger', 'X1'],
      ['Page.enable', 'F1'],
      ['Runtime.enable', 'F1'],
      ['Network.enable', 'F1'],
      ['Target.setAutoAttach', 'F1'],
      ['Runtime.runIfWaitingForDebugger', 'F1'],
      ['Page.enable', 'F2'],
      ['Runtime.enable', 'F2'],
      ['Network.enable', 'F2'],
      ['Target.setAutoAttach', 'F2'],
      ['Runtime.runIfWaitingForDebugger', 'F2'],
    ],
  );
  assert.deepEqual(tab.frames.get('F2'), { sessionId: 'F2', parent: 'F1', frameId: 'frame-2', world: null, ownerRef: null });

  // worlds go with their contexts
  tab.world = 5;
  tab.frames.get('F1').world = 6;
  dbg.event('Runtime.executionContextDestroyed', { executionContextId: 99 });
  dbg.event('Runtime.executionContextDestroyed', { executionContextId: 99 }, 'F1');
  dbg.event('Runtime.executionContextDestroyed', { executionContextId: 1 }, 'NOPE');
  assert.deepEqual([tab.world, tab.frames.get('F1').world], [5, 6]);
  dbg.event('Runtime.executionContextDestroyed', { executionContextId: 6 }, 'F1');
  assert.equal(tab.frames.get('F1').world, null);
  dbg.event('Runtime.executionContextDestroyed', { executionContextId: 5 });
  assert.equal(tab.world, null);
  tab.world = 5;
  tab.frames.get('F1').world = 6;
  dbg.event('Runtime.executionContextsCleared', {}, 'F1');
  dbg.event('Runtime.executionContextsCleared', {}, 'NOPE');
  assert.deepEqual([tab.world, tab.frames.get('F1').world], [5, null]);
  dbg.event('Runtime.executionContextsCleared');
  assert.equal(tab.world, null);
  // a top-level navigation drops the world and a pending file chooser; frames navigating don't
  tab.world = 7;
  tab.fileChooser = { mode: 'selectSingle' };
  dbg.event('Page.frameNavigated', { frame: { parentId: 'main' } });
  dbg.event('Page.frameNavigated', { frame: {} }, 'F1');
  assert.equal(tab.world, 7);
  dbg.event('Page.frameNavigated', { frame: { id: 'main' } });
  assert.deepEqual([tab.world, tab.fileChooser], [null, null]);
  dbg.event('Target.detachedFromTarget', { sessionId: 'F2' });
  assert.equal(tab.frames.has('F2'), false);
});

test('CDP events: alerts are accepted and reported, beforeunload is left to will-prevent-unload; other dialogs block', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  const dbg = tab.wc.debugger;
  dbg.calls.length = 0;
  tab.wc.handlers['Page.handleJavaScriptDialog'] = () => {
    throw new Error('No dialog is showing');
  };
  dbg.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'in a frame' }, 'F1');
  assert.equal(tab.dialog, null, 'frame sessions do not report dialogs');
  dbg.event('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved\nok' });
  dbg.event('Page.javascriptDialogOpening', { type: 'alert' });
  // Electron answers a beforeunload before CDP hears of it (windows.cjs decides it): nothing to answer, nothing blocks
  tab.navigating = true;
  dbg.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: '' });
  tab.navigating = false;
  dbg.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: '' });
  assert.equal(tab.dialog, null);
  await flush();
  assert.equal(dbg.sent('Page.handleJavaScriptDialog').length, 2);
  assert.match(h.tabs.state('c'), /changes: alert dialog on tab_aaaaaa accepted: "Saved ok"; alert dialog on tab_aaaaaa accepted\n/);
  const seen: any[] = [];
  tab.dialogWaiters.add((d: any) => seen.push(d));
  dbg.event('Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?', defaultPrompt: 'x', url: 'https://a.test/' });
  assert.deepEqual(tab.dialog, { type: 'prompt', message: 'Name?', defaultPrompt: 'x', url: 'https://a.test/' });
  assert.deepEqual(seen, [tab.dialog]);
  assert.equal(tab.dialogWaiters.size, 0);
  dbg.event('Page.javascriptDialogOpening', { type: 'confirm' });
  assert.deepEqual(tab.dialog, { type: 'confirm', message: '', defaultPrompt: '', url: '' });
  dbg.event('Page.javascriptDialogClosed', {}, 'F1');
  assert.ok(tab.dialog);
  dbg.event('Page.javascriptDialogClosed', {});
  assert.equal(tab.dialog, null);
  // a file chooser wakes waiters with no dialog
  tab.dialogWaiters.add((d: any) => seen.push(d));
  dbg.event('Page.fileChooserOpened', { mode: 'selectMultiple', backendNodeId: 12 }, 'F1');
  assert.deepEqual(tab.fileChooser, { mode: 'selectMultiple', backendNodeId: 12, frameSession: 'F1' });
  assert.equal(seen.at(-1), null);
  dbg.event('Page.fileChooserOpened', { mode: 'selectSingle' });
  assert.deepEqual(tab.fileChooser, { mode: 'selectSingle', backendNodeId: null, frameSession: '' });
});

/* ------------------------------------------------------------------ */
/* the agent world                                                     */
/* ------------------------------------------------------------------ */

test('agent: the world is created once per frame and navigation, ops carry the ref counter and raise it', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.seq = 7;
  tab.wc.ops.echo = (args: any, s?: string) => ({ args, s });
  assert.deepEqual(await drive(t, tab.agent('echo', { a: 1 })), { args: { a: 1 }, s: undefined });
  assert.equal(tab.refSeq, 7);
  assert.equal(tab.world, 1);
  tab.wc.seq = 3;
  await drive(t, tab.agent('echo'));
  assert.equal(tab.refSeq, 7, 'never lowered');
  assert.equal(tab.wc.debugger.sent('Page.createIsolatedWorld').length, 1);
  assert.deepEqual(tab.wc.debugger.sent('Page.createIsolatedWorld')[0].params, {
    frameId: 'main',
    worldName: 'mopilot-agent',
    grantUniveralAccess: false,
  });
  assert.deepEqual(
    tab.wc.agentCalls.map((c) => [c.op, c.contextId]),
    [
      ['echo', 1],
      ['echo', 1],
    ],
  );
  // a frame world
  tab.frames.set('F1', { sessionId: 'F1', parent: '', frameId: 'frame-1', world: null, ownerRef: null });
  assert.deepEqual(await drive(t, tab.agent('echo', {}, 'F1')), { args: {}, s: 'F1' });
  assert.equal(tab.frames.get('F1').world, 2);
  await assert.rejects(tab.agent('echo', {}, 'GONE'), { code: 'stale_ref', message: 'That frame is gone. Re-read the page.' });
  // no value at all, or no seq
  tab.wc.ops.nothing = () => raw(null);
  assert.equal(await drive(t, tab.agent('nothing')), undefined);
  tab.wc.ops.noseq = () => raw({ result: { value: { value: 'v' } } });
  assert.equal(await drive(t, tab.agent('noseq')), 'v');
});

test('agent: injecting the page script can fail', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  let n = 0;
  tab.wc.handlers['Runtime.evaluate'] = () =>
    n++ ? { exceptionDetails: { text: 'CSP' } } : { exceptionDetails: { exception: { description: 'EvalError: blocked' } } };
  await assert.rejects(drive(t, tab.agent('state')), { code: 'failed', message: "Couldn't read this page: EvalError: blocked" });
  await assert.rejects(drive(t, tab.agent('state')), { code: 'failed', message: "Couldn't read this page: CSP" });
});

test('agent: a lost context or a missing agent is retried once with a fresh world; other failures surface', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.frames.set('F1', { sessionId: 'F1', parent: '', frameId: 'frame-1', world: null, ownerRef: null });
  let fails = 1;
  tab.wc.ops.flaky = () => {
    if (fails-- > 0) throw new Error('Cannot find context with specified id');
    return 'ok';
  };
  assert.equal(await drive(t, tab.agent('flaky')), 'ok');
  assert.equal(tab.wc.debugger.sent('Page.createIsolatedWorld').length, 2);
  fails = 1;
  assert.equal(await drive(t, tab.agent('flaky', {}, 'F1')), 'ok');
  assert.equal(tab.frames.get('F1').world, 4);
  // the frame went away between the two attempts
  tab.wc.ops.frameGone = () => {
    tab.frames.delete('F1');
    throw new Error('session closed');
  };
  await assert.rejects(drive(t, tab.agent('frameGone', {}, 'F1')), { code: 'stale_ref' });
  tab.wc.ops.always = () => {
    throw new Error('Target closed');
  };
  await assert.rejects(drive(t, tab.agent('always')), { code: 'page_changed', message: 'The page changed while reading it. Try again.' });
  tab.wc.ops.other = () => {
    throw new Error('boom');
  };
  await assert.rejects(drive(t, tab.agent('other')), /boom/);
  tab.wc.ops.nonError = () => {
    throw 'plain';
  };
  await assert.rejects(drive(t, tab.agent('nonError')), (e: any) => e === 'plain');
  // the agent object missing (the page replaced the world): retried once, then reported
  let missing = 1;
  tab.wc.ops.missing = () =>
    missing-- > 0 ? raw({ exceptionDetails: { exception: { description: 'TypeError: globalThis.__mopilotAgent is undefined' } } }) : 'back';
  assert.equal(await drive(t, tab.agent('missing')), 'back');
  missing = 5;
  await assert.rejects(drive(t, tab.agent('missing')), {
    code: 'failed',
    message: /^The page script failed: TypeError: globalThis.__mopilotAgent/,
  });
  missing = 5;
  tab.frames.set('F3', { sessionId: 'F3', parent: '', frameId: 'frame-3', world: null, ownerRef: null });
  await assert.rejects(drive(t, tab.agent('missing', {}, 'F3')), { code: 'failed' });
  tab.wc.ops.thrown = () => raw({ exceptionDetails: { text: 'Uncaught' } });
  await assert.rejects(drive(t, tab.agent('thrown')), { code: 'failed', message: 'The page script failed: Uncaught' });
  tab.wc.ops.bare = () => raw({ exceptionDetails: {} });
  await assert.rejects(drive(t, tab.agent('bare')), { code: 'failed', message: 'The page script failed: error' });
});

test('refs: each ref remembers its frame; unknown refs, refs of gone frames and old refs are stale', (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.frames.set('F1', {});
  tab.noteRefs(['- button "A" [ref_1]', '- link [ref_2] - text [ref_3]'], '');
  tab.noteRefs(['- button "B" [ref_4]', '- button "A" [ref_1]'], 'F1');
  assert.equal(tab.frameOf('ref_2'), '');
  assert.equal(tab.frameOf('ref_4'), 'F1');
  assert.equal(tab.frameOf('ref_1'), 'F1', 'the latest frame wins');
  assert.throws(() => tab.frameOf('ref_9'), { code: 'stale_ref', message: /^ref_9 is stale or not found on the current page/ });
  assert.throws(() => tab.frameOf(5), { code: 'stale_ref' });
  tab.frames.delete('F1');
  assert.throws(() => tab.frameOf('ref_4'), { code: 'stale_ref' });
  // at most 20000 refs are remembered, the oldest go first
  const many = Array.from({ length: 20001 }, (_, i) => `[ref_${i + 100}]`);
  tab.noteRefs(many, '');
  assert.equal(tab.refFrame.size, 20000);
  assert.equal(tab.refFrame.has('ref_2'), false);
  assert.equal(tab.frameOf('ref_20100'), '');
});

test('ownerRef: the iframe element of a cross-origin frame gets a ref in its parent frame (cached)', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.refSeq = 4;
  const frame = { sessionId: 'F1', parent: '', frameId: 'frame-1', world: null, ownerRef: null };
  tab.wc.handlers['DOM.getFrameOwner'] = () => ({ backendNodeId: 33 });
  tab.wc.handlers['DOM.resolveNode'] = (p: any) => ({ object: { objectId: `obj-${p.backendNodeId}-${p.executionContextId}` } });
  let reply: any = { ref: 'ref_9', seq: 9 };
  tab.wc.handlers['Runtime.callFunctionOn'] = (p: any) => (reply === undefined ? {} : { result: { value: { ...reply, got: p } } });
  assert.equal(await drive(t, tab.ownerRef(frame)), 'ref_9');
  assert.equal(tab.refSeq, 9);
  assert.equal(tab.refFrame.get('ref_9'), '');
  assert.equal(frame.ownerRef, 'ref_9');
  const fn = tab.wc.debugger.sent('Runtime.callFunctionOn')[0].params;
  assert.equal(fn.objectId, 'obj-33-1');
  assert.deepEqual(fn.arguments, [{ value: 4 }]);
  assert.equal(await tab.ownerRef(frame), 'ref_9', 'cached');
  reply = { ref: 'ref_3', seq: 2 };
  const f2 = { ...frame, ownerRef: null };
  assert.equal(await drive(t, tab.ownerRef(f2)), 'ref_3');
  assert.equal(tab.refSeq, 9);
  reply = undefined;
  await assert.rejects(drive(t, tab.ownerRef({ ...frame, ownerRef: null })), {
    code: 'failed',
    message: "Couldn't find this frame on the page.",
  });
});
