// Independent issue1584 review: rendered BrowserPanel removes the exact retained input before a fresh main continuation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, fixture, container, setup as panelSetup, click, button } from './support/browser-panel-ui/fixture.ts';
import { setup } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
const { ControllerPlans, planInputs } = require('../electron/session/controllerPlan.cjs');
const { chatHandoffRoute } = require('../electron/capabilities/browser/handoff.cjs');
const {
  handoffContinuation,
  checkHandoffContinuation,
  installHandoffContinuationGuard,
} = require('../electron/capabilities/browser/handoffContinuation.cjs');
const { acceptSendReceipt } = require('../shared/sendReceipt.mjs');

test('pane retains the error, removes only that queued input, and sends fresh context exactly once', async () => {
  const h = setup();
  h.chats.records.set('agent-chat', { id: 'agent-chat', segments: [{ kind: 'codex', nativeId: 'native' }] });
  let relay = 'extension';
  let first = true;
  let reads = 0;
  const removals: any[] = [];
  const receipts: any[] = [];
  const names = ['chrome_tabs_context_mcp', 'chrome_navigate'];
  const plans = new ControllerPlans({
    ref: (id: string) => h.c.ref(id),
    inputs: planInputs({
      tools: () => names,
      yourChrome: () => false,
      codex: {
        channel: () => true,
        toolsOf: () => names,
        loadedPath: () => ({ chrome: false, tools: true }),
        nativeSurfaces: () => ({}),
        iabAvailable: () => false,
        chromeBackend: () => ({ serves: () => false, available: () => false }),
      },
      claude: { channel: () => true, nativeChromeOf: () => false, nativeChromeFor: () => false, toolsOf: () => names },
      acp: { channel: () => true, toolsOf: () => names },
    }),
  });
  const live = { controller: h.c, controllerPlans: plans };
  const routeOf = (id: string) => {
    const s = plans.snapshot(id);
    return chatHandoffRoute({
      plan: s.plan,
      tools: s.tools,
      channelEnabled: s.channel,
      relay: { kind: relay, toolsOn: () => true },
      channel: 'builtin',
      isEnabled: () => false,
    });
  };
  installHandoffContinuationGuard(live, routeOf);
  h.c.beforeDispatch = async () => {
    if (first) {
      first = false;
      relay = 'relay';
    }
  };
  await panelSetup({
    handlers: {
      handoffRoute: async () => routeOf('agent-chat'),
      continueInChrome: async ({ url }: any) => ({ ok: true, url, route: routeOf('agent-chat') }),
      handoffContinuation: async ({ chatId, url }: any) => {
        reads++;
        return handoffContinuation(live, routeOf, chatId, url);
      },
      removeQueued: async (chatId: string, id: string) => {
        removals.push([chatId, id]);
        return !!h.c.removeQueued(chatId, id);
      },
      sendMessage: async (chatId: string, text: string, attachments: any[], opts: any, callback: any) => {
        const item = { text, attachments, opts };
        checkHandoffContinuation(live, routeOf, chatId, item);
        const receipt = await h.c.send(chatId, item, 1, true);
        receipts.push(receipt);
        acceptSendReceipt(receipt);
        callback?.(receipt);
        return true;
      },
    },
  });
  // one click: the page opens in Chrome and the continuation goes out by itself
  await click('Continue in Chrome');
  assert.equal(receipts[0].action, 'queued');
  assert.match(receipts[0].error, /controller changed/);
  assert.equal(h.s('agent-chat').queue.length, 1);
  assert.equal(h.execs.length, 0);
  const oldId = h.s('agent-chat').queue[0].id;
  const oldToken = h.s('agent-chat').queue[0].opts.chromeHandoff.token;
  assert.match(container.querySelector('.browser-handoff')?.textContent || '', /queue/i);
  assert.equal((button('Continue task in Chrome') as HTMLButtonElement).disabled, true);
  await click('Continue task in Chrome');
  assert.equal(reads, 1);
  await click('Remove queued continuation and retry');
  assert.deepEqual(removals, [['agent-chat', oldId]]);
  assert.equal(h.s('agent-chat').queue.length, 0);
  assert.equal(h.execs.length, 0, 'removal alone never sends');
  assert.equal((button('Continue task in Chrome') as HTMLButtonElement).disabled, false);
  await click('Continue task in Chrome');
  assert.equal(reads, 2);
  assert.equal(h.execs.length, 1);
  assert.notEqual(h.execs[0].item.opts.chromeHandoff.token, oldToken);
  assert.equal(h.s('agent-chat').queue.length, 0);
  assert.equal(container.querySelector('.browser-handoff'), null);
  await act(() => h.c.end('agent-chat', { drain: false }));
});

