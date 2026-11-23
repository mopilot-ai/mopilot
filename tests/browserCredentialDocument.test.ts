// Credential document ownership at real Tab and relay dispatch, using only in-memory synthetic transports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick, deferred, fixture, actualAgent, moved, clean } from './helpers/credentialDocumentHarness.ts';
const require = createRequire(import.meta.url);
const { RelayDebugger } = require('../electron/capabilities/browser/chromeTab.cjs');
test('a same-URL navigation after focus cannot dispatch credential input', async () => {
  const h = fixture();
  const focus = deferred();
  const agent = h.tab.agent;
  h.tab.agent = (op: string) => (op === 'credentialFocus' ? focus.promise : agent(op));
  const p = h.start();
  await tick();
  h.answer();
  await tick();
  h.wc.emit('did-start-navigation', {}, h.tab.url, false, true);
  focus.resolve({ ok: true });
  assert.match(await p, /status: origin_changed/);
  assert.deepEqual(h.sent, []);
});
test('a navigation while Tab.attach is pending cannot dispatch credential input', async () => {
  const h = fixture();
  const attach = deferred();
  h.tab.attach = () => attach.promise;
  const p = h.start();
  await tick();
  h.answer();
  await tick();
  h.wc.emit('did-start-navigation', {}, h.tab.url, false, true);
  attach.resolve();
  assert.match(await p, /status: origin_changed/);
  assert.deepEqual(h.sent, []);
});
test('a navigation while relay attachment is pending cannot dispatch credential input', async () => {
  const h = fixture();
  const ready = deferred();
  const debuggerRelay = new RelayDebugger({
    relay: {
      cdp: async () => {
        h.sent.push('relay');
      },
    },
    tabId: 2,
  });
  Object.assign(debuggerRelay, { attached: true, ready: ready.promise, tok: { chatId: 'synthetic', turn: 1 } });
  debuggerRelay.contents = Object.assign(h.wc, debuggerRelay.contents);
  h.wc.debugger = debuggerRelay;
  const p = h.start();
  await tick();
  h.answer();
  await tick();
  h.wc.emit('did-start-navigation', {}, h.tab.url, false, true);
  ready.resolve();
  assert.match(await p, /status: origin_changed/);
  assert.deepEqual(h.sent, []);
});

