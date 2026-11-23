// electron/harness/claude/adapter.cjs beyond tests/claude.test.ts: defaults, what a turn runs with when
// little is set, odd items, rate-limit and login events, moving a chat to another login, settling and
// the goal buttons. The SDK process is a fake; the session state is the real SessionStore.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';
import { defined } from './support/defined.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter, HANDOVER_GRACE_MS } = require('../electron/harness/claude/adapter.cjs');
const { LIMIT_HOLD_MS } = require('../electron/identity/contract/switch.cjs');

const CHAT = 'claude:s1';
const ref = (chatId: string) => ({ kind: 'claude', id: chatId.replace(/^claude:/, ''), instance: null, key: chatId });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const NOW = 1_000_000;

function setup(o: any = {}) {
  const state = new SessionStore();
  const events: [any, any][] = [];
  const sent: any[] = [];
  const enqueued: any[] = [];
  const controls: any[] = [];
  const moved: any[] = [];
  const limits: any[] = [];
  const live = new Set<string>();
  const api: any = {
    isLive: (k: string) => live.has(k),
    control: async (k: string, m: string, a?: unknown) => {
      if (o.failControl) throw o.failControl;
      controls.push([k, m, a]);
    },
    title: async () => 'Title',
    rename: async () => {},
    userTitle: async () => null,
    goalStatus: async () => o.goalText ?? null,
    sessionCwd: () => o.transcriptCwd ?? null,
    accounts: () => o.accounts ?? { active: 'default', accounts: [{ id: 'default', loggedIn: true }] },
    metered: () => false,
    keyMode: o.keyMode,
  };
  const adapter = new ClaudeAdapter({
    api,
    probeInfo: o.probeInfo ?? (() => null),
    state,
    prefs: o.prefs ?? (() => null),
    send: async (chatId: string, key: string, opts: any, input: any, priority: any, meta: any) => {
      if (o.failSend !== undefined) throw o.failSend;
      sent.push({ chatId, key, opts, input, priority, meta });
      if (o.sendGate) await o.sendGate;
      live.add(key);
      return o.sendResult ?? {};
    },
    enqueue: (chatId: string, item: any) => void enqueued.push({ chatId, item }),
    chatOf: (key: string) => key,
    ref,
    emit: (e: any, target?: any) => (events.push([e, target]), o.emitReturns ?? true),
    setGoal: (chatId: string, goal: any) => state.patch(chatId, { goal }),
    moved: (chatId: string, m: any) => {
      moved.push({ chatId, ...m });
      if (o.movedThrows) throw new Error('disk');
    },
    notifyLimit: (chatId: string, reason: string) => void limits.push([chatId, reason]),
    graceMs: 0,
    resumeMs: 0,
    now: () => NOW,
  });
  const kinds = () => events.map(([e]) => e.kind);
  return { api, adapter, state, events, sent, enqueued, controls, moved, limits, live, kinds };
}
const msg = (type: string, extra: any = {}) => ({ key: CHAT, kind: 'message', msg: { type, ...extra } });
const active = (extra: any = {}) => ({ status: 'active', objective: 'ship it', ...extra });
const TWO = {
  active: 'default',
  accounts: [
    { id: 'default', loggedIn: true },
    { id: 'work', loggedIn: true },
  ],
};

test('the adapter takes its defaults: no probe, no-op hooks, the home folder and the clock port', (t) => {
  useFakeClock(t, 1234);
  const a = new ClaudeAdapter({ api: {}, state: new SessionStore(), prefs: () => ({}), chatOf: (k: string) => k, ref });
  assert.equal(a.probeInfo('x'), null);
  assert.equal(a.emit({}), false);
  a.markInterrupted('k');
  a.notifyGoal('c', {});
  a.moved('c', {});
  a.notifyLimit('c', 'limit');
  assert.equal(a.resumeMs, 800);
  assert.equal(a.home, os.homedir());
  assert.equal(a.clock(), 1234);
  assert.equal(a.graceMs, HANDOVER_GRACE_MS);
});

test('sessions a window names: bad keys refused, folders and forks kept only when given, fresh until sent', async () => {
  const { adapter, api } = setup({ transcriptCwd: '/t' });
  assert.equal(adapter.registerSession(''), false);
  assert.equal(adapter.registerSession(null), false);
  assert.equal(adapter.registerSession('claude:a'), true);
  assert.deepEqual(adapter.sessions.get('claude:a'), { cwd: null, ephemeral: false, forkFrom: null, fresh: true });
  adapter.registerSession('claude:b', { cwd: '/w', ephemeral: 1, forkFrom: 'claude:a' });
  assert.deepEqual(adapter.sessions.get('claude:b'), { cwd: '/w', ephemeral: true, forkFrom: 'claude:a', fresh: true });
  adapter.registerSession('claude:c', { cwd: '', forkFrom: '' });
  assert.equal(adapter.sessions.get('claude:c').forkFrom, null);
  assert.equal(adapter.isFresh('claude:a'), true);
  assert.equal(adapter.isFresh('claude:zz'), false);
  assert.equal(await adapter.cwdOf(ref('claude:b')), '/w');
  assert.equal(await adapter.cwdOf(ref('claude:a')), '/t');
  api.sessionCwd = () => '';
  assert.equal(await adapter.cwdOf(ref('claude:a')), null);
});

test("a chat's own picks: bad ids refused, null clears, non-strings dropped; handover on and off", () => {
  const { adapter } = setup();
  assert.equal(adapter.setOwn('', {}), false);
  assert.equal(adapter.setOwn('c', { model: 'opus', effort: 3, account: '' }), true);
  assert.deepEqual(adapter.own.get('c'), { model: 'opus', effort: null, account: null });
  assert.equal(adapter.setOwn('c', null), true);
  assert.equal(adapter.own.has('c'), false);
  assert.equal(adapter.setOwn('c', 'x'), false);
  adapter.setHandover('c', true);
  assert.ok(adapter.handover.has('c'));
  adapter.setHandover('c', false);
  assert.equal(adapter.handover.has('c'), false);
});

