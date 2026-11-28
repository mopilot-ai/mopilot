// Auto's place on main's ChatController: the controller awaits Global Auto before a turn's pending switch, the wiring adds
// its steps beside the hooks already there, no failure of Auto stops a turn, and the router loads once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController, queueItem } = require('../electron/session/controller.cjs');
const { installAutoRoute, routerLoader } = require('../electron/app/autoRouteWiring.cjs');

function controllerFor(kind = 'codex') {
  const seen: any[] = [];
  const state = new SessionStore();
  const rec = (id: string) => ({ id, segments: [{ kind, nativeId: id }], meta: { config: {} } });
  const step = async (chatId: string, _ref: any, item: any) => (seen.push([chatId, item.opts.model ?? null]), { started: true });
  const c = new ChatController({
    state,
    chats: { record: rec, records: new Map([['a', rec('a')]]) },
    codex: { startTurn: step, startGoal: step, steer: step },
    claudeTurns: { startTurn: step, steer: step, crashed: () => {} },
    acpTurns: { startTurn: step },
    claude: { send: async () => true },
    acp: { send: async () => true },
  });
  return { c, seen, state };
}

test('the controller awaits beforeStart before the turn, and a failing one never stops it', async () => {
  const { c, seen } = controllerFor();
  const order: string[] = [];
  c.beforeStart = async ({ item, stale }: any) => {
    order.push('beforeStart');
    // the start is still the one it was called for
    assert.equal(stale(), false);
    item.opts.model = 'gpt-5.5';
  };
  assert.equal((await c.start('a', queueItem({ text: 'hi' }))).started, true);
  assert.deepEqual(seen, [['a', 'gpt-5.5']]);
  c.end('a');
  c.beforeStart = () => {
    throw new Error('router exploded');
  };
  assert.equal((await c.start('a', queueItem({ text: 'again' }))).started, true);
  c.end('a');
  assert.deepEqual(order, ['beforeStart']);
});

