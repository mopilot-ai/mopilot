// The window's adapters to main: Codex requests and API calls, the chat proxy, the per-harness
// semantic handlers, and the MCP rows a chat lists.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';

const { codexIsIdle, codexLeftIdle, codexRequest, respondToCodex, onCodexNotification } = await import('../src/harness/adapters/codex.ts');
// Codex is not left idle until the store says so
const idleAtStart = codexLeftIdle();
const { codexApi } = await import('../src/harness/adapters/codexApi.ts');
const { chatProxy } = await import('../src/harness/adapters/proxy.ts');
const { handlerFor, registerSemantic } = await import('../src/harness/adapters/semantics.ts');
// the built-in handlers, as the composition root registers them
(await import('../src/session/harness/adapters/handlers.ts')).registerSemanticHandlers();
const { pauseCodexGoal } = await import('../src/session/harness/adapters/codexSemantics.ts');
const { loadMcpRows } = await import('../src/session/harness/mcpRows.ts');

const log: any[] = [];
const rec =
  (name: string, ret: any = undefined) =>
  (...args: any[]) => (log.push([name, ...args]), typeof ret === 'function' ? ret(...args) : ret);
const call = (h: any, chatId: string, args = '') => h({ chatId, args, cap: {} as any });

beforeEach(() => {
  reset();
  log.length = 0;
  codexIsIdle(() => false);
});