test('with no logins listed only the default one is signed in', () => {
  const { adapter } = setup({ accounts: { active: 'default', accounts: [] } });
  adapter.setOwn(CHAT, { account: 'default' });
  assert.equal(adapter.accountOf(CHAT), 'default');
  adapter.setOwn(CHAT, { account: 'other' });
  assert.equal(adapter.accountOf(CHAT), 'default');
});

test('settings with nothing set: no prefs, no probe, the default permission, opus picked by nobody', () => {
  const { adapter } = setup();
  const s = adapter.settings(CHAT, {});
  assert.deepEqual([s.model, s.effort, s.permission, s.fast, s.picked, s.account], [null, null, 'default', false, null, 'default']);
});

test("settings: the chat's model keeps the default effort, the message's model and effort win, a probe's fast blocker turns fast off", () => {
  const { adapter } = setup({
    prefs: () => ({ claudeSelection: { model: 'sonnet', effort: 'low', fast: true }, permission: 'full-access' }),
    probeInfo: () => ({ models: [{ value: 'opus', supportsAutoMode: true }, { value: 'haiku' }], fastBlocked: 'free' }),
  });
  adapter.setOwn(CHAT, { model: 'opus' });
  let s = adapter.settings(CHAT, {});
  assert.deepEqual([s.model, s.effort, s.fast, s.picked], ['opus', 'low', false, 'opus']);
  adapter.setOwn(CHAT, { model: 'opus', effort: 'max' });
  s = adapter.settings(CHAT, { model: 'haiku', effort: 'high', plan: true });
  assert.deepEqual([s.model, s.effort, s.permission], ['haiku', 'high', 'plan']);
  adapter.setOwn(CHAT, null);
  const n = setup({
    prefs: () => ({ claudeSelection: { model: null, effort: null, fast: true } }),
    probeInfo: () => ({ models: [{ value: 'opus' }] }),
  });
  s = n.adapter.settings(CHAT, {});
  assert.deepEqual([s.picked, s.fast], ['opus', true]);
});

test('startTurn: an item with no text, opts or attachments; a prefix; elsewhere that is not a list; a non-Error failure', async () => {
  const t = setup({ sendResult: { elsewhere: 'nope' } });
  const started = await t.adapter.startTurn(CHAT, ref(CHAT), { attachments: 'x' });
  assert.equal(started.started, true);
  assert.equal(started.turnId, `ct-${started.itemId}`);
  assert.deepEqual(t.sent[0].input, { text: '', attachments: [] });
  assert.equal(t.sent[0].opts.cwd, os.homedir());
  assert.equal(t.sent[0].opts.forkFrom, undefined);
  assert.deepEqual(defined(t.events.at(-1))[0].elsewhere, []);
  assert.equal(defined(t.events.at(-1))[1], 'any');
  // a second turn, with the CLI live
  await t.adapter.startTurn(CHAT, ref(CHAT), {
    text: 'go',
    opts: { prefix: '[handoff]', human: true },
    attachments: [{ kind: 'image', path: '/p', previewUrl: 'data:' }],
  });
  assert.deepEqual(t.sent[1].input, { text: 'go', attachments: [{ kind: 'image', path: '/p' }], prefix: '[handoff]' });
  assert.equal(t.sent[1].meta.human, false);
  const f = setup({ failSend: 'boom' });
  await f.adapter.startTurn(CHAT, ref(CHAT), { text: 'x' });
  assert.equal(defined(f.events.at(-1))[0].error, 'boom');
});

test("a turn on a chat whose CLI is running still names the chat's own folder, for a CLI that replaces it", async () => {
  // a chat from before this run: its folder is the transcript's
  const t = setup({ transcriptCwd: '/proj' });
  await t.adapter.startTurn(CHAT, ref(CHAT), { text: 'one' });
  assert.equal(t.api.isLive(CHAT), true);
  // send() may retire the live CLI (another account, billing, read-only) and resume in the folder it is given
  await t.adapter.startTurn(CHAT, ref(CHAT), { text: 'two' });
  assert.deepEqual(
    t.sent.map((x: any) => x.opts.cwd),
    ['/proj', '/proj'],
  );
});

test('steer: no opts or attachments, and a send that fails is not started', async () => {
  const t = setup();
  await t.adapter.startTurn(CHAT, ref(CHAT), { text: 'x' });
  assert.deepEqual(await t.adapter.steer(CHAT, ref(CHAT), { attachments: 'x' }), { started: true });
  assert.deepEqual(t.sent[1].input, { text: '', attachments: [] });
  assert.equal(t.sent[1].meta.human, false);
  const clientId = t.sent[1].meta.uuid;
  assert.deepEqual(t.events.at(-1), [{ kind: 'steered', key: CHAT, chatId: CHAT, text: '', attachments: [], clientId }, 'any']);
  // a send that fails: the window takes the message back, and the controller sends it as the next turn
  t.adapter.sendTo = async () => {
    throw new Error('gone');
  };
  assert.deepEqual(
    await t.adapter.steer(CHAT, ref(CHAT), { text: 'y', opts: {}, attachments: [{ kind: 'file', path: '/f', previewUrl: 'u' }] }),
    { started: false, error: 'gone' },
  );
  const [shown, failed] = t.events.slice(-2).map(([e]) => e);
  assert.equal(shown.kind, 'steered');
  assert.deepEqual(failed, { kind: 'steerFailed', key: CHAT, chatId: CHAT, clientId: shown.clientId });
});