test('a rejected prepare read from an unmounted pane cannot publish its old page error', async () => {
  const { deferred } = await import('./support/async-scenarios.ts');
  const panel = await import('./support/browser-panel-ui/fixture.ts');
  const pending = deferred<any>();
  await panelSetup();
  fixture.nativeHandlers.pageState = () => pending.promise;
  await click('Continue in Chrome');
  await act(() => panel.root.unmount());
  await act(async () => {
    pending.reject(new Error('old page'));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(container.querySelector('.browser-handoff'), null);
});

test('starting a replacement handoff immediately retires its older continuation read', async () => {
  let resolveOld!: (value: any) => void;
  let resolveNew!: (value: any) => void;
  let sends = 0;
  await panelSetup({
    handlers: {
      handoffRoute: async () => 'extension',
      continueInChrome: async ({ url }: any) => ({ ok: true, route: 'extension', url }),
      handoffContinuation: () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      sendMessage: async () => {
        sends++;
        return true;
      },
    },
  });
  await click('Continue in Chrome');
  assert.ok(resolveOld, 'the continuation read is pending');
  fixture.nativeHandlers.pageState = () =>
    new Promise((resolve) => {
      resolveNew = resolve;
    });
  await click('Continue in Chrome');
  assert.ok(resolveNew, 'the replacement handoff has started but its state read is pending');
  await act(() => resolveOld({ message: 'old continuation', precondition: { url: 'https://task.test/start', token: 'old' } }));
  assert.equal(sends, 0, 'replacement intent retires old read before replacement response arrives');
  await act(() => resolveNew({ pages: [], restartUrl: 'https://new.test/' }));
  assert.deepEqual(fixture.calls.findLast((c: any) => c[0] === 'continueInChrome')[1].url, 'https://new.test/');
  assert.equal(sends, 0);
});

for (const rejects of [false, true])
  test(`late cancellation ${rejects ? 'failure' : 'success'} of an older opening does not dismiss the replacement handoff`, async () => {
    let finishCancel!: (value: boolean) => void;
    let rejectCancel!: (error: Error) => void;
    let finishOpen!: (value: any) => void;
    await panelSetup({
      handlers: {
        handoffRoute: async () => 'extension',
        continueInChrome: () =>
          new Promise((resolve) => {
            finishOpen = resolve;
          }),
        cancelChromeHandoff: () =>
          new Promise((resolve, reject) => {
            finishCancel = resolve;
            rejectCancel = reject;
          }),
      },
    });
    await click('Continue in Chrome');
    await act(() => container.querySelector<HTMLButtonElement>('.browser-handoff button[aria-label="Cancel"]')!.click());
    assert.ok(finishCancel, 'cancel request is awaiting main');
    await act(async () => {
      finishOpen({ ok: true, route: 'extension', url: 'https://task.test/start' });
      await new Promise((resolve) => setImmediate(resolve));
    });
    fixture.nativeHandlers.pageState = async () => ({ pages: [], restartUrl: 'https://replacement.test/' });
    await click('Continue in Chrome');
    const opening = () => container.querySelector('.browser-handoff')?.textContent ?? '';
    assert.equal(fixture.calls.findLast((c: any) => c[0] === 'continueInChrome')[1].url, 'https://replacement.test/');
    assert.match(opening(), /Opening in Chrome/);
    await act(async () => {
      if (rejects) rejectCancel(new Error('old cancellation'));
      else finishCancel(true);
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.match(opening(), /Opening in Chrome/);
    assert.ok(!fixture.calls.some((c: any[]) => c[0] === 'toast' && String(c[1]).includes('old cancellation')));
  });
