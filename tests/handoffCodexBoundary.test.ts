// Independent issue1584 review: real continuation producer, controller queue, Codex adapter and final request boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup as controllerSetup } from './support/controller/fixture.ts';
import { deferred } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { ControllerPlans, planInputs } = require('../electron/session/controllerPlan.cjs');
const { chatHandoffRoute } = require('../electron/capabilities/browser/handoff.cjs');
const {
  handoffContinuation,
  checkHandoffContinuation,
  installHandoffContinuationGuard,
} = require('../electron/capabilities/browser/handoffContinuation.cjs');

function world(boundary: 'initialize' | 'nativeLifecycle', steer = false) {
  const h = controllerSetup();
  h.chats.records.set('chat', { id: 'chat', segments: [{ kind: 'codex', nativeId: 'native' }] });
  const gate = deferred<void>();
  let relay = 'extension';
  let paused = true;
  let reached = 0;
  const calls: any[] = [];
  const a = new CodexAdapter({
    server: {
      listeners: new Set(),
      send() {
        throw new Error('Unexpected server operation');
      },
    },
    state: h.state,
    probe: null,
  });
  a.ensureResumed = async () => undefined;
  a.defaults = async () => ({ inputs: {}, model: 'fake-model' });
  a.initialize = () => {
    if (boundary === 'initialize' && paused) {
      reached++;
      return gate.promise;
    }
    return Promise.resolve({});
  };
  let lifecycleCalls = 0;
  a.nativeLifecycle.turnEnded = () => {
    lifecycleCalls++;
    if (boundary === 'nativeLifecycle' && lifecycleCalls === 2 && paused) {
      reached++;
      return gate.promise;
    }
    return Promise.resolve();
  };
  a.call = async (method: string, params: any) => {
    calls.push({ method, params, json: JSON.stringify(params) });
    return { turn: { id: 'accepted-turn' } };
  };
  a.meta.set('native', { preview: 'Existing thread', cwd: '/tmp' });
  h.c.codex = a;
  const names = ['chrome_tabs_context_mcp', 'chrome_navigate'];
  const inputs = planInputs({
    tools: () => names,
    yourChrome: () => false,
    codex: {
      channel: () => true,
      toolsOf: () => names,
      loadedPath: () => ({ chrome: false, computer: false, iab: false, tools: true }),
      nativeSurfaces: () => ({}),
      iabAvailable: () => false,
      chromeBackend: () => ({ serves: () => false, available: () => false }),
    },
    claude: { channel: () => true, nativeChromeOf: () => false, nativeChromeFor: () => false, toolsOf: () => names },
    acp: { channel: () => true, toolsOf: () => names },
  });
  const controllerPlans = new ControllerPlans({ inputs, ref: (id: string) => h.c.ref(id) });
  const live = { controller: h.c, controllerPlans };
  const routeOf = (id: string) => {
    const s = controllerPlans.snapshot(id);
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
  const item = () => {
    const r = handoffContinuation(live, routeOf, 'chat', 'https://site.test/');
    return {
      text: r.message,
      attachments: [],
      opts: { human: true, chromeHandoff: r.precondition },
      ...(steer ? { followUp: 'steer' } : {}),
    };
  };
  if (steer) {
    h.state.patch('chat', { turn: 'running', activeTurn: { id: 'existing-turn' } });
    h.c.rt('chat').token = 'existing-turn';
  }
  return {
    ...h,
    a,
    live,
    routeOf,
    item,
    calls,
    reached: () => reached,
    retireRoute: () => {
      relay = 'relay';
    },
    resume: () => {
      paused = false;
      gate.resolve();
    },
  };
}

for (const boundary of ['initialize', 'nativeLifecycle'] as const) {
  test(`real main producer → queue → Codex start rejects a route change during final ${boundary} await`, async () => {
    const h = world(boundary);
    const input = h.item();
    checkHandoffContinuation(h.live, h.routeOf, 'chat', input);
    const sending = h.c.send('chat', input, 1, true);
    await waitFor(() => h.reached(), 'the final transport wait');
    assert.equal(h.reached(), 1, 'test reached the final transport wait');
    h.retireRoute();
    h.resume();
    const receipt = await sending;
    assert.equal(receipt.action, 'queued');
    assert.match(receipt.error, /controller changed/);
    assert.deepEqual(h.calls, []);
    assert.equal(h.s('chat').queue.length, 1);
    assert.equal(h.s('chat').queue[0].text, input.text);
    assert.deepEqual(h.s('chat').queue[0].opts.chromeHandoff, input.opts.chromeHandoff);
    const retried = await h.c.sendNow('chat', receipt.id, 1, true);
    assert.equal(retried.status, 'queued');
    assert.deepEqual(h.calls, []);
    const removed = h.c.removeQueued('chat', receipt.id);
    assert.equal(removed.text, input.text);
    const fresh = await h.c.send('chat', h.item(), 1, true);
    assert.equal(fresh.action, 'started');
    assert.equal(h.calls.length, 1);
    assert.equal((h.calls[0] as any).method, 'turn/start');
    assert.doesNotMatch((h.calls[0] as any).json, /chromeHandoff|mopilot.inputOwner/);
    h.c.end('chat', { drain: false });
  });
}

test('real Codex steer retains input when the receiving segment switches during final initialize', async () => {
  const h = world('initialize', true);
  const input = h.item();
  const sending = h.c.send('chat', input, 1, true);
  await waitFor(() => h.reached(), 'the final transport wait');
  assert.equal(h.reached(), 1);
  h.chats.records.get('chat').segments.push({ kind: 'claude', nativeId: 'replacement' });
  h.resume();
  const receipt = await sending;
  assert.equal(receipt.action, 'queued');
  assert.match(receipt.error, /controller changed/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.s('chat').queue.length, 1);
  assert.equal(h.s('chat').queue[0].text, input.text);
  h.c.end('chat', { drain: false });
});

test('a serialized queue item receives the main guard again and cannot dispatch stale text', async () => {
  const h = world('initialize');
  const queued = JSON.parse(JSON.stringify({ ...h.item(), id: 'restored', origin: 1, queuedAt: Date.now() }));
  h.state.patch('chat', { queue: [queued] });
  h.retireRoute();
  h.resume();
  const receipt = await h.c.sendNow('chat', 'restored', 1, true);
  assert.equal(receipt.status, 'queued');
  assert.match(receipt.error, /controller changed/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.s('chat').queue[0].text, queued.text);
});

test('pending switch refusal preserves the choice; settled switch rejects old handoff and fresh retry sends once', async () => {
  const h = world('initialize');
  h.resume();
  const choice = { harness: 'codex', model: 'replacement-model' };
  h.state.patch('chat', { pendingSwitch: choice });
  let attempts = 0;
  h.c.switcher.perform = async () => {
    attempts++;
    if (attempts === 1) return { ready: false, error: 'switch refused' };
    h.chats.records.get('chat').segments.push({ kind: 'codex', nativeId: 'replacement-native' });
    h.a.meta.set('replacement-native', { preview: 'Existing replacement', cwd: '/tmp' });
    return { ready: true, prefix: '<new-segment>', note: { kind: 'switch', text: 'new segment' } };
  };
  const input = h.item();
  const first = await h.c.send('chat', input, 1, true);
  assert.equal(first.action, 'queued');
  assert.equal(first.error, 'switch refused');
  assert.deepEqual(h.s('chat').pendingSwitch, choice);
  assert.equal(h.s('chat').queue.length, 1);
  assert.equal(h.calls.length, 0);
  const next = await h.c.sendNow('chat', first.id, 1, true);
  assert.equal(next.status, 'queued');
  assert.match(next.error, /controller changed/);
  assert.equal(h.s('chat').pendingSwitch, null);
  assert.equal(h.s('chat').queue.length, 1);
  assert.equal(h.s('chat').queue[0].id, first.id);
  assert.equal(h.s('chat').queue[0].opts.prefix, '<new-segment>');
  assert.deepEqual(h.s('chat').queue[0].opts.chromeHandoff, input.opts.chromeHandoff);
  assert.equal(h.calls.length, 0, 'the old continuation never reaches the newly selected native thread');
  h.c.removeQueued('chat', first.id);
  const fresh = h.item();
  assert.notEqual(fresh.opts.chromeHandoff.token, input.opts.chromeHandoff.token);
  const delivered = await h.c.send('chat', fresh, 1, true);
  assert.equal(delivered.action, 'started');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].params.threadId, 'replacement-native');
  assert.equal(h.s('chat').queue.length, 0);
  h.c.end('chat', { drain: false });
});