test('a steer while the first turn is still starting waits for the next turn, not a second start beside it', async () => {
  let open: () => void = () => undefined;
  const t = setup({ sendGate: new Promise<void>((r) => (open = r)) });
  const first = t.adapter.startTurn(CHAT, ref(CHAT), { text: 'first' });
  await new Promise((r) => setImmediate(r));
  // not live yet: the controller queues it (ChatController.steer) rather than a second turn starting
  assert.deepEqual(await t.adapter.steer(CHAT, ref(CHAT), { text: 'more' }), { started: false, error: 'The turn is still starting' });
  assert.equal(t.sent.length, 1);
  open();
  assert.equal((await first).started, true);
  assert.equal(t.adapter.startingTurns.size, 0);
  // two starts at once count down to none
  const a = t.adapter.startTurn(CHAT, ref(CHAT), { text: 'a' });
  const b = t.adapter.startTurn(CHAT, ref(CHAT), { text: 'b' });
  assert.equal(t.adapter.startingTurns.get(CHAT), 2);
  await Promise.all([a, b]);
  assert.equal(t.adapter.startingTurns.size, 0);
});

test('an interrupt that fails is a toast', async () => {
  const t = setup({ failControl: new Error("Error invoking remote method 'x': Error: not running") });
  await t.adapter.interrupt(CHAT);
  assert.deepEqual(t.events.at(-1), [{ kind: 'toast', level: 'error', text: "Couldn't stop: not running" }, 'any']);
  const u = setup({ failControl: 'nope' });
  await u.adapter.interrupt(CHAT, 'claude:k');
  assert.equal(u.events[0][0].key, 'claude:k');
  assert.equal(defined(u.events.at(-1))[0].text, "Couldn't stop: nope");
});

test('observe: nothing without a key; closed and error forget the live settings; others are ignored', () => {
  const t = setup();
  t.adapter.observe(null);
  t.adapter.observe({ kind: 'message' });
  t.adapter.live.set(CHAT, {});
  t.adapter.observe({ key: CHAT, kind: 'status' });
  assert.ok(t.adapter.live.has(CHAT));
  t.adapter.observe({ key: CHAT, kind: 'error' });
  assert.equal(t.adapter.live.has(CHAT), false);
  t.adapter.live.set(CHAT, {});
  t.adapter.observe({ key: CHAT, kind: 'closed' });
  assert.equal(t.adapter.live.has(CHAT), false);
  // a message event without a message is an empty one
  t.adapter.observe({ key: CHAT, kind: 'message' });
  assert.equal(t.events.length, 0);
});

test('rate-limit events note what is left; only a rejected one stops the chat', () => {
  const t = setup({ accounts: TWO });
  t.adapter.live.set(CHAT, { account: 'work' });
  t.adapter.observe(msg('rate_limit_event'));
  assert.equal(t.adapter.marks.get('work'), undefined);
  t.adapter.observe(
    msg('rate_limit_event', {
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25 }, x: null, y: { utilization: 'n/a' } } },
    }),
  );
  assert.deepEqual(t.adapter.marks.get('work'), { left: 75 });
  t.adapter.observe(msg('rate_limit_event', { rate_limit_info: { status: 'allowed', utilization: 0.5 } }));
  assert.deepEqual(t.adapter.marks.get('work'), { left: 50 });
  assert.equal(t.kinds().length, 0);
  t.adapter.observe(
    msg('rate_limit_event', {
      rate_limit_info: {
        status: 'rejected',
        unifiedWindows: {
          five_hour: { utilization: 1, resetsAt: 5000 },
          week: { utilization: 1 },
          other: { utilization: 0.5, resetsAt: 9000 },
        },
      },
    }),
  );
  assert.equal(t.adapter.marks.get('work').limitedUntil, 5_000_000);
  assert.equal(t.adapter.marks.get('work').left, 0);
  assert.ok(t.kinds().includes('accountSwitched'));
  const u = setup();
  u.adapter.marks.usage({ login: true }, 'default', { status: 'rejected', resetsAt: 0 }, NOW);
  assert.equal(u.adapter.marks.get('default').limitedUntil, NOW + LIMIT_HOLD_MS);
  u.adapter.marks.usage({ login: true }, 'default', { status: 'rejected', resetsAt: 7 }, NOW);
  assert.equal(u.adapter.marks.get('default').limitedUntil, 7000);
});

test('a lapsed login is noticed from the error text, even without a known error code', () => {
  for (const m of [
    { error: 'unknown', message: { content: [{ type: 'text', text: 'OAuth token has expired' }] } },
    { error: 'authentication_failed' },
  ]) {
    const t = setup();
    t.adapter.observe(msg('assistant', m));
    assert.equal(t.adapter.marks.get('default').expired, true);
  }
  const t = setup();
  t.adapter.observe(msg('assistant', { error: 'other' }));
  t.adapter.observe(msg('assistant', { error: 'other', message: { content: 'fine' } }));
  assert.equal(t.adapter.marks.get('default'), undefined);
});

test("fast mode: only a session that asked reports why it's off, or that it's on", () => {
  const t = setup();
  t.adapter.observe(msg('system', { subtype: 'init', fast_mode_disabled_reason: 'free' }));
  assert.equal(t.adapter.fastBlocked, null);
  t.adapter.live.set(CHAT, { fast: true, account: 'default' });
  t.adapter.observe(msg('system', { subtype: 'init', fast_mode_disabled_reason: 'free' }));
  assert.equal(t.adapter.fastBlocked, 'free');
  t.adapter.observe(msg('system', { subtype: 'init', fast_mode_disabled_reason: 'weird' }));
  assert.equal(t.adapter.fastBlocked, 'free');
  t.adapter.observe(msg('system', { subtype: 'init', fast_mode_state: 'on' }));
  assert.equal(t.adapter.fastBlocked, null);
  t.adapter.observe(msg('system', { subtype: 'other' }));
  // the blocker a session reported wins over the probe's
  t.adapter.fastBlocked = 'free';
  assert.equal(t.adapter.settings(CHAT, {}).fast, false);
});