test('healthy actual agent submits and intentional navigation retains the filled outcome', async () => {
  const h = fixture();
  actualAgent(h, (method, params) => {
    if (method === 'Runtime.evaluate' && params.expression.includes('"submit":true')) moved(h);
  });
  const p = h.start(true);
  await tick();
  h.answer();
  assert.match(await p, /status: filled/);
  assert.equal(h.sent.filter((m) => m === 'Input.insertText').length, 1);
  assert.ok(!h.sent.includes('Input.dispatchKeyEvent'));
  clean(h);
});
test('takeover hands the tab to the user and returns at once, whatever the page does next (#1834)', async () => {
  const h = fixture();
  const handed: any[] = [];
  h.tabs.requestSignin = (tab: any, o: any) => void handed.push([tab, o]);
  const p = h.start();
  await tick();
  h.handoff.answer(h.handoff.list()[0].id, { action: 'takeover' });
  await tick();
  moved(h);
  assert.match(await p, /status: user_took_over\nThe user is signing in on the page themselves\. End your turn now\./);
  assert.deepEqual(
    handed.map(([, o]) => o.credential),
    [true],
  );
  clean(h);
});
for (const event of [
  'Page.frameStartedNavigating',
  'Page.frameStartedLoading',
  'Page.frameNavigated',
  'Page.navigatedWithinDocument',
  'Page.frameDetached',
  'Runtime.executionContextsCleared',
  'Runtime.executionContextDestroyed',
  'Target.detachedFromTarget',
]) {
  test(`${event} invalidates the approved snapshot, including reused frame identifiers`, async () => {
    const h = fixture();
    const p = h.start();
    await tick();
    h.wc.debugger.emit('message', {}, event, { frame: { id: 'reused' }, executionContextId: 1, sessionId: 'reused' }, 'reused');
    assert.match(await p, /status: origin_changed/);
    assert.deepEqual(h.sent, []);
    clean(h);
    const next = h.start();
    await tick();
    h.answer();
    assert.match(await next, /status: filled/);
    clean(h);
  });
}
for (const stage of ['detect', 'focus']) {
  for (const event of ['destroyed', 'render-process-gone', 'detach', 'abort']) {
    test(`${event} settles unanswered ${stage} and blocks its late success`, async () => {
      const h = fixture();
      const pending = deferred();
      const original = h.tab.agent;
      const abort = new AbortController();
      h.tab.agent = (op: string) => (op === (stage === 'detect' ? 'credentialFields' : 'credentialFocus') ? pending.promise : original(op));
      const p = h.start(false, abort.signal);
      const outcome = p.then(
        (v: string) => v,
        (e: any) => e.code,
      );
      await tick();
      if (stage === 'focus') {
        h.answer();
        await tick();
      }
      if (event === 'abort') abort.abort();
      else if (event === 'detach') h.wc.debugger.emit(event);
      else h.wc.emit(event);
      const out = await outcome;
      if (event === 'destroyed') assert.equal(out, 'tab_closed');
      else if (event === 'abort') assert.equal(out, 'aborted');
      else assert.match(out, /origin_changed/);
      clean(h);
      pending.resolve({ origin: 'https://approved.example', fields: [{ ref: 'f1', kind: 'password' }], ok: true });
      await tick();
      assert.deepEqual(h.sent, []);
      clean(h);
    });
  }
}
test('subframe navigation and unrelated debugger events do not retire healthy input', async () => {
  const h = fixture();
  const p = h.start();
  await tick();
  h.wc.emit('did-start-navigation', {}, 'https://frame.example', false, false);
  h.wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', {}, '');
  h.answer();
  assert.match(await p, /status: filled/);
  clean(h);
});
test('initial loading, already-aborted and destroyed documents never show approval', async () => {
  for (const condition of ['loading', 'destroyed', 'aborted']) {
    const h = fixture();
    const abort = new AbortController();
    if (condition === 'loading') h.wc.isLoadingMainFrame = () => true;
    if (condition === 'destroyed') h.wc.isDestroyed = () => true;
    if (condition === 'aborted') abort.abort();
    const out = await h.start(false, abort.signal).catch((e: any) => e.code);
    if (condition === 'loading') assert.match(out, /origin_changed/);
    else assert.equal(out, condition === 'destroyed' ? 'tab_closed' : 'aborted');
    assert.deepEqual(h.sent, []);
    clean(h);
  }
});
test('late context rejection and late world-install success cannot overwrite a replacement world', async () => {
  for (const reject of [false, true]) {
    const h = fixture();
    const pending = deferred();
    const real = actualAgent(h, (method) =>
      method === 'Runtime.evaluate'
        ? pending.promise
        : method === 'Page.getFrameTree'
          ? { frameTree: { frame: { id: 'main' } } }
          : { executionContextId: 1 },
    );
    if (!reject) real.world = null;
    const p = h.start();
    await tick();
    moved(h);
    assert.match(await p, /origin_changed/);
    real.world = 900;
    if (reject) pending.reject(new Error('Cannot find context'));
    else pending.resolve({ result: { value: true } });
    await tick();
    assert.equal(real.world, 900);
    clean(h);
  }
});
test('ordinary noncredential commands retain healthy iframe and relay behavior', async () => {
  const h = fixture();
  let receipt = 0;
  await h.tab.send('Input.insertText', { text: 'NONSECRET_TEST_SENTINEL' }, 'frame:1', () => receipt++);
  assert.equal(receipt, 1);
  const relay = new RelayDebugger({ relay: { cdp: async (_tok: any, target: any) => target }, tabId: 2 });
  Object.assign(relay, { attached: true, ready: Promise.resolve(), tok: { chatId: 'synthetic', turn: 1 } });
  assert.deepEqual(await relay.sendCommand('Runtime.evaluate', {}, 'frame:1'), { tabId: 2, sessionId: 'frame:1' });
});

test('authorized save occurs once after a submitted page navigates, without exposing the value', async () => {
  const h = fixture();
  let saved = 0;
  h.handoff.store = {
    list: () => [],
    available: () => true,
    save: (origin: string, _username: string, password: string) => {
      assert.equal(origin, 'https://approved.example');
      assert.equal(password === 'NONSECRET_TEST_SENTINEL', true);
      saved++;
    },
  };
  actualAgent(h, (method, params) => {
    if (method === 'Runtime.evaluate' && params.expression.includes('"submit":true')) moved(h);
  });
  const p = h.start(true);
  await tick();
  h.handoff.answer(h.handoff.list()[0].id, { action: 'fill', values: { password: 'NONSECRET_TEST_SENTINEL' }, save: true });
  const result = await p;
  assert.match(result, /status: filled/);
  assert.equal(result.includes('NONSECRET_TEST_SENTINEL'), false);
  await tick();
  assert.equal(saved, 1);
  clean(h);
});