function liveFor(o: any = {}) {
  const config: any = { autoRoute: 'harness', ...o.config };
  const records = new Map<string, any>([['a', { meta: { config } }]]);
  const calls: string[] = [];
  const states: any = { a: {} };
  const controller: any = {
    state: { get: (id: string) => states[id] ?? {}, patch: (id: string, p: any) => (states[id] = { ...states[id], ...p }) },
    ref: () => ({ kind: 'codex', id: 'n', key: 'k' }),
    beforeDispatch: async () => void calls.push('earlier guard'),
    onFinished: () => void calls.push('earlier finish'),
    beforeStart: o.previousStart,
  };
  const live: any = {
    controller,
    chats: {
      records: {
        get: (id: string) => {
          if (id === 'broken') throw new Error('store gone');
          return records.get(id);
        },
      },
      patchMeta: (id: string, p: any) => (Object.assign(records.get(id).meta, p), true),
    },
    codex: {
      modelList: async () => ({
        data: [
          { model: 'gpt-5.5-mini', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
          { model: 'gpt-5.5', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
        ],
      }),
    },
  };
  const orchestrator = { o: { usable: async () => true, kinds: o.kinds, quota: o.quota } };
  return { live, controller, calls, states, records, orchestrator };
}

const decision = { tier: 'C3', thinking: 'T3', intent: 'new_task', difficulty: 3, margin: 0.6, reason: 'architecture' };

test('the wiring routes turns after the guards already there and learns from each finished turn', async () => {
  const w = liveFor();
  const changed: string[] = [];
  const service = installAutoRoute(w.live, {
    orchestrator: w.orchestrator,
    prefs: () => ({}),
    changed: (id: string) => changed.push(id),
    router: async () => ({ route: async () => decision }),
    table: { benchmarks: [], idf: {}, centroids: {}, results: {} },
  });
  const item: any = { text: 'Design the module boundaries', opts: {} };
  await w.controller.beforeDispatch({ chatId: 'a', kind: 'turn', item });
  assert.deepEqual(w.calls, ['earlier guard']);
  assert.equal(item.opts.model, 'gpt-5.5');
  assert.equal(item.opts.effort, 'high');
  w.controller.onFinished({ chatId: 'a', text: 'done', completed: true });
  assert.deepEqual(w.calls, ['earlier guard', 'earlier finish']);
  assert.equal(typeof service.forget, 'function');
  // a failure inside Auto is noted, never the turn's
  await w.controller.beforeDispatch({ chatId: 'broken', kind: 'turn', item: { text: 'x', opts: {} } });
  await w.controller.beforeStart({ chatId: 'broken', item: { text: 'x', opts: {} } });
  assert.deepEqual(changed, []);
});

test('Global Auto’s step runs after a beforeStart already there, scoring the harnesses the orchestrator offers', async () => {
  const order: string[] = [];
  const w = liveFor({
    config: { autoRoute: 'global' },
    previousStart: async () => void order.push('earlier'),
    kinds: () => ['codex', 'claude'],
    quota: (k: string) => ({ limited: k === 'claude' }),
  });
  const changed: string[] = [];
  installAutoRoute(w.live, {
    orchestrator: w.orchestrator,
    prefs: () => ({}),
    changed: (id: string) => (order.push('global'), changed.push(id)),
    router: async () => null,
  });
  await w.controller.beforeStart({ chatId: 'a', item: { text: 'Fix the failing pytest', opts: {} } });
  assert.deepEqual(order, ['earlier', 'global']);
  assert.deepEqual(w.records.get('a').meta.config.autoRouteState, { turns: 1, switchedAt: null });
  // no beforeStart before it, and an orchestrator that lists no harnesses
  const bare = liveFor({ config: { autoRoute: 'global' } });
  installAutoRoute(bare.live, { orchestrator: bare.orchestrator, prefs: () => ({}), changed: () => {}, router: async () => null });
  await bare.controller.beforeStart({ chatId: 'a', item: { text: 'hello', opts: {} } });
  assert.equal(bare.states.a.autoRoute.harness, 'codex');
  // the default router: the module or its assets may be missing here, and a turn then runs on the chat's own selection
  const plain = liveFor();
  installAutoRoute(plain.live, { orchestrator: plain.orchestrator, prefs: () => ({}), changed: () => {} });
  const item: any = { text: 'hello', opts: {} };
  await plain.controller.beforeDispatch({ chatId: 'a', kind: 'turn', item });
  assert.ok(plain.states.a.autoRoute);
});

test('the router loads once, and is null where it can’t run', async () => {
  let loads = 0;
  const ready = { available: async () => true, route: async () => decision };
  const options: any[] = [];
  const load = routerLoader({ userData: '/u' }, () => (loads++, { createSquillaRouter: (o: any) => (options.push(o), ready) }));
  assert.equal(await load(), ready);
  assert.equal(await load(), ready);
  assert.equal(loads, 1);
  assert.deepEqual(options, [{ userData: '/u' }]);
  assert.equal(await routerLoader(undefined, () => ({ createSquillaRouter: () => ({ available: async () => false }) }))(), null);
  assert.equal(
    await routerLoader({}, () => {
      throw new Error('Cannot find module');
    })(),
    null,
  );
});

test('a Stop while Global Auto reads the harnesses keeps the chat where it is and starts nothing', async () => {
  const { createAutoRoute } = require('../electron/autoRoute/service.cjs');
  const { c, seen, state } = controllerFor('codex');
  c.codex.stopTurn = async () => true;
  c.chats.records.get('a').meta.config = { autoRoute: 'global' };
  let release: (v: boolean) => void = () => {};
  const reading = new Promise<boolean>((resolve) => (release = resolve));
  let reached: () => void = () => {};
  const asked = new Promise<void>((resolve) => (reached = resolve));
  const switched: string[] = [];
  const service = createAutoRoute({
    controller: c,
    chats: { records: c.chats.records, patchMeta: () => true },
    settings: { catalogOf: async () => [], switchHarness: async (_id: string, w: any) => void switched.push(w.harness) },
    router: async () => null,
    scorer: {
      score: () => [
        { kind: 'claude', score: 1 },
        { kind: 'codex', score: 0 },
      ],
    },
    harnesses: { kinds: () => ['claude'], fit: () => (reached(), reading) },
    prefs: () => ({}),
    changed: () => {},
    globalTimeoutMs: 5000,
  });
  c.beforeStart = service.beforeStart;
  const starting = c.start('a', queueItem({ text: 'Fix the failing test' }));
  await asked;
  await c.stopChat('a');
  release(true);
  await starting;
  // the native send itself is the adapter's to refuse (its stopCheck); the chat was not moved
  assert.deepEqual(switched, []);
  assert.equal(state.get('a').pendingSwitch, null);
  assert.ok(seen.every(([chat]) => chat === 'a'));
});