test('moving to another login: a limit already held is kept, the login that ran out is recorded, a failing note store is survived', () => {
  const t = setup({ accounts: TWO, movedThrows: true });
  t.adapter.marks.limited({ login: true }, 'default', NOW, 99);
  t.adapter.observe(msg('assistant', { error: 'rate_limit' }));
  assert.equal(t.adapter.marks.get('default').limitedUntil, NOW + 99);
  assert.deepEqual(t.adapter.own.get(CHAT), { model: null, effort: null, account: 'work' });
  assert.equal(t.moved[0].note.turnId, null);
  assert.equal(t.adapter.resume.get(CHAT).goal, null);
  assert.equal(t.adapter.handover.has(CHAT), false);
  // already moving: a second limit changes nothing
  t.adapter.observe(msg('assistant', { error: 'rate_limit' }));
  assert.equal(t.moved.length, 1);
  // its turn ends: it goes on there
  t.state.patch(CHAT, { turn: 'idle' });
  t.adapter.observe(msg('result'));
  return tick().then(() => assert.deepEqual(t.enqueued[0].item.text, 'Continue where you left off.'));
});

test('a goal that was running goes with the chat and is set again on the new login, once its turn is idle', async () => {
  const t = setup({ accounts: TWO });
  t.state.patch(CHAT, { goal: active() });
  t.adapter.setOwn(CHAT, { model: 'opus', effort: 'high' });
  t.adapter.lastTurn.set(CHAT, 'ct-1');
  t.adapter.observe(msg('assistant', { error: 'rate_limit' }));
  assert.deepEqual(t.adapter.own.get(CHAT), { model: 'opus', effort: 'high', account: 'work' });
  assert.equal(t.moved[0].note.turnId, 'ct-1');
  assert.equal(t.adapter.resume.get(CHAT).goal, 'ship it');
  assert.ok(t.adapter.handover.has(CHAT));
  t.state.patch(CHAT, { turn: 'running' });
  t.adapter.observe(msg('result'));
  await tick();
  assert.deepEqual(t.enqueued, [] as any[]);
  // a later move goes on with the goal
  t.adapter.queueContinuation(CHAT, CHAT, 'ship it');
  t.state.patch(CHAT, { turn: 'idle' });
  t.adapter.continueAfterSwitch(CHAT);
  await tick();
  assert.equal(t.enqueued[0].item.text, '/goal ship it');
});

test('nowhere to move with no window open: an active goal is held as usage-limited, otherwise one notification', () => {
  const t = setup({ emitReturns: false, keyMode: () => true });
  t.state.patch(CHAT, { goal: active() });
  t.adapter.sessions.set(CHAT, { ephemeral: true });
  t.adapter.observe(msg('assistant', { error: 'rate_limit' }));
  assert.equal(t.state.get(CHAT).goal.status, 'usageLimited');
  assert.ok(t.adapter.goalCrashed.has(CHAT));
  assert.deepEqual(t.limits, []);
  // said once per turn
  t.adapter.observe(msg('assistant', { error: 'rate_limit' }));
  assert.equal(t.kinds().filter((k) => k === 'limitUnresolved').length, 1);
  const u = setup({ emitReturns: false, keyMode: () => true });
  u.state.patch(CHAT, { goal: { status: 'active' } });
  u.adapter.observe(msg('assistant', { error: 'rate_limit' }));
  assert.deepEqual(u.limits, [[CHAT, 'limit']]);
  const w = setup({ emitReturns: true, keyMode: () => true });
  w.adapter.observe(msg('assistant', { error: 'rate_limit' }));
  assert.deepEqual(w.limits, []);
  // the offer goes only to app windows on screen: a hidden one (Quick Chat's) doesn't count as open
  assert.deepEqual(
    w.events.filter(([e]: any) => e.kind === 'limitUnresolved').map(([, target]: any) => target),
    ['shown'],
  );
});

test('settling a goal turn: a window handing it over skips it; the transcript is read twice when the first read is not met', async () => {
  const t = setup({ goalText: null });
  t.state.patch(CHAT, { goal: active() });
  t.adapter.goalTurns.add(CHAT);
  t.adapter.handover.add(CHAT);
  t.adapter.observe(msg('result'));
  await tick();
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  // a window says so just after the result
  t.adapter.settleLater(CHAT, CHAT, false);
  t.adapter.handover.add(CHAT);
  await tick();
  assert.equal(t.adapter.handover.has(CHAT), false);
  // nothing in the transcript, twice
  let reads = 0;
  t.api.goalStatus = async () => {
    reads++;
    throw new Error('unreadable');
  };
  await t.adapter.settleGoal(CHAT, CHAT);
  assert.equal(reads, 2);
  // not active: nothing to settle
  t.state.patch(CHAT, { goal: null });
  await t.adapter.settleGoal(CHAT, CHAT);
  assert.equal(reads, 2);
});

test('crashed: nothing to hold without an active goal that has an objective', () => {
  const t = setup();
  t.state.patch(CHAT, { goal: null });
  t.adapter.crashed(CHAT);
  t.state.patch(CHAT, { goal: { status: 'active' } });
  t.adapter.crashed(CHAT);
  assert.equal(t.adapter.goalCrashed.size, 0);
});

test('goal buttons: pause, resume, extend and clear by name; nothing to do without a goal; unknown actions rejected', async () => {
  const t = setup();
  t.state.patch(CHAT, { goal: null });
  await t.adapter.goalAction(CHAT, 'pause');
  await t.adapter.goalAction(CHAT, 'resume');
  await t.adapter.goalAction(CHAT, 'extend');
  assert.deepEqual(t.enqueued, [] as any[]);
  await assert.rejects(t.adapter.goalAction(CHAT, 'explode'), /Unknown goal action explode/);
  t.state.patch(CHAT, { goal: active() });
  await t.adapter.goalAction(CHAT, 'pause');
  assert.equal(t.state.get(CHAT).goal.status, 'paused');
  await t.adapter.goalAction(CHAT, 'resume');
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  assert.equal(t.state.get(CHAT).goal.claude.limit, null);
  // a goal that is not at its round limit can't be extended
  await t.adapter.goalAction(CHAT, 'extend');
  t.state.patch(CHAT, { goal: active({ status: 'budgetLimited', claude: { iterations: 20, limit: 20 } }) });
  t.adapter.goalCrashed.add(CHAT);
  await t.adapter.goalAction(CHAT, 'extend');
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  assert.deepEqual(
    t.enqueued.slice(-2).map((e) => e.item.text),
    ['/goal clear', '/goal ship it'],
  );
  t.adapter.goalCrashed.add(CHAT);
  await t.adapter.goalAction(CHAT, 'clear', true);
  assert.equal(t.state.get(CHAT).goal, null);
  assert.deepEqual(defined(t.enqueued.at(-1)).item, { text: '/goal clear', attachments: [], opts: { human: true, goalClear: true } });
  // resuming a goal that can't be resumed does nothing
  t.state.patch(CHAT, { goal: { status: 'complete', objective: 'x' } });
  const before = t.enqueued.length;
  await t.adapter.goalAction(CHAT, 'resume');
  await t.adapter.goalAction(CHAT, 'clear');
  assert.equal(t.enqueued.length, before);
});