test('shared dispatch preserves renderer-crash and hung-page refusal, with no transport call', async () => {
  const h = fixture();
  h.wc.isCrashed = () => true;
  await assert.rejects(h.tab.send('Emulation.setDeviceMetricsOverride'), { code: 'page_crashed' });
  // every command that needs the renderer says "crashed, reload it" at once; the way back to a page still goes
  await assert.rejects(h.tab.send('Runtime.evaluate', { expression: '1' }), {
    code: 'page_crashed',
    message: 'This page crashed. Reload it (or open its address again) before continuing.',
  });
  await assert.rejects(h.tab.send('Input.dispatchMouseEvent'), { code: 'page_crashed' });
  // a malformed request is refused the same way, not with an internal error
  await assert.rejects(h.tab.send(undefined as never), { code: 'page_crashed' });
  for (const m of [
    'Page.reload',
    'Page.navigate',
    'Page.navigateToHistoryEntry',
    'Page.getNavigationHistory',
    'Page.stopLoading',
    'Target.getTargets',
  ])
    await h.tab.send(m);
  assert.deepEqual(h.sent, [
    'Page.reload',
    'Page.navigate',
    'Page.navigateToHistoryEntry',
    'Page.getNavigationHistory',
    'Page.stopLoading',
    'Target.getTargets',
  ]);
  h.sent.length = 0;
  h.wc.isCrashed = () => false;
  await h.tab.send('Emulation.clearDeviceMetricsOverride');
  h.tab.host.o.hang = { hung: () => true };
  await assert.rejects(h.tab.send('Input.insertText'), { code: 'page_unresponsive' });
  assert.deepEqual(h.sent, ['Emulation.clearDeviceMetricsOverride']);
});
test('a credential scope refuses a different contents even when its transport is healthy', async () => {
  const { withCredentialDocument, assertBrowserDispatch } = require('../electron/capabilities/browser/credentialDocument.cjs');
  const h = fixture();
  await assert.rejects(
    withCredentialDocument(h.wc, null, () => assertBrowserDispatch({})),
    { code: 'credential_document_changed' },
  );
  clean(h);
});

test('relay healthy top-frame dispatch receipts run once, after readiness', async () => {
  let receipts = 0;
  const ready = deferred();
  const relay = new RelayDebugger({ relay: { cdp: async () => ({ ok: true }) }, tabId: 2 });
  Object.assign(relay, { attached: true, ready: ready.promise, tok: { chatId: 'synthetic', turn: 1 } });
  const p = relay.sendGuardedCommand('Runtime.evaluate', {}, '', () => receipts++);
  await tick();
  assert.equal(receipts, 0);
  ready.resolve();
  await p;
  assert.equal(receipts, 1);
});
test('submission error and no-form Enter fallback retain their outcomes', async () => {
  for (const error of [false, true]) {
    const h = fixture();
    actualAgent(h, (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('"submit":true'))
        return { result: { value: { value: error ? { error: 'missing' } : { submitted: false } } } };
    });
    const p = h.start(true);
    await tick();
    h.answer();
    assert.match(await p, error ? /status: submission_failed/ : /status: filled/);
    assert.equal(h.sent.filter((m) => m === 'Input.dispatchKeyEvent').length, error ? 0 : 2);
    clean(h);
  }
});
test('decline, legacy origin notification and missing saved login never fill', async () => {
  for (const action of ['decline', 'origin_changed', 'missing_saved']) {
    const h = fixture();
    const p = h.start();
    await tick();
    if (action === 'origin_changed') {
      h.tab.url = 'https://replacement.example';
      h.wc.emit('did-navigate');
    } else h.handoff.answer(h.handoff.list()[0].id, action === 'decline' ? { action } : { action: 'fill', savedId: 'missing' });
    assert.match(
      await p,
      new RegExp(`status: ${action === 'decline' ? 'declined' : action === 'origin_changed' ? 'origin_changed' : 'submission_failed'}`),
    );
    assert.deepEqual(h.sent, []);
    clean(h);
  }
});
test('timed-out relay action cannot dispatch after readiness resolves', async (t) => {
  const { runAction } = require('../electron/capabilities/browser/hostUtil.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = deferred();
  let dispatched = 0;
  const relay = new RelayDebugger({
    relay: {
      cdp: async () => {
        dispatched++;
      },
    },
    tabId: 2,
  });
  Object.assign(relay, { attached: true, ready: ready.promise, tok: { chatId: 'synthetic', turn: 1 } });
  const p = runAction(() => relay.sendCommand('Input.insertText', { text: 'NONSECRET_TEST_SENTINEL' }), 10);
  const rejected = assert.rejects(p, { code: 'timeout' });
  await tick();
  t.mock.timers.tick(11);
  await rejected;
  ready.resolve();
  await tick();
  assert.equal(dispatched, 0);
});
test('submission world setup does not receive a submission receipt', async () => {
  const h = fixture();
  let real: any;
  real = actualAgent(h, (method, params) => {
    if (method === 'Runtime.evaluate' && params.expression.includes('credentialCheck') && !params.expression.includes('"submit":true'))
      real.world = null;
    if (method === 'Page.getFrameTree') {
      moved(h);
      return { frameTree: { frame: { id: 'main' } } };
    }
  });
  const p = h.start(true);
  await tick();
  h.answer();
  assert.match(await p, /status: origin_changed/);
  assert.equal(h.sent.filter((m) => m === 'Input.insertText').length, 1);
  clean(h);
});

test('relay lost while readiness is pending retires input and cleans listeners before a late answer', async () => {
  const h = fixture();
  const ready = deferred();
  const relay = new RelayDebugger(
    Object.assign(h.wc, {
      relay: {
        cdp: async () => {
          h.sent.push('relay');
        },
      },
      tabId: 2,
    }),
  );
  Object.assign(relay, { attached: true, ready: ready.promise, tok: { chatId: 'synthetic', turn: 1 } });
  h.wc.debugger = relay;
  const p = h.start();
  await tick();
  h.answer();
  await tick();
  relay.lost('target_closed');
  assert.match(await p, /origin_changed/);
  clean(h);
  assert.equal(relay.listenerCount('message'), 0);
  assert.equal(relay.listenerCount('detach'), 0);
  ready.resolve();
  await tick();
  assert.deepEqual(h.sent, []);
});
for (const boundary of ['attach', 'relay']) {
  test(`navigation during final submit ${boundary} wait cannot claim a submission receipt`, async () => {
    const h = fixture();
    const pending = deferred();
    let real: any;
    let relay: any;
    real = actualAgent(h, (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('credentialCheck') && !params.expression.includes('"submit":true')) {
        if (boundary === 'attach') real.attach = () => pending.promise;
        else relay.ready = pending.promise;
      }
    });
    if (boundary === 'relay') {
      const send = h.wc.debugger.sendCommand;
      relay = new RelayDebugger(
        Object.assign(h.wc, {
          relay: { cdp: (_tok: any, target: any, method: string, params: any) => send(method, params, target.sessionId) },
          tabId: 2,
        }),
      );
      Object.assign(relay, { attached: true, ready: Promise.resolve(), tok: { chatId: 'synthetic', turn: 1 } });
      h.wc.debugger = relay;
    }
    const p = h.start(true);
    await tick();
    h.answer();
    await tick();
    moved(h);
    assert.match(await p, /origin_changed/);
    const calls = h.sent.length;
    pending.resolve();
    await tick();
    assert.equal(h.sent.length, calls);
    assert.equal(h.sent.filter((m) => m === 'Input.insertText').length, 1);
    clean(h);
  });
}

