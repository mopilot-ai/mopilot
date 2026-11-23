// Independent issue1584 review: real main producer, queue and Codex adapter drive a mounted BlockedStrip recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { native, mockStore, render, settle, setStore, resetStore, state } from './support/thread-kit.ts';
import { setup, tick } from './support/controller/fixture.ts';
import { renderer, sendMessage } from './support/handoff-renderer-send.ts';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { ControllerPlans, planInputs } = require('../electron/session/controllerPlan.cjs');
const { chatHandoffRoute } = require('../electron/capabilities/browser/handoff.cjs');
const {
  handoffContinuation,
  checkHandoffContinuation,
  installHandoffContinuationGuard,
} = require('../electron/capabilities/browser/handoffContinuation.cjs');
let send: (...a: any[]) => any;
const toasts: any[] = [];
mockStore({ chatOf: (id: string) => id, sendMessage: (...a: any[]) => send(...a), toast: (...a: any[]) => toasts.push(a) });
const { createElement: e } = require('react');
const { BlockedStrip } = await import('../src/components/thread/BlockedStrip.tsx');

function world(optimistic: boolean, pendingSwitch = false) {
  const h = setup();
  h.chats.records.set('chat', { id: 'chat', segments: [{ kind: 'codex', nativeId: 'native' }] });
  const gate = deferred<void>();
  let relay = 'extension';
  let pause = true;
  let reads = 0;
  let sends = 0;
  const nativeCalls: any[] = [];
  const removals: any[] = [];
  const a = new CodexAdapter({
    server: {
      listeners: new Set(),
      send() {
        throw new Error('Unexpected external operation');
      },
    },
    state: h.state,
    probe: null,
    emit: (event: any) => {
      if (optimistic && event.kind === 'turnStarting')
        setStore({
          runtime: {
            chat: {
              turns: [
                { id: 'refused', items: [refusal] },
                {
                  id: `pending-${event.clientId}`,
                  items: [{ type: 'userMessage', id: `local-${event.clientId}`, content: [{ type: 'inputText', text: event.text }] }],
                },
              ],
            },
          },
        });
    },
  });
  a.ensureResumed = async () => {};
  a.defaults = async () => ({ inputs: {}, model: 'fake' });
  a.initialize = () => (pause && !pendingSwitch ? gate.promise : Promise.resolve({}));
  a.call = async (method: string, params: any) => {
    nativeCalls.push({ method, params });
    return { turn: { id: 'accepted' } };
  };
  a.meta.set('native', { preview: 'existing', cwd: '/tmp' });
  h.c.codex = a;
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
  native.browser.chromeState = async () => ({ active: 'builtin', hasToken: false });
  native.browser.handoffRoute = async () => routeOf('chat');
  native.browser.onChannelChanged = () => () => {};
  native.browser.continueInChrome = async ({ url }: any) => ({ ok: true, route: routeOf('chat'), url });
  native.browser.handoffContinuation = async ({ chatId, url }: any) => {
    reads++;
    return handoffContinuation(live, routeOf, chatId, url);
  };
  native.session.removeQueued = async (chatId: string, id: string) => {
    removals.push([chatId, id]);
    return !!h.c.removeQueued(chatId, id);
  };
  renderer.sessionOf = (id) => h.s(id);
  if (pendingSwitch) {
    h.state.patch('chat', { pendingSwitch: { harness: 'codex', model: 'replacement' } });
    h.c.switcher.perform = async () => {
      await gate.promise;
      h.chats.records.get('chat').segments.push({ kind: 'codex', nativeId: 'replacement-native' });
      a.meta.set('replacement-native', { preview: 'existing replacement', cwd: '/tmp' });
      return { ready: true, prefix: '<switch>' };
    };
  }
  native.session.send = async (chatId: string, item: any) => {
    sends++;
    checkHandoffContinuation(live, routeOf, chatId, item);
    return h.c.send(chatId, item, 1, true);
  };
  send = sendMessage;
  return {
    ...h,
    nativeCalls,
    removals,
    reads: () => reads,
    sends: () => sends,
    releaseStale: () => {
      relay = 'relay';
      pause = false;
      gate.resolve();
    },
  };
}
const refusal = {
  id: 'blocked',
  type: 'mcpToolCall',
  tool: 'browser_navigate',
  arguments: { url: 'https://a.test/' },
  status: 'failed',
  error: { message: 'Sign in first\n<refusal reason="password_field" retryable="false">\nnext: x\n</refusal>' },
};