test('a goal write that changed nothing sends no notice', () => {
  const t = setup();
  const notices: any[] = [];
  t.adapter.notifyGoal = (...a: any[]) => notices.push(a);
  t.adapter.writeGoal = () => false;
  t.state.patch(CHAT, { goal: active() });
  assert.equal(t.adapter.setGoal(CHAT, { status: 'complete', objective: 'ship it' }), false);
  assert.deepEqual(notices, []);
  t.adapter.writeGoal = () => true;
  assert.equal(t.adapter.setGoal(CHAT, { status: 'complete', objective: 'ship it' }), true);
  assert.deepEqual(notices, [[CHAT, { status: 'complete', body: 'Goal complete' }]]);
});

test('a goal over its round limit is marked budget-limited even when stopping its loop fails', async () => {
  const t = setup();
  t.api.metered = () => true;
  const plans: any[] = [];
  t.adapter.runPlan = async (_chatId: string, plan: any) => {
    plans.push(plan);
    throw new Error('CLI gone');
  };
  t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: ship' }] } }));
  t.state.patch(CHAT, { turn: 'running' });
  const check = { type: 'user', message: { content: [{ type: 'text', text: 'Stop hook feedback:\n[ship]: no' }] } };
  for (let i = 0; i < 30; i++) t.adapter.observe({ key: CHAT, kind: 'message', msg: check });
  await tick();
  assert.equal(t.state.get(CHAT).goal.status, 'budgetLimited');
  assert.equal(plans.length, 1, 'the pause was attempted');
});

test('a goal turn that cannot be settled after the grace period stays as it was', async () => {
  const t = setup();
  t.state.patch(CHAT, { goal: active() });
  let settles = 0;
  t.adapter.settleGoal = async () => {
    settles++;
    throw new Error('transcript gone');
  };
  t.adapter.settleLater(CHAT, CHAT, false);
  await tick();
  assert.equal(settles, 1);
  assert.equal(t.state.get(CHAT).goal.status, 'active');
});

test('messages from a previous Claude segment cannot overwrite goals or hand over a replacement turn', () => {
  for (const selected of [
    { kind: 'codex', key: 'new' },
    { kind: 'claude', key: 'claude:new' },
  ]) {
    const t = setup();
    t.adapter.refOf = () => selected;
    t.state.patch(CHAT, { turn: 'running', goal: active({ objective: 'replacement goal' }) });
    t.adapter.live.set(CHAT, { account: 'default' });
    for (const event of [
      msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: stale old goal' }] } }),
      msg('assistant', { error: 'authentication_failed' }),
      msg('rate_limit_event', { rate_limit_info: { status: 'rejected' } }),
      msg('result', { subtype: 'success' }),
    ])
      t.adapter.observe(event);
    assert.equal(t.state.get(CHAT).goal.objective, 'replacement goal');
    assert.equal(t.state.get(CHAT).goal.status, 'active');
    assert.equal(t.adapter.goalTurns.size, 0);
    assert.equal(t.controls.length, 0);
    assert.equal(t.events.length, 0);
    t.adapter.observe({ key: CHAT, kind: 'closed' });
    assert.equal(t.adapter.live.has(CHAT), false);
  }
});

test('an unreadable selected session cannot let an old Claude message change its goal', () => {
  const t = setup();
  t.state.patch(CHAT, { goal: active({ objective: 'keep' }) });
  t.adapter.refOf = () => {
    throw new Error('unsupported future harness');
  };
  t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: stale' }] } }));
  assert.equal(t.state.get(CHAT).goal.objective, 'keep');
});

test('a transcript read for an old goal cannot stop a replacement goal', async () => {
  const t = setup();
  t.state.patch(CHAT, { goal: active({ objective: 'old goal' }) });
  let finish!: (text: string) => void;
  t.api.goalStatus = () => new Promise<string>((r) => (finish = r));
  const pending = t.adapter.settleGoal(CHAT, CHAT);
  t.state.patch(CHAT, { goal: active({ objective: 'new goal' }) });
  finish(JSON.stringify({ attachment: { type: 'goal_status', met: true, condition: 'old goal' } }));
  await pending;
  assert.equal(t.state.get(CHAT).goal.objective, 'new goal');
  assert.equal(t.state.get(CHAT).goal.status, 'active');
});

test('a result grace timer cannot settle a goal created after the result', async () => {
  const t = setup();
  t.state.patch(CHAT, { goal: active({ objective: 'old goal' }) });
  let reads = 0;
  t.api.goalStatus = async () => {
    reads++;
    return JSON.stringify({ attachment: { type: 'goal_status', met: true, condition: 'old goal' } });
  };
  t.adapter.settleLater(CHAT, CHAT, false);
  t.state.patch(CHAT, { goal: active({ objective: 'new goal' }) });
  await tick();
  assert.equal(reads, 0);
  assert.equal(t.state.get(CHAT).goal.status, 'active');
});

test('a delayed login resume cannot restart a goal cleared after its result', async () => {
  const t = setup();
  t.state.patch(CHAT, { goal: active() });
  t.adapter.queueContinuation(CHAT, CHAT, 'ship it');
  t.adapter.continueAfterSwitch(CHAT);
  t.state.patch(CHAT, { goal: null });
  await tick();
  assert.deepEqual(t.enqueued, []);
});