test('details-first and legacy main-frame navigation both retire same-document approval', async () => {
  for (const details of [true, false]) {
    const h = fixture();
    const p = h.start();
    await tick();
    if (details) h.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    else h.wc.emit('did-start-navigation', {}, `${h.tab.url}#section`, true, true);
    assert.match(await p, /origin_changed/);
    assert.deepEqual(h.sent, []);
    clean(h);
  }
  const h = fixture();
  const p = h.start();
  await tick();
  h.wc.emit('did-start-navigation', { isMainFrame: false }, h.tab.url, false, true);
  h.answer();
  assert.match(await p, /filled/);
  clean(h);
});

test('independent approved requests may finish in reverse order without retiring each other', async () => {
  const h = fixture();
  const first = h.start();
  const second = h.start();
  await tick();
  const ids = h.handoff.list().map((item: any) => item.id);
  assert.equal(ids.length, 2);
  for (const [id, pending] of [
    [ids[1], second],
    [ids[0], first],
  ]) {
    h.handoff.answer(id, { action: 'fill', values: { password: 'NONSECRET_TEST_SENTINEL' } });
    assert.match(await pending, /status: filled/);
  }
  assert.equal(h.sent.length, 2);
  clean(h);
});
test('healthy credential input preserves the detected iframe session and separate origin approval', async () => {
  const h = fixture();
  h.tab.frames.set('frame:1', {});
  let session: string | undefined;
  const original = h.tab.agent;
  h.tab.agent = async (op: string, args: any, sid: string) =>
    op === 'credentialFields'
      ? sid
        ? { origin: 'https://frame.example', fields: [{ ref: 'f1', kind: 'password' }] }
        : { fields: [] }
      : original(op, args, sid);
  h.wc.debugger.sendCommand = async (_method: string, _params: any, sid: string) => {
    session = sid;
    return {};
  };
  const p = h.start();
  await tick();
  assert.equal(h.handoff.list()[0].frameOrigin, 'https://frame.example');
  h.answer();
  assert.match(await p, /status: filled/);
  assert.equal(session, 'frame:1');
  clean(h);
});