for (const mode of ['plain', 'turnStarting', 'pendingSwitch']) {
  const optimistic = mode === 'turnStarting';
  const pendingSwitch = mode === 'pendingSwitch';
  test(`retained continuation has visible exact-id recovery ${mode}`, async () => {
    resetStore({ runtime: { chat: { turns: [{ id: 'refused', items: [refusal] }] } }, agentTabs: {} });
    const h = world(optimistic, pendingSwitch);
    const v = await render(e(BlockedStrip, { threadId: 'chat' }));
    const button = (label: string) =>
      v.$$('button').find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
    const click = async (label: string) => {
      const b = button(label);
      assert.ok(b, `visible button ${label}`);
      await settle(() => b.click());
    };
    try {
      await click('Open in your Chrome');
      await click('Done, continue');
      await tick();
      const earlyId = pendingSwitch ? state.runtime.chat.activeTurnId : null;
      if (pendingSwitch) {
        assert.match(earlyId, /^pending-/);
        assert.equal(state.runtime.chat.turns.at(-1).items[0].type, 'userMessage');
        assert.ok(v.$('.blocked-strip'), 'handoff survives the real renderer early-turn replacement');
      }
      await settle(() => h.releaseStale());
      for (let i = 0; i < 3; i++) await settle(tick);
      assert.equal(h.s('chat').queue.length, 1);
      assert.equal(h.nativeCalls.length, 0);
      const oldId = h.s('chat').queue[0].id;
      if (pendingSwitch) {
        assert.equal(earlyId, `pending-${oldId}`, 'renderer and retained queue share one request identity');
        assert.equal(state.runtime.chat.turns.at(-1).status, 'failed');
        assert.equal(h.s('chat').pendingSwitch, null);
      }
      assert.ok(v.$('.blocked-strip'), 'retained failure remains visible');
      assert.equal(button('Done, continue')?.disabled, true, 'retry cannot duplicate retained input');
      await click('Done, continue');
      assert.equal(h.sends(), 1);
      assert.match(v.host.textContent || '', /queue/i);
      await click('Remove queued continuation and retry');
      assert.deepEqual(h.removals, [['chat', oldId]]);
      assert.equal(h.s('chat').queue.length, 0);
      assert.equal(h.sends(), 1, 'removal is not itself a send');
      if (button('Open in your Chrome')) await click('Open in your Chrome');
      await click('Done, continue');
      for (let i = 0; i < 3; i++) await settle(tick);
      assert.equal(h.reads(), 2, 'recovery obtains a fresh main snapshot');
      assert.equal(h.sends(), 2);
      assert.equal(h.nativeCalls.length, 1, 'only fresh continuation reaches adapter');
      assert.equal(h.s('chat').queue.length, 0);
    } finally {
      h.releaseStale();
      h.c.end('chat', { drain: false });
      await v.unmount();
    }
  });
}

test('a replacement refusal retires the older handoff rather than resurrecting it on the next optimistic turn', async () => {
  resetStore({ runtime: { chat: { turns: [{ id: 'refused', items: [refusal] }] } }, agentTabs: {} });
  const h = world(false);
  const v = await render(e(BlockedStrip, { threadId: 'chat' }));
  const button = (label: string) => v.$$('button').find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  try {
    await settle(() => button('Open in your Chrome')!.click());
    assert.ok(button('Done, continue'));
    await settle(() =>
      setStore({
        runtime: {
          chat: { turns: [{ id: 'new-refusal', items: [{ ...refusal, id: 'replacement', arguments: { url: 'https://new.test/' } }] }] },
        },
      }),
    );
    assert.ok(button('Open in your Chrome'));
    assert.equal(button('Done, continue'), undefined);
    await settle(() =>
      setStore({ runtime: { chat: { turns: [{ id: 'new-optimistic', items: [{ type: 'userMessage', id: 'fresh-user' }] }] } } }),
    );
    assert.equal(v.$('.blocked-strip'), null, 'old handoff must not reappear after its replacement');
    assert.equal(h.sends(), 0);
    assert.equal(h.s('chat').queue.length, 0);
  } finally {
    h.releaseStale();
    await v.unmount();
  }
});

test('a late Chrome opening never changes a replacement thread notice', async () => {
  resetStore({
    runtime: {
      chat: { turns: [{ id: 'old', items: [refusal] }] },
      replacement: { turns: [{ id: 'new', items: [{ ...refusal, id: 'new-block' }] }] },
    },
    agentTabs: {},
  });
  const h = world(false);
  const opening = deferred<any>();
  native.browser.continueInChrome = () => opening.promise;
  const v = await render(e(BlockedStrip, { threadId: 'chat' }));
  try {
    const open = v.$$('button').find((b) => b.textContent === 'Open in your Chrome')!;
    await settle(() => open.click());
    await v.rerender(e(BlockedStrip, { threadId: 'replacement' }));
    await settle(() => opening.resolve({ ok: true, route: 'extension', url: 'https://a.test/' }));
    assert.equal(
      v.$$('button').some((b) => b.textContent === 'Done, continue'),
      false,
    );
    assert.equal(h.sends(), 0);
  } finally {
    h.releaseStale();
    await v.unmount();
  }
});