test('goal settlement rejects old native sessions, unreadable refs and a newer turn', async () => {
  for (const changed of ['harness', 'session', 'unreadable', 'turn', 'running']) {
    const t = setup();
    t.state.patch(CHAT, { goal: active() });
    let finish!: (text: string) => void;
    t.api.goalStatus = () => new Promise<string>((r) => (finish = r));
    const pending = t.adapter.settleGoal(CHAT, CHAT);
    if (changed === 'harness') t.adapter.refOf = () => ({ kind: 'codex', key: 'new' });
    if (changed === 'session') t.adapter.refOf = () => ({ kind: 'claude', key: 'claude:new' });
    if (changed === 'unreadable')
      t.adapter.refOf = () => {
        throw new Error('future session');
      };
    if (changed === 'turn') await t.adapter.startTurn(CHAT, ref(CHAT), { text: 'new message', opts: {} });
    if (changed === 'running') t.state.patch(CHAT, { turn: 'running' });
    finish(JSON.stringify({ attachment: { type: 'goal_status', met: true, condition: 'ship it' } }));
    await pending;
    assert.equal(t.state.get(CHAT).goal.status, 'active');
    assert.equal(t.adapter.goalWork.settle.size, 0);
  }
});

test('goal settlement rechecks context before retrying and after the second transcript read', async () => {
  for (const changedDuring of ['flush', 'second-read']) {
    const t = setup();
    t.state.patch(CHAT, { goal: active() });
    let reads = 0;
    let finish!: (text: string) => void;
    t.api.goalStatus = () => {
      if (++reads === 1) return Promise.resolve(null);
      return new Promise<string>((r) => (finish = r));
    };
    const pending = t.adapter.settleGoal(CHAT, CHAT);
    await tick(changedDuring === 'flush' ? 5 : 450);
    t.state.patch(CHAT, { goal: active({ objective: 'new goal' }) });
    if (changedDuring === 'second-read') finish(JSON.stringify({ attachment: { type: 'goal_status', met: true } }));
    await pending;
    assert.equal(reads, changedDuring === 'flush' ? 1 : 2);
    assert.equal(t.state.get(CHAT).goal.status, 'active');
    assert.equal(t.state.get(CHAT).goal.objective, 'new goal');
    assert.equal(t.adapter.goalWork.settle.size, 0);
  }
});

test('a newer settlement supersedes an older read for the same goal and releases only its own work', async () => {
  const t = setup();
  t.state.patch(CHAT, { goal: active() });
  const finishes: ((text: string) => void)[] = [];
  t.api.goalStatus = () => new Promise<string>((r) => finishes.push(r));
  const old = t.adapter.settleGoal(CHAT, CHAT);
  const current = t.adapter.settleGoal(CHAT, CHAT);
  finishes[0](JSON.stringify({ attachment: { type: 'goal_status', met: true, reason: 'old' } }));
  await old;
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  assert.equal(t.adapter.goalWork.settle.size, 1);
  finishes[1](JSON.stringify({ attachment: { type: 'goal_status', met: true, reason: 'latest' } }));
  await current;
  assert.equal(t.state.get(CHAT).goal.status, 'complete');
  assert.equal(t.state.get(CHAT).goal.claude.lastReason, 'latest');
  assert.equal(t.adapter.goalWork.settle.size, 0);
});

test('login continuation timers are latest-only and cannot send into a different native session', async () => {
  for (const changed of ['duplicate', 'harness', 'session', 'turn']) {
    const t = setup();
    t.state.patch(CHAT, { goal: active() });
    t.adapter.queueContinuation(CHAT, CHAT, 'ship it');
    t.adapter.continueAfterSwitch(CHAT);
    if (changed === 'duplicate') {
      t.adapter.queueContinuation(CHAT, CHAT, 'ship it');
      t.adapter.continueAfterSwitch(CHAT);
    }
    if (changed === 'harness') t.adapter.refOf = () => ({ kind: 'codex', key: 'new' });
    if (changed === 'session') t.adapter.refOf = () => ({ kind: 'claude', key: 'claude:new' });
    if (changed === 'turn') await t.adapter.startTurn(CHAT, ref(CHAT), { text: 'new message', opts: {} });
    await tick();
    assert.equal(t.enqueued.length, changed === 'duplicate' ? 1 : 0);
    assert.equal(t.adapter.goalWork.resume.size, 0);
  }
});

for (const action of ['pause', 'clear'])
  test(`${action} on an old goal cannot clear a replacement after the interrupt completes`, async () => {
    const t = setup();
    t.state.patch(CHAT, { turn: 'running', goal: active({ objective: 'old' }) });
    let finish!: () => void;
    t.api.control = () => new Promise<void>((r) => (finish = r));
    const pending = t.adapter.goalAction(CHAT, action);
    t.state.patch(CHAT, { turn: 'idle', goal: active({ objective: 'replacement' }) });
    finish();
    await pending;
    assert.equal(t.state.get(CHAT).goal.objective, 'replacement');
    assert.equal(t.state.get(CHAT).goal.status, 'active');
    assert.deepEqual(t.enqueued, []);
  });

test('a goal plan rechecks context after waiting for the interrupted turn to become idle', async () => {
  const t = setup();
  t.state.patch(CHAT, { turn: 'running', goal: active({ objective: 'old' }) });
  const pending = t.adapter.clearGoal(CHAT);
  await tick();
  assert.equal(t.controls.length, 1);
  t.state.patch(CHAT, { goal: active({ objective: 'replacement' }) });
  await tick();
  t.state.patch(CHAT, { turn: 'idle' });
  await pending;
  assert.equal(t.state.get(CHAT).goal.objective, 'replacement');
  assert.deepEqual(t.enqueued, []);
  assert.equal(t.adapter.goalWork.plan.size, 0);
});