test('Codex requests reject while Codex is left idle, else go to main with empty params by default', async () => {
  assert.equal(idleAtStart, false);
  fx.native.codex = {
    request: rec('request', async () => 'ok'),
    respond: rec('respond', async () => {
      throw new Error('gone');
    }),
    api: rec('api', async () => 'api'),
  };
  assert.equal(await codexRequest('thread/read'), 'ok');
  assert.equal(await codexRequest('thread/read', { threadId: 't' }), 'ok');
  assert.deepEqual(log, [
    ['request', 'thread/read', {}],
    ['request', 'thread/read', { threadId: 't' }],
  ]);
  await assert.rejects(respondToCodex(7, { ok: true }), /gone/, 'a failed answer rejects: resolveRequest says so and puts the card back');
  assert.equal(await codexApi.threadRead('t1'), 'api');
  assert.deepEqual(log.at(-1), ['api', 'threadRead', ['t1']]);
  codexIsIdle(() => true);
  assert.equal(codexLeftIdle(), true);
  await assert.rejects(codexRequest('x'), /Codex isn't started/);
  await assert.rejects(codexApi.modelList(), /Codex isn't started/);
});

test('every Codex API method is a call by its own name', async () => {
  fx.native.codex = { api: async (name: string, args: any[]) => [name, args] };
  for (const [name, fn] of Object.entries(codexApi)) assert.deepEqual(await (fn as any)('a', 'b'), [name, ['a', 'b']]);
});

test('Codex notifications reach the handler; other item kinds do not', () => {
  let sink: any;
  fx.native.codex = { onItem: (h: any) => ((sink = h), () => 'off') };
  const got: any[] = [];
  const off = onCodexNotification((m, p) => got.push([m, p]));
  sink({ kind: 'notification', method: 'turn/started', params: { a: 1 } });
  sink({ kind: 'request', method: 'x', params: {} });
  assert.deepEqual(got, [['turn/started', { a: 1 }]]);
  assert.equal(off(), 'off');
});

test('the chat proxy sends intents to main; new-session failures resolve false', async () => {
  const s = (name: string) => rec(name, async () => name);
  fx.native.session = {
    send: rec('send', async () => ({ action: 'started', id: 'send-request' })),
    removeQueued: s('removeQueued'),
    sendNow: s('sendNow'),
    claudeStop: s('claudeStop'),
    acpCancel: s('acpCancel'),
    claudeGoal: s('claudeGoal'),
    claudeOwn: s('claudeOwn'),
    handoffNote: s('handoffNote'),
    claudeHandover: s('claudeHandover'),
    claudeNew: rec('claudeNew', async () => {
      throw new Error('x');
    }),
    acpNew: rec('acpNew', async () => {
      throw new Error('x');
    }),
  };
  await chatProxy.send('c', 'hi');
  await chatProxy.send('c', 'hi', [{ type: 'image' } as any], { human: true }, 'steer', 'r1');
  await chatProxy.removeQueued('c', 'q');
  await chatProxy.sendNow('c', 'q');
  await chatProxy.stopClaude('c', 'm1');
  await chatProxy.stopAcp('k', 'm2');
  await chatProxy.claudeGoal('c', 'pause');
  await chatProxy.claudeGoal('c', 'clear', true);
  assert.equal(await chatProxy.newClaudeSession('k', { cwd: '/w' }), false);
  assert.equal(await chatProxy.newAcpSession('k', { cwd: '/w' }), false);
  await chatProxy.claudeOwn('c', null);
  await chatProxy.handoffNote('c', 'Kimi');
  await chatProxy.claudeHandover('c', true);
  assert.deepEqual(log, [
    ['send', 'c', { text: 'hi', attachments: [], opts: {} }],
    ['send', 'c', { text: 'hi', attachments: [{ type: 'image' }], opts: { human: true }, id: 'r1', followUp: 'steer' }],
    ['removeQueued', 'c', 'q'],
    ['sendNow', 'c', 'q'],
    ['claudeStop', 'c', 'm1'],
    ['acpCancel', 'k', 'm2'],
    ['claudeGoal', 'c', 'pause', false],
    ['claudeGoal', 'c', 'clear', true],
    ['claudeNew', 'k', { cwd: '/w' }],
    ['acpNew', 'k', { cwd: '/w' }],
    ['claudeOwn', 'c', null],
    ['handoffNote', 'c', 'Kimi'],
    ['claudeHandover', 'c', true],
  ]);
});

test('Retry admission travels beside input and is absent from queue options; stale main refusals reach the caller', async () => {
  fx.native.session = { send: rec('send', async () => ({ action: 'started', id: 'retry' })) };
  await chatProxy.send('c', 'original', [], { human: true, retryAtRevision: 0 });
  assert.deepEqual(log, [['send', 'c', { text: 'original', attachments: [], opts: { human: true }, retryAtRevision: 0 }]]);
  fx.native.session.send = async () => {
    throw new Error('The chat changed before Retry reached it.');
  };
  await assert.rejects(chatProxy.send('c', 'original', [], { human: true, retryAtRevision: 7 }), /chat changed/);
});

test('handlerFor: a registered handler wins; built-ins load per harness; unknown is null', async () => {
  const mine = () => 'mine';
  registerSemantic('codex', 'speed' as any, mine);
  assert.equal(await handlerFor('codex', 'speed' as any), mine);
  assert.equal(typeof (await handlerFor('codex', 'rename')), 'function');
  assert.equal(typeof (await handlerFor('claude', 'rename')), 'function');
  assert.equal(await handlerFor('claude', 'speed' as any), null);
  assert.equal(await handlerFor('acp' as any, 'rename'), null);
  registerSemantic('acp' as any, 'rename', mine);
  assert.equal(await handlerFor('acp' as any, 'rename'), mine);
});

test('Claude handlers leave compaction to the shared queue and run goals, rename, shell, fork and rewind', async () => {
  fx.native.session = {
    claudeGoal: rec('goal', async () => true),
    send: rec('send', async () => ({ action: 'started', id: 'command-request' })),
  };
  fx.native.claude = { rename: rec('rename', async () => {}), fork: rec('fork', async () => ({ sessionId: 'forked' })) };
  fx.store.editClaudeMessage = () => true;
  const h = (s: string) => handlerFor('claude', s as any) as Promise<any>;
  for (const a of ['pause', 'resume', 'extend', 'clear', 'clear human']) await call(await h('goal'), 'claude:c', a);
  assert.deepEqual(
    log.filter((x) => x[0] === 'goal'),
    [
      ['goal', 'claude:c', 'pause', false],
      ['goal', 'claude:c', 'resume', false],
      ['goal', 'claude:c', 'extend', false],
      ['goal', 'claude:c', 'clear', false],
      ['goal', 'claude:c', 'clear', true],
    ],
  );
  await call(await h('rename'), 'claude:c', 'New name');
  assert.deepEqual(log.at(-1), ['rename', 'c', 'New name']);
  assert.equal(await h('compact'), null);
  await call(await h('shell'), 'claude:c', 'ls');
  assert.equal(log.at(-1)?.[2].text, '!ls');
  assert.equal(await call(await h('fork'), 'claude:c', ''), 'claude:forked');
  assert.deepEqual(log.at(-1), ['fork', 'c', null]);
  assert.deepEqual(called('navigate').at(-1), [{ name: 'thread', id: 'claude:forked' }]);
  assert.deepEqual(called('toast').at(-1), ['Forked into a new chat']);
  assert.equal(await call(await h('rewind'), 'claude:c', 't1'), true);
  assert.deepEqual(called('editClaudeMessage'), [['claude:c', 't1']]);
});

test('Codex goal: pause sets paused and interrupts; failures are toasted', async () => {
  fx.sessions.c = { goal: { status: 'active' } };
  fx.state.runtime.c = { activeTurnId: 'turn-1', turns: [] };
  fx.store.withLease = async () => ({ goal: { status: 'paused' } });
  fx.native.codex = {
    request: rec('request', async () => {
      throw new Error('nope');
    }),
  };
  await pauseCodexGoal('c');
  assert.deepEqual(called('setGoalState'), [['c', { status: 'paused' }]]);
  assert.deepEqual(log, [['request', 'turn/interrupt', { threadId: 'c', turnId: 'turn-1' }]]);
  assert.deepEqual(called('toast'), [["Couldn't stop: nope", 'error']]);
  // a failed pause is reported; a hung one does not hold up the interrupt
  reset();
  fx.sessions.c = { goal: { status: 'active' } };
  fx.store.withLease = async () => {
    throw new Error('goals feature is disabled');
  };
  await pauseCodexGoal('c');
  assert.deepEqual(called('toast'), [
    [
      "Couldn't pause goal: Goals are turned off in Codex settings: set features.goals = true in config.toml (Settings → Codex → Advanced)",
      'error',
    ],
  ]);
  assert.deepEqual(called('setGoalState'), []);
  reset();
  fx.sessions.c = { goal: { status: 'active' } };
  fx.store.withLease = () => new Promise(() => {});
  const t0 = Date.now();
  await pauseCodexGoal('c');
  assert.ok(Date.now() - t0 >= 450);
  assert.deepEqual(called('setGoalState'), []);
  // an object without a goal sets nothing; an error that is not an Error is shown as is
  reset();
  fx.sessions.c = { goal: { status: 'active' } };
  fx.state.runtime.c = { activeTurnId: 'turn-2', turns: [] };
  fx.store.withLease = async () => ({});
  fx.native.codex = {
    request: async () => {
      throw 'plain';
    },
  };
  await pauseCodexGoal('c');
  assert.deepEqual(called('setGoalState'), []);
  assert.deepEqual(called('toast'), [["Couldn't stop: plain", 'error']]);
});

test('Codex goal: resume, budget, edit and clear, each through the lease', async () => {
  const goal = (args: string) => handlerFor('codex', 'goal').then((h) => call(h, 'c', args));
  let result: any = { goal: { status: 'active' } };
  fx.store.withLease = async (...a: any[]) => (log.push(a), result);
  // resume: only a paused goal
  fx.sessions.c = { goal: { status: 'paused' } };
  await goal('resume');
  assert.deepEqual(log.at(-1), ['c', 'thread/goal/set', { threadId: 'c', status: 'active' }]);
  assert.deepEqual(called('setGoalState').at(-1), ['c', { status: 'active' }]);
  result = null;
  await goal('resume');
  assert.equal(called('setGoalState').length, 1);
  fx.store.withLease = async () => {
    throw new Error('ephemeral thread');
  };
  await goal('resume');
  assert.deepEqual(called('toast').at(-1), ["Couldn't resume goal: Temporary chats can't have goals", 'error']);

  // budget
  fx.store.withLease = async (...a: any[]) => (log.push(a), result);
  await goal('budget lots');
  assert.deepEqual(called('toast').at(-1), ['Budget: a number of tokens like 200k, or none', 'error']);
  result = { goal: { tokenBudget: 200000 } };
  await goal('budget 200k');
  assert.deepEqual(log.at(-1), ['c', 'thread/goal/set', { threadId: 'c', tokenBudget: 200000 }]);
  assert.deepEqual(called('setGoalState').at(-1), ['c', { tokenBudget: 200000 }]);
  result = undefined;
  await goal('budget none');
  assert.deepEqual(log.at(-1), ['c', 'thread/goal/set', { threadId: 'c', tokenBudget: null }]);
  fx.store.withLease = async () => {
    throw new Error('boom');
  };
  await goal('budget 5');
  assert.deepEqual(called('toast').at(-1), ["Couldn't set the budget: boom", 'error']);
  fx.sessions.c = { goal: null };
  await goal('budget 5');
  assert.deepEqual(called('loadGoal').at(-1), ['c']);
  assert.deepEqual(called('toast').at(-1), ['No goal set']);

  // edit
  await goal('edit ship it');
  assert.deepEqual(called('toast').at(-1), ['No goal set']);
  fx.sessions.c = { goal: { status: 'active' } };
  result = { goal: { objective: 'ship it' } };
  fx.store.withLease = async (...a: any[]) => (log.push(a), result);
  await goal('edit ship it');
  assert.deepEqual(log.at(-1), ['c', 'thread/goal/set', { threadId: 'c', objective: 'ship it' }]);
  assert.deepEqual(called('setGoalState').at(-1), ['c', { objective: 'ship it' }]);
  result = {};
  const before = called('setGoalState').length;
  await goal('edit again');
  assert.equal(called('setGoalState').length, before);
  fx.store.withLease = async () => {
    throw new Error('bad');
  };
  await goal('edit x');
  assert.deepEqual(called('toast').at(-1), ["Couldn't edit goal: bad", 'error']);

  // clear
  await goal('clear');
  assert.deepEqual(called('toast').at(-1), ["Couldn't clear goal: bad", 'error']);
  fx.store.withLease = async () => ({});
  await goal('clear');
  assert.deepEqual(called('setGoalState').at(-1), ['c', null]);
  const n = called('setGoalState').length;
  fx.store.withLease = async () => null;
  await goal('clear');
  assert.equal(called('setGoalState').length, n);
  fx.sessions.c = { goal: null };
  await goal('clear');
  assert.deepEqual(called('toast').at(-1), ['No goal set']);
  // pause through the handler
  await goal('pause');
});

test('Codex handlers leave compaction to the shared queue and run rename, shell, rewind and fork', async () => {
  const h = (s: string) => handlerFor('codex', s as any) as Promise<any>;
  fx.native.codex = {
    api: rec('api', async () => 'renamed'),
    fork: rec('fork', async (p: any) => ({ thread: { id: `f-${p.lastTurnId ?? 'all'}` } })),
  };
  fx.store.withLease = (...a: any[]) => a;
  fx.store.revertThread = (...a: any[]) => a;
  assert.equal(await call(await h('rename'), 'c', 'Name'), 'renamed');
  assert.equal(await h('compact'), null);
  assert.deepEqual(await call(await h('shell'), 'c', 'ls'), ['c', 'thread/shellCommand', { command: 'ls' }]);
  assert.deepEqual(await call(await h('rewind'), 'c', 't1'), ['c', 't1']);
  assert.equal(await call(await h('fork'), 'c', 't9'), 'f-t9');
  assert.equal(await call(await h('fork'), 'c', ''), 'f-all');
  assert.equal(await call(await h('fork'), 'c', 'pending-1'), 'f-all');
  fx.state.segments.c = [
    { harness: 'codex', nativeId: 'c' },
    { harness: 'codex', nativeId: 'n2' },
  ];
  assert.equal(await call(await h('fork'), 'c', 't9'), 'f-all', "an earlier segment's turn forks the whole thread");
  assert.deepEqual(log.at(-1), ['fork', { threadId: 'n2', excludeTurns: true, deferGoalContinuation: true }]);
  assert.deepEqual(called('copyChatConfig').at(-1), ['c', 'f-all']);
  assert.deepEqual(called('upsertThread').at(-1), [{ id: 'f-all' }, true]);
  assert.deepEqual(called('toast').at(-1), ['Forked into a new chat']);
  // the fork stays on the account the user put the chat on (R-3), before it opens
  assert.deepEqual(called('inheritCodexPin').at(-1), ['c', 'f-all']);
  fx.store.inheritCodexPin = async () => Promise.reject(new Error('relay down'));
  assert.equal(await call(await h('fork'), 'c', ''), 'f-all', 'a pin that could not be kept never stops the fork');
  assert.ok(
    called('toast').some((t) => t[0] === "The fork couldn't keep this chat's account (relay down); it uses the pool's" && t[1] === 'error'),
  );
});

test('MCP rows come from the harness the chat is on', async () => {
  fx.native.codex = { api: async () => ({ data: [{ name: 'gh', tools: { a: 1, b: 2 } }] }) };
  assert.deepEqual(await loadMcpRows('codex', null), [{ name: 'gh', desc: '2 tools' }]);
  fx.native.codex = { api: async () => ({}) };
  assert.deepEqual(await loadMcpRows('codex', null), []);
  // a read that failed rejects, so the / menu says so rather than "No MCP servers"
  fx.native.codex = {
    api: async () => {
      throw new Error('down');
    },
  };
  await assert.rejects(loadMcpRows('codex', null), /down/);
  assert.deepEqual(await loadMcpRows('claude', null), []);
  fx.native.claude = {
    control: async (id: string, what: string) => (log.push([id, what]), [{ name: 'fs', status: 'connected', tools: [1] }]),
  };
  fx.state.segments['claude:c'] = [{ harness: 'claude', nativeId: 'claude:n' }];
  assert.deepEqual(await loadMcpRows('claude', 'claude:c'), [{ name: 'fs', desc: '1 tools' }]);
  assert.deepEqual(log, [['claude:n', 'mcpStatus']]);
  fx.native.claude = { control: async () => null };
  assert.deepEqual(await loadMcpRows('claude', 'claude:c'), []);
  fx.native.claude = {
    control: async () => {
      throw new Error('x');
    },
  };
  await assert.rejects(loadMcpRows('claude', 'claude:c'), /x/);
  await tick();
});

test('built-in semantic lookup never returns inherited Object.prototype methods', async () => {
  for (const harness of ['codex', 'claude'] as const)
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
      assert.equal(await handlerFor(harness, name as any), null, `${harness}/${name}`);
});
