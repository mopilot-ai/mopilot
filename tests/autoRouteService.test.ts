// Auto routing on a chat's turns: Harness Auto's per-turn model and effort, every fallback to the chat's own selection,
// the cheaper-tier wait, and Global Auto moving a chat through the ordinary pending switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAutoRoute } = require('../electron/autoRoute/service.cjs');

const CLAUDE = [
  { id: 'claude-haiku-5-5', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'max'] },
];
const CODEX = [
  { id: 'gpt-5.5-mini', efforts: [] },
  { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'] },
];

function world(o: any = {}) {
  const config: any = { autoRoute: 'harness', ...o.config };
  const record: any = { meta: { config } };
  const states: any = { chat: { pendingSwitch: null } };
  let kind = o.kind ?? 'claude';
  const decisions: any[] = [...(o.decisions ?? [])];
  const inputs: any[] = [];
  const switched: any[] = [];
  const changed: string[] = [];
  const reads: string[] = [];
  let clock = 1000;
  const catalogs: any = { claude: CLAUDE, codex: CODEX, 'acp:gemini': [], ...o.catalogs };
  const router =
    o.router ??
    (async () => ({
      route: async (input: any) => {
        inputs.push(input);
        const d = decisions.shift() ?? { tier: 'C1', thinking: 'T1', intent: 'new_task', difficulty: 1, margin: 0.5, reason: 'routine' };
        if (d instanceof Error) throw d;
        return d;
      },
    }));
  const service = createAutoRoute({
    controller: {
      state: {
        get: (id: string) => states[id],
        patch: (id: string, p: any) => {
          if (o.patchThrows) throw new Error('store gone');
          states[id] = { ...states[id], ...p };
        },
      },
      ref: () => ({ kind }),
    },
    chats: {
      records: new Map([['chat', record]]),
      patchMeta: (_id: string, p: any) => {
        record.meta = { ...record.meta, ...p };
        return true;
      },
    },
    settings: {
      catalogOf: async (_id: string, k?: string) => {
        reads.push(k ?? kind);
        if (o.catalogThrows) throw new Error('not signed in');
        const list = catalogs[k ?? kind];
        if (list instanceof Error) throw list;
        return list;
      },
      settingsOf: () => ({ model: null, effort: null }),
      setAcpOption: async () => {},
      switchHarness: async (_id: string, w: any) => {
        if (o.switchThrows) throw new Error('no switch');
        switched.push(w.harness);
        if (o.recordPending) states.chat = { ...states.chat, pendingSwitch: { harness: w.harness } };
        else kind = w.harness;
        o.onSwitch?.();
      },
    },
    router,
    scorer: o.scorer === undefined ? { score: (_t: string, c: any[]) => o.score?.(c) ?? [] } : o.scorer,
    harnesses:
      o.harnesses === undefined
        ? { kinds: () => ['claude', 'codex', 'acp:gemini'], fit: async (k: string) => k !== 'acp:gemini' }
        : o.harnesses,
    prefs: () => o.prefs ?? {},
    changed: (id: string) => changed.push(id),
    now: () => clock,
    timeoutMs: o.timeoutMs ?? 50,
    globalTimeoutMs: o.globalTimeoutMs ?? 50,
  });
  const turn = (text = 'Fix the failing test', opts: any = {}) => ({ id: 'm', text, attachments: [], opts: { human: true, ...opts } });
  return {
    service,
    record,
    states,
    inputs,
    switched,
    changed,
    reads,
    turn,
    tick: (ms: number) => (clock += ms),
    dispatch: async (item: any, k = 'turn') => {
      await service.beforeDispatch({ chatId: 'chat', kind: k, item, ref: { kind } });
      return item;
    },
  };
}

test('an Auto turn runs on the tier’s model and the nearest offered effort, saved nowhere', async () => {
  const w = world({ decisions: [{ tier: 'C2', thinking: 'T3', intent: 'new_task', difficulty: 2.1, margin: 0.3, reason: 'debugging' }] });
  const item = await w.dispatch(w.turn());
  assert.equal(item.opts.model, 'claude-opus-5-5');
  assert.equal(item.opts.effort, 'high');
  assert.deepEqual(item.opts.autoRoute, { tier: 'C2', routerTier: 'C2', thinking: 'T3', intent: 'new_task' });
  assert.equal(w.record.meta.config.model, undefined);
  assert.deepEqual(
    { model: w.states.chat.autoRoute.model, tier: w.states.chat.autoRoute.tier, reason: w.states.chat.autoRoute.reason },
    { model: 'claude-opus-5-5', tier: 'C2', reason: 'debugging' },
  );
  assert.equal(w.inputs[0].activeTier, null);
});

test('inputs that are not an Auto chat’s written turn are left alone', async () => {
  const off = world({ config: { autoRoute: null } });
  assert.equal((await off.dispatch(off.turn())).opts.model, undefined);
  const w = world();
  assert.equal((await w.dispatch(w.turn(), 'steer')).opts.model, undefined);
  assert.equal((await w.dispatch(w.turn('x', { compact: { args: '' } }))).opts.model, undefined);
  assert.equal((await w.dispatch(w.turn('x', { goalRestart: 'g' }))).opts.model, undefined);
  assert.equal((await w.dispatch({ text: 'x' })).opts, undefined);
  // a model or effort someone chose (a scheduled task, a Host send) wins
  assert.equal((await w.dispatch(w.turn('x', { model: 'claude-haiku-5-5' }))).opts.model, 'claude-haiku-5-5');
  assert.equal((await w.dispatch(w.turn('x', { effort: 'low' }))).opts.model, undefined);
  assert.equal(w.inputs.length, 0);
});

test('a new chat’s first message carries its Auto mode until the saved config arrives', async () => {
  const w = world();
  delete w.record.meta.config.autoRoute;
  const item = await w.dispatch(w.turn('Hello', { autoMode: 'harness' }));
  assert.equal(item.opts.model, 'claude-sonnet-5-5');
  // once the chat's config says Auto is off, the first message's mode no longer counts
  w.record.meta.config.autoRoute = null;
  const later = await w.dispatch(w.turn('Hello', { autoMode: 'harness' }));
  assert.equal(later.opts.model, undefined);
});

test('every failure leaves the turn on the chat’s own selection and says why', async () => {
  const cases: [any, RegExp][] = [
    [{ catalogThrows: true }, /could not be read: not signed in/],
    [{ kind: 'codex', catalogs: { codex: [] } }, /lists no models/],
    [{ kind: 'acp:gemini' }, /lists no models/],
    [{ router: async () => null }, /not available/],
    [{ decisions: [new Error('model file damaged')] }, /model file damaged/],
    [{ router: async () => ({ route: () => new Promise(() => {}) }), timeoutMs: 5 }, /took too long/],
    [{ router: async () => ({ route: () => Promise.reject('weights missing') }) }, /weights missing/],
  ];
  for (const [o, why] of cases) {
    const w = world(o);
    const item = await w.dispatch(w.turn());
    assert.equal(item.opts.model, undefined);
    assert.equal(w.states.chat.autoRoute.fallback, true);
    assert.match(w.states.chat.autoRoute.reason, why);
  }
  const w = world();
  await w.dispatch(w.turn('   '));
  assert.match(w.states.chat.autoRoute.reason, /written request/);
  // a message with no text at all (a picture only) runs on the chat's own model too
  const pictureOnly: any = { id: 'p', attachments: [{ kind: 'image' }], opts: {} };
  await w.dispatch(pictureOnly);
  assert.equal(pictureOnly.opts.model, undefined);
});

test('a chat main has no record of, or no config for, is never on Auto', async () => {
  const w = world();
  const item = w.turn();
  await w.service.beforeDispatch({ chatId: 'ghost', kind: 'turn', item });
  assert.equal(item.opts.model, undefined);
  w.record.meta = {};
  await w.dispatch(item);
  assert.equal(item.opts.model, undefined);
  await w.service.beforeStart({ chatId: 'chat', item });
  assert.equal(w.inputs.length, 0);
});

test('a retried message drops what Auto picked for the earlier attempt when Auto can’t route it', async () => {
  const w = world({ decisions: [{ tier: 'C0', thinking: 'T0', intent: 'new_task', difficulty: 0, margin: 0.9 }, new Error('gone')] });
  const item = await w.dispatch(w.turn());
  assert.equal(item.opts.model, 'claude-haiku-5-5');
  await w.dispatch(item);
  assert.equal(item.opts.model, undefined);
  assert.equal(item.opts.effort, undefined);
  assert.equal(item.opts.autoRoute, undefined);
  // and with nothing Auto picked before, the fallback leaves the options as they were
  const fresh = await w.dispatch(w.turn('again'));
  assert.equal(fresh.opts.human, true);
});

test('a model with no effort levels runs without one, and the user’s tier table wins', async () => {
  const w = world({ kind: 'codex', prefs: { autoRouteTiers: { codex: { C2: 'gpt-5.5-mini' } } } });
  const item = await w.dispatch(w.turn('x', { effort: undefined }));
  assert.equal(item.opts.model, 'gpt-5.5-mini');
  assert.equal(item.opts.effort, undefined);
  const second = world({ kind: 'codex', decisions: [{ tier: 'C2', thinking: 'T2', intent: 'new_task' }] });
  assert.equal((await second.dispatch(second.turn())).opts.model, 'gpt-5.5');
  // a harness kind no family parses keys the user's table by the kind itself
  const odd = world({ kind: 'mystery', catalogs: { mystery: CODEX }, prefs: { autoRouteTiers: { mystery: { C1: 'gpt-5.5' } } } });
  assert.equal((await odd.dispatch(odd.turn())).opts.model, 'gpt-5.5');
});

test('the router reads the chat’s history, and a cheaper tier waits for a second ask', async () => {
  const d = (tier: string) => ({ tier, thinking: 'T2', intent: 'new_task', difficulty: 1, margin: 0.4, reason: tier });
  const w = world({ decisions: [d('C2'), d('C1'), d('C1')] });
  await w.dispatch(w.turn('first request'));
  w.tick(1500);
  w.service.finished({ chatId: 'chat', text: 'first answer', completed: true });
  const held = await w.dispatch(w.turn('second request'));
  assert.equal(held.opts.model, 'claude-opus-5-5');
  assert.equal(held.opts.autoRoute.routerTier, 'C1');
  assert.match(w.states.chat.autoRoute.reason, /Stays on C2/);
  assert.deepEqual(w.inputs[1].historyUser, ['first request']);
  assert.equal(w.inputs[1].previousAnswer, 'first answer');
  assert.deepEqual(w.inputs[1].previousUsage, { duration_ms: 1500 });
  assert.equal(w.inputs[1].activeTier, 'C2');
  assert.equal(w.inputs[1].routeHistory.length, 1);
  w.service.finished({ chatId: 'chat', text: null, completed: true });
  assert.equal((await w.dispatch(w.turn('third'))).opts.model, 'claude-sonnet-5-5');
  assert.equal(w.inputs[2].previousAnswer, '');
});

test('a failed turn keeps its tier for the next, and finishing without a routed turn changes nothing', async () => {
  const w = world({
    decisions: [
      { tier: 'C2', thinking: 'T2', intent: 'new_task' },
      { tier: 'C0', thinking: 'T0', intent: 'redo' },
    ],
  });
  w.service.finished({ chatId: 'chat', text: 'x', completed: true });
  await w.dispatch(w.turn('a'.repeat(9000)));
  assert.equal(w.inputs[0].currentRequest.length, 9000);
  w.service.finished({ chatId: 'chat', text: 'oops', completed: false });
  // a second finish for the same turn is ignored
  w.service.finished({ chatId: 'chat', text: 'later', completed: true });
  const retry = await w.dispatch(w.turn('try again'));
  assert.equal(retry.opts.model, 'claude-opus-5-5');
  assert.equal(w.inputs[1].historyUser[0].length, 8000);
  w.service.forget('chat');
  assert.equal(w.service.forget('chat'), false);
});

test('a decision the store can’t show is noted, and the turn still routes', async () => {
  const w = world({ patchThrows: true });
  assert.equal((await w.dispatch(w.turn())).opts.model, 'claude-sonnet-5-5');
});

const global = (o: any = {}) => world({ ...o, config: { autoRoute: 'global', ...o.config } });
const start = (w: any, item = w.turn('Write a shell script')) => w.service.beforeStart({ chatId: 'chat', item });

test('Global Auto moves a new chat to the best harness first, through the pending switch', async () => {
  const seen: any[] = [];
  const w = global({
    score: (c: any[]) => (
      seen.push(c),
      [
        { kind: 'codex', score: 0.8 },
        { kind: 'claude', score: 0.5 },
      ]
    ),
  });
  await start(w);
  assert.deepEqual(w.switched, ['codex']);
  // an unfit harness is not scored; the chat's own always is
  assert.deepEqual(
    seen[0].map((c: any) => c.kind),
    ['claude', 'codex'],
  );
  assert.deepEqual(seen[0][1].models, ['gpt-5.5-mini', 'gpt-5.5']);
  assert.deepEqual(w.record.meta.config.autoRouteState, { turns: 1, switchedAt: 0 });
  assert.deepEqual(w.changed, ['chat']);
  assert.equal(w.states.chat.autoRoute.harness, 'codex');
  // the turn then routes inside the new harness
  assert.equal((await w.dispatch(w.turn())).opts.model, 'gpt-5.5-mini');
});

test('Global Auto stays without a clear lead, and remembers a lead across turns', async () => {
  const w = global({
    config: { autoRouteState: { turns: 3, switchedAt: null } },
    score: () => [
      { kind: 'codex', score: 0.9 },
      { kind: 'claude', score: 0.5 },
    ],
  });
  await start(w);
  assert.deepEqual(w.switched, []);
  assert.match(w.states.chat.autoRoute.reason, /waiting to confirm/);
  await start(w);
  assert.deepEqual(w.switched, ['codex']);
  assert.deepEqual(w.record.meta.config.autoRouteState, { turns: 5, switchedAt: 4 });
});

test('Global Auto leaves alone what it should not touch', async () => {
  const scoreless = global({ scorer: null });
  await start(scoreless);
  const harnessless = global({ harnesses: null });
  await start(harnessless);
  const handOnly = world();
  await start(handOnly);
  const explicit = global();
  await start(explicit, explicit.turn('x', { model: 'gpt-5.5' }));
  const compact = global();
  await start(compact, compact.turn('x', { compact: { args: '' } }));
  const blank = global();
  await start(blank, blank.turn(''));
  const textless = global();
  await start(textless, { id: 'p', attachments: [], opts: {} });
  const waiting = global();
  waiting.states.chat.pendingSwitch = { harness: 'codex' };
  await start(waiting);
  for (const w of [scoreless, harnessless, handOnly, explicit, compact, blank, textless, waiting]) {
    assert.deepEqual(w.switched, []);
    assert.equal(w.record.meta.config.autoRouteState, undefined);
  }
});

test('a switch that fails or a harness whose models can’t be read keeps the chat where it is', async () => {
  const w = global({
    switchThrows: true,
    catalogs: { codex: new Error('logged out') },
    score: (c: any[]) => {
      assert.deepEqual(c[1].models, []);
      return [{ kind: 'codex', score: 0.9 }];
    },
  });
  await start(w);
  assert.deepEqual(w.switched, []);
  assert.deepEqual(w.record.meta.config.autoRouteState, { turns: 1, switchedAt: null });
  // staying put still counts the turn
  const same = global({ score: () => [{ kind: 'claude', score: 0.9 }] });
  same.record.meta.config.autoRouteState = { turns: 0, switchedAt: null };
  await start(same);
  assert.deepEqual(same.record.meta.config.autoRouteState, { turns: 1, switchedAt: null });
});

test('a retried message whose chat left Auto runs on the chat’s own selection, not on Auto’s earlier pick', async () => {
  const w = world();
  const item = await w.dispatch(w.turn());
  assert.equal(item.opts.model, 'claude-sonnet-5-5');
  w.record.meta.config.autoRoute = null;
  await w.dispatch(item);
  assert.deepEqual([item.opts.model, item.opts.effort, item.opts.autoRoute], [undefined, undefined, undefined]);
});

test('a retried message is routed as the same turn, not as one more request after it', async () => {
  const d = (tier: string) => ({ tier, thinking: 'T2', intent: 'new_task', difficulty: 1, margin: 0.4 });
  const w = world({ decisions: [d('C2'), d('C0'), d('C0')] });
  await w.dispatch(w.turn('first'));
  w.service.finished({ chatId: 'chat', text: 'done', completed: true });
  const item = { ...w.turn('second'), id: 'second' };
  await w.dispatch(item);
  // the retry reads what the first attempt read, and the tier it held is not counted twice
  await w.dispatch(item);
  assert.deepEqual(w.inputs[2].historyUser, w.inputs[1].historyUser);
  assert.equal(w.inputs[2].activeTier, 'C2');
  assert.equal(w.inputs[2].routeHistory.length, 1);
  assert.equal(item.opts.model, 'claude-haiku-5-5');
});

test('Auto remembers a bounded number of chats, the least recently routed forgotten first', async () => {
  const { MEMORY_CHATS } = require('../electron/autoRoute/service.cjs');
  const w = world();
  for (let i = 0; i <= MEMORY_CHATS; i++)
    await w.service.beforeDispatch({
      chatId: i === 0 ? 'chat' : `c${i}`,
      kind: 'turn',
      item: w.turn('x', { autoMode: 'harness' }),
      ref: {},
    });
  // the first chat was forgotten: finishing its turn changes nothing, and it starts afresh
  assert.equal(w.service.forget('chat'), false);
  assert.equal(w.service.forget(`c${MEMORY_CHATS}`), true);
});

test('Global Auto scores aliases by the model they resolve to, and reuses a harness’s model list for a minute', async () => {
  const seen: any[] = [];
  const w = global({
    catalogs: { codex: [{ id: 'auto-alias', efforts: [], resolved: 'gpt-5.5' }] },
    score: (c: any[]) => (seen.push(c), []),
  });
  await start(w);
  assert.deepEqual(seen[0].find((c: any) => c.kind === 'codex').models, ['gpt-5.5']);
  await start(w);
  assert.equal(w.reads.filter((k: string) => k === 'codex').length, 1);
  w.tick(61_000);
  await start(w);
  assert.equal(w.reads.filter((k: string) => k === 'codex').length, 2);
});

test('Global Auto waits a bounded time for the harnesses, and a Stop meanwhile keeps the chat where it is', async () => {
  const seen: any[] = [];
  const slow = global({
    harnesses: {
      kinds: () => ['codex', 'acp:gemini'],
      fit: (k: string) => (k === 'codex' ? Promise.resolve(true) : new Promise(() => {})),
    },
    catalogs: { codex: new Promise(() => {}) },
    score: (c: any[]) => (seen.push(c), [{ kind: 'codex', score: 0.9 }]),
  });
  // a list that never answers is scored as none; a fit check that never answers leaves the harness out
  await start(slow);
  assert.deepEqual(
    seen[0].map((c: any) => [c.kind, c.models]),
    [
      ['claude', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']],
      ['codex', []],
    ],
  );
  const stopped = global({ score: () => [{ kind: 'codex', score: 0.9 }] });
  await stopped.service.beforeStart({ chatId: 'chat', item: stopped.turn('Write a shell script'), stale: () => true });
  assert.deepEqual(stopped.switched, []);
  assert.equal(stopped.record.meta.config.autoRouteState, undefined);
});

test('a switch a Stop overtook is taken back, and a start the harness never took is no turn', async () => {
  let stale = false;
  // the Stop lands while the switch is being checked
  const w = global({ recordPending: true, onSwitch: () => (stale = true), score: () => [{ kind: 'codex', score: 0.9 }] });
  await w.service.beforeStart({ chatId: 'chat', item: w.turn('Write a shell script'), stale: () => stale });
  assert.deepEqual(w.switched, ['codex']);
  assert.equal(w.states.chat.pendingSwitch, null);
  assert.equal(w.record.meta.config.autoRouteState, undefined);
  // a switch to another harness recorded meanwhile is the user's: it stays
  let late = false;
  const other: any = global({
    onSwitch: () => {
      late = true;
      other.states.chat.pendingSwitch = { harness: 'acp:gemini' };
    },
    score: () => [{ kind: 'codex', score: 0.9 }],
  });
  await other.service.beforeStart({ chatId: 'chat', item: other.turn('Write a shell script'), stale: () => late });
  assert.deepEqual(other.states.chat.pendingSwitch, { harness: 'acp:gemini' });
  // a start that never reached the harness keeps its tier and history for the retry
  const r = world({
    decisions: [
      { tier: 'C2', thinking: 'T2', intent: 'new_task' },
      { tier: 'C0', thinking: 'T0', intent: 'new_task' },
    ],
  });
  const first = await r.dispatch({ ...r.turn('first'), id: 'first' });
  r.service.finished({ chatId: 'chat', turnId: 'pending-first', text: null, completed: false });
  await r.dispatch(first);
  assert.deepEqual(r.inputs[1].historyUser, []);
  assert.equal(r.inputs[1].activeTier, null);
});

test('Global Auto shares a model list read still running, forgets a failed one, and reconsiders a retried message', async () => {
  let calls = 0;
  let fail = true;
  const w = global({ score: () => [] });
  (w as any).service = createAutoRoute({
    controller: { state: { get: () => ({}), patch: () => {} }, ref: () => ({ kind: 'claude' }) },
    chats: { records: new Map([['chat', w.record]]), patchMeta: () => true },
    settings: {
      catalogOf: (_id: string, k: string) => {
        if (k !== 'codex') return Promise.resolve([]);
        calls++;
        return fail ? Promise.reject(new Error('down')) : Promise.resolve([{ id: 'gpt-5.5', efforts: [] }]);
      },
      switchHarness: async () => {},
    },
    router: async () => null,
    scorer: { score: () => [] },
    harnesses: { kinds: () => ['codex'], fit: async () => true },
    prefs: () => ({}),
    changed: () => {},
  });
  await (w as any).service.beforeStart({ chatId: 'chat', item: w.turn('x') });
  fail = false;
  await (w as any).service.beforeStart({ chatId: 'chat', item: w.turn('x') });
  await (w as any).service.beforeStart({ chatId: 'chat', item: w.turn('x') });
  assert.equal(calls, 2);
  // what Auto set for a message's earlier attempt does not stop Global Auto from reconsidering it
  const seen: any[] = [];
  const g = global({ score: (c: any[]) => (seen.push(c), []) });
  await start(g, g.turn('x', { model: 'claude-haiku-5-5', autoRoute: { tier: 'C0' } }));
  assert.equal(seen.length, 1);
});

test('Global Auto’s model list reads are bounded too, the oldest forgotten first', async () => {
  const w = global({ score: () => [] });
  for (let i = 0; i < 120; i++) await w.service.beforeStart({ chatId: `g${i}`, item: w.turn('x', { autoMode: 'global' }) });
  const before = w.reads.length;
  // the first chat's lists were forgotten, the last one's are reused
  await w.service.beforeStart({ chatId: 'g0', item: w.turn('x', { autoMode: 'global' }) });
  assert.ok(w.reads.length > before);
  const again = w.reads.length;
  await w.service.beforeStart({ chatId: 'g119', item: w.turn('x', { autoMode: 'global' }) });
  assert.equal(w.reads.length, again);
});