test('own queued goal commands may start turns immediately without cancelling the rest of the plan', async () => {
  const t = setup();
  t.state.patch(CHAT, { goal: active({ status: 'paused' }) });
  t.adapter.goalCrashed.add(CHAT);
  const starts: Promise<any>[] = [];
  t.adapter.enqueue = (chatId: string, item: any) => {
    t.enqueued.push({ chatId, item });
    starts.push(t.adapter.startTurn(chatId, ref(chatId), item));
  };
  await t.adapter.resumeGoal(CHAT);
  await Promise.all(starts);
  assert.deepEqual(
    t.enqueued.map((e: any) => e.item.text),
    ['/goal clear', '/goal ship it'],
  );
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  assert.equal(t.adapter.goalWork.plan.size, 0);
});

test('a goal cleared before the rate-limited result cannot be revived by login continuation', async () => {
  const t = setup({ accounts: TWO });
  t.state.patch(CHAT, { goal: active({ objective: 'old goal' }) });
  t.adapter.limited(CHAT, CHAT, 'default', 'limit');
  t.state.patch(CHAT, { goal: null });
  t.adapter.observe(msg('result'));
  await tick();
  assert.deepEqual(t.enqueued, []);
});

test('a queued turn retains goal completion tracking until its own result, even with transcript-only status', async () => {
  const t = setup({ goalText: JSON.stringify({ attachment: { type: 'goal_status', met: true, condition: 'ship it' } }) });
  t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: ship it' }] } }));
  // Controller drains the next turn before forwarding the preceding result to the adapter.
  await t.adapter.startTurn(CHAT, ref(CHAT), { text: 'follow up', opts: {} });
  t.state.patch(CHAT, { turn: 'running' });
  t.adapter.observe(msg('result'));
  await tick();
  assert.equal(t.state.get(CHAT).goal.status, 'active');
  t.state.patch(CHAT, { turn: 'idle' });
  t.adapter.observe(msg('result'));
  await tick();
  assert.equal(t.state.get(CHAT).goal.status, 'complete');
});

test('a continuation whose turn crashed cannot suppress a later login limit', () => {
  const t = setup({ accounts: { active: 'default', accounts: [...TWO.accounts, { id: 'spare', loggedIn: true }] } });
  t.state.patch(CHAT, { goal: active({ objective: 'old goal' }) });
  t.adapter.limited(CHAT, CHAT, 'default', 'limit');
  t.adapter.crashed(CHAT);
  t.state.patch(CHAT, { goal: active({ objective: 'new goal' }) });
  t.adapter.lastTurn.set(CHAT, 'new-turn');
  t.adapter.limited(CHAT, CHAT, 'work', 'limit');
  assert.equal(t.moved.length, 2);
  assert.equal(t.adapter.own.get(CHAT).account, 'spare');
  assert.equal(t.adapter.resume.get(CHAT).goal, 'new goal');
});

test('a delayed own clear reply cannot erase the fresh ten-round restart', async () => {
  const t = setup();
  t.api.metered = () => true;
  t.state.patch(CHAT, { goal: active({ status: 'budgetLimited', claude: { iterations: 30, limit: 30 } }) });
  // The pause's clear turn started, but its output has not reached the observer yet.
  await t.adapter.startTurn(CHAT, ref(CHAT), { text: '/goal clear', opts: { goalClear: true } });
  await t.adapter.extendGoal(CHAT);
  t.adapter.observe(msg('system', { subtype: 'local_command_output', content: 'Goal cleared: ship it' }));
  assert.equal(t.state.get(CHAT).goal?.claude?.limit, 10, 'the old clear reply must not discard the restart limit');
  await t.adapter.startTurn(CHAT, ref(CHAT), t.enqueued.at(-1).item);
  t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: ship it' }] } }));
  assert.equal(t.state.get(CHAT).goal.claude.limit, 10, 'the CLI acknowledgment retains the requested extra rounds');
});

test('old feedback and results cannot consume a pending ten-round restart', async () => {
  const t = setup();
  t.api.metered = () => true;
  t.state.patch(CHAT, { goal: active({ status: 'budgetLimited', claude: { iterations: 30, limit: 30 } }) });
  await t.adapter.extendGoal(CHAT);
  for (const event of [
    msg('user', { message: { content: [{ type: 'text', text: 'Stop hook feedback:\n[ship it]: old round' }] } }),
    msg('system', { subtype: 'local_command_output', content: 'No goal set' }),
    msg('system', { subtype: 'local_command_output', content: 'Goal active: ship it' }),
    msg('result'),
  ])
    t.adapter.observe(event);
  assert.deepEqual(
    [t.state.get(CHAT).goal.status, t.state.get(CHAT).goal.claude.iterations, t.state.get(CHAT).goal.claude.limit],
    ['active', 0, 10],
  );
  await t.adapter.startTurn(CHAT, ref(CHAT), t.enqueued.at(-1).item);
  t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: ship it' }] } }));
  assert.equal(t.adapter.goalRestarts.size, 0);
  assert.equal(t.state.get(CHAT).goal.claude.limit, 10);
  t.adapter.observe(msg('system', { subtype: 'local_command_output', content: 'Goal cleared: ship it' }));
  assert.equal(t.state.get(CHAT).goal, null, 'an ordinary clear after acknowledgement still applies');
});

test('restart ownership retires on replacement, failure and crash', async () => {
  for (const change of ['message', 'goal', 'crash', 'failure']) {
    const t = setup();
    t.state.patch(CHAT, { goal: active({ status: 'paused', claude: { iterations: 3, limit: 10 } }) });
    await t.adapter.resumeGoal(CHAT);
    if (change === 'message') await t.adapter.startTurn(CHAT, ref(CHAT), { text: 'hello', opts: { human: true } });
    if (change === 'goal') t.adapter.setGoal(CHAT, active({ objective: 'replacement' }));
    if (change === 'crash') t.adapter.crashed(CHAT);
    if (change === 'failure') {
      t.adapter.sendTo = async () => {
        throw new Error('send failed');
      };
      await t.adapter.startTurn(CHAT, ref(CHAT), t.enqueued.at(-1).item);
      assert.equal(t.state.get(CHAT).goal.status, 'stopped');
      assert.equal(t.state.get(CHAT).goal.claude.limit, 10);
    }
    assert.equal(t.adapter.goalRestarts.size, 0, change);
  }
});

test('extending during a deferred pause ignores feedback from the interrupted turn', async () => {
  const t = setup();
  t.api.metered = () => true;
  t.state.patch(CHAT, { goal: active({ claude: { iterations: 30, limit: 30 } }), turn: 'running' });
  let finish!: () => void;
  t.adapter.interrupt = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const pausing = t.adapter.pauseGoal(CHAT, 'budgetLimited');
  await t.adapter.extendGoal(CHAT);
  t.adapter.observe(msg('user', { message: { content: [{ type: 'text', text: 'Stop hook feedback:\n[ship it]: old round' }] } }));
  t.state.patch(CHAT, { turn: 'idle' });
  finish();
  await pausing;
  await t.adapter.startTurn(CHAT, ref(CHAT), t.enqueued.at(-1).item);
  t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: ship it' }] } }));
  assert.deepEqual([t.state.get(CHAT).goal.claude.iterations, t.state.get(CHAT).goal.claude.limit], [0, 10]);
});

test('a restart that ends without its expected Goal set acknowledgement stops instead of waiting forever', async () => {
  const t = setup();
  t.state.patch(CHAT, { goal: active({ status: 'paused', claude: { iterations: 3, limit: 10 } }) });
  await t.adapter.resumeGoal(CHAT);
  await t.adapter.startTurn(CHAT, ref(CHAT), t.enqueued.at(-1).item);
  t.adapter.observe(msg('result'));
  assert.equal(t.adapter.goalRestarts.size, 0);
  assert.equal(t.state.get(CHAT).goal.status, 'stopped');
  assert.equal(t.state.get(CHAT).goal.claude.limit, 10);
});

test('queued restarts are discarded when paused, replaced, switched or already acknowledged', async () => {
  for (const change of ['pause', 'clear', 'restart', 'session', 'ack']) {
    const t = setup();
    t.state.patch(CHAT, { goal: active({ status: 'budgetLimited', claude: { iterations: 30, limit: 30 } }) });
    await t.adapter.extendGoal(CHAT);
    const queued = t.enqueued.at(-1).item;
    if (change === 'pause') await t.adapter.pauseGoal(CHAT);
    if (change === 'clear') await t.adapter.clearGoal(CHAT);
    if (change === 'restart') {
      t.adapter.setGoal(CHAT, active({ status: 'paused' }));
      await t.adapter.resumeGoal(CHAT);
    }
    if (change === 'session') t.adapter.goalRestarts.get(CHAT).key = 'claude:other';
    if (change === 'ack') t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: ship it' }] } }));
    const before = t.sent.length;
    assert.deepEqual(await t.adapter.startTurn(CHAT, ref(CHAT), queued), { started: false, discarded: true });
    assert.equal(t.sent.length, before, change);
    if (change === 'pause') assert.equal(t.state.get(CHAT).goal.status, 'paused');
  }
});

test('restart admission is rechecked after delayed live controls before sending', async () => {
  for (const change of ['pause', 'clear', 'goal', 'session', 'unchanged']) {
    const t = setup();
    t.state.patch(CHAT, { goal: active({ status: 'paused', claude: { iterations: 3, limit: 10 } }) });
    await t.adapter.resumeGoal(CHAT);
    const queued = t.enqueued.at(-1).item;
    t.live.add(CHAT);
    t.adapter.live.set(CHAT, { account: 'default', model: 'previous', effort: null, permission: 'default', fast: false });
    const control = deferred<void>();
    t.api.control = mock.fn(() => control.promise);
    const pending = t.adapter.startTurn(CHAT, ref(CHAT), queued);
    await Promise.resolve(); // Native settings operations enter their per-process queue before controls begin.
    assert.equal(t.api.control.mock.callCount(), 1);
    if (change === 'pause') await t.adapter.pauseGoal(CHAT);
    if (change === 'clear') await t.adapter.clearGoal(CHAT);
    if (change === 'goal') t.adapter.setGoal(CHAT, active({ objective: 'replacement' }));
    if (change === 'session') t.adapter.refOf = () => ({ kind: 'claude', id: 'other', key: 'claude:other' });
    control.resolve();
    const result = await pending;
    assert.equal(result.started, change === 'unchanged', change);
    assert.equal(t.sent.length, change === 'unchanged' ? 1 : 0, change);
  }
});

test('Pause, Clear and replacement reject the late acknowledgement of an already-sent restart', async () => {
  for (const change of ['pause', 'clear', 'replace', 'crash']) {
    const t = setup();
    t.state.patch(CHAT, { goal: active({ status: 'paused', claude: { iterations: 3, limit: 10 } }) });
    await t.adapter.resumeGoal(CHAT);
    await t.adapter.startTurn(CHAT, ref(CHAT), t.enqueued.at(-1).item);
    if (change === 'pause') await t.adapter.pauseGoal(CHAT);
    if (change === 'clear') await t.adapter.clearGoal(CHAT);
    if (change === 'replace') t.adapter.setGoal(CHAT, active({ objective: 'replacement' }));
    if (change === 'crash') t.adapter.crashed(CHAT);
    const desired = t.state.get(CHAT).goal;
    t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: ship it' }] } }));
    assert.equal(t.state.get(CHAT).goal, desired, change);
    assert.equal(t.adapter.retiredGoalSets.size, 1);
    t.adapter.observe(msg('result'));
    assert.equal(t.adapter.retiredGoalSets.size, 0);
    // A new intentional command owns its own acknowledgement, even for the same condition.
    await t.adapter.startTurn(CHAT, ref(CHAT), { text: '/goal ship it', opts: { human: true } });
    t.adapter.observe(msg('assistant', { message: { content: [{ type: 'text', text: 'Goal set: ship it' }] } }));
    assert.equal(t.state.get(CHAT).goal.status, 'active');
  }
});
