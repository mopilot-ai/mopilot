// Mid-chat harness switching, window side (src/session/harness/switch.ts): the handoff estimate, a new chat on a
// basic harness carrying a summary, and a switched chat's history stitched from its segments.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';

const claudeHistory = new Map<string, any[]>();
mock.module(new URL('../src/session/harness/claude.ts', import.meta.url).href, {
  namedExports: {
    loadClaudeTurns: async (nid: string, chatId: string, cwd: string, open?: boolean) => (
      fx.calls.push(['loadClaudeTurns', open === undefined ? [nid, chatId, cwd] : [nid, chatId, cwd, open]]),
      (claudeHistory.get(nid) ?? []).map((t: any) => (open ? { ...t, status: 'inProgress' } : t))
    ),
    // what src/session/harness/select.ts (the divider's model names) and its imports take from it
    ...Object.fromEntries(
      ['addClaudeAccount', 'pinClaudeChat', 'reloginClaudeAccount', 'removeClaudeAccount', 'switchClaudeAccount', 'recheckClaude'].map(
        (n) => [n, () => {}],
      ),
    ),
  },
});
// a Codex part's turns on disk, by thread (null: Codex is up, or the thread has no rollout file)
const onDisk = new Map<string, any[]>();
mock.module(new URL('../src/store/codexDisk.ts', import.meta.url).href, {
  namedExports: { allFromDisk: async (id: string) => (fx.calls.push(['allFromDisk', [id]]), onDisk.get(id) ?? null) },
});
const sw = await import('../src/session/harness/switch.ts');
const acp = await import('../src/session/harness/acp.ts');

const events: string[] = [];
(globalThis as any).window ??= new EventTarget();
window.addEventListener('focus-composer', () => events.push('focus'));

const turn = (id: string, status = 'completed') => ({
  id,
  status,
  items: [{ type: 'userMessage', id: `u-${id}`, content: [{ type: 'text', text: id }] }],
});

beforeEach(() => {
  reset();
  // main runs no turn on the chat unless a test says so
  fx.native.session = { snapshot: async () => null };
  claudeHistory.clear();
  onDisk.clear();
  events.length = 0;
});

/** What main answers acp:turns with: a page of JSON for the window to parse. */
const acpPage = (turns: unknown[], activeTurnId: string | null) => ({
  page: new TextEncoder().encode(JSON.stringify({ turns, olderCursor: null })),
  activeTurnId,
  diffs: {},
});

test('a composite chat reopened during an ACP turn continues streaming under its stable chat id', async () => {
  const key = 'acp:opencode:streaming-after-reload';
  const asked: any[] = [];
  fx.state.threads.c = { cwd: '/proj' };
  fx.state.segments.c = [
    { harness: 'codex', nativeId: 'c', start: 0, count: 0, model: null, handoff: null },
    { harness: 'acp:opencode', nativeId: key, start: 0, count: null, model: null, handoff: { mode: 'auto', tokens: 1, text: 'record' } },
  ];
  fx.store.ensureResumed = async () => undefined;
  let event: (e: any) => void = () => {};
  let items: (e: any) => void = () => {};
  fx.native.acp = {
    onEvent: (f: any) => (event = f),
    onItems: (f: any) => (items = f),
    onHarnesses() {},
    onSignIns() {},
    signIns: async () => ({}),
    harnesses: async () => [],
    list: async () => [],
    turns: async (id: string, chatId: string) => (
      asked.push([id, chatId]),
      acpPage(
        [{ id: 'live-acp', status: 'inProgress', items: [{ type: 'agentMessage', id: 'live-acp:m0', text: 'before reload' }] }],
        'live-acp',
      )
    ),
  };
  fx.native.codex = { api: async () => ({ data: [], nextCursor: null }) };
  acp.startAcp();
  await sw.openCompositeThread('c');
  assert.equal(fx.state.runtime.c.error, null);
  assert.equal(fx.state.runtime.c.activeTurnId, 'live-acp');
  assert.match(fx.state.runtime.c.turns[0].items[0].text, /Codex → opencode/);
  assert.deepEqual(asked, [[key, 'c']], 'main reads the session under the chat that owns it');
  fx.calls.length = 0;
  items({
    chatId: 'c',
    key,
    method: 'item/agentMessage/delta',
    params: { threadId: 'c', turnId: 'live-acp', itemId: 'live-acp:m0', delta: ' after reload' },
  });
  items({ chatId: 'c', key, method: 'turn/completed', params: { threadId: 'c', turn: { id: 'live-acp', status: 'completed' } } });
  event({ key, kind: 'turnEnd', turnId: 'live-acp', stopReason: 'end_turn' });
  const notifications = called('applyNotification');
  assert.ok(notifications.length > 0);
  assert.ok(notifications.every(([, p]) => p.threadId === 'c'));
  assert.equal(notifications.at(-1)![0], 'turn/completed');
  assert.equal(fx.state.runtime[key], undefined);
  // A later native update after switching away must not reopen the retired source in the same chat.
  fx.state.segments.c.push({ harness: 'claude', nativeId: 'claude:replacement', start: 1, count: null });
  fx.calls.length = 0;
  event({ key, kind: 'update', turnId: 'late', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } });
  assert.deepEqual(called('applyNotification'), []);
});

test('custom ACP segments retain model labels and return dividers without requiring a registry entry', async () => {
  const key = 'acp:custom:history';
  fx.state.segments.c = [
    { harness: 'acp:other', nativeId: 'acp:other:history', start: 0, count: 0, model: null, handoff: null },
    { harness: 'acp:custom', nativeId: key, start: 0, count: null, model: 'native-model', handoff: { mode: 'auto', tokens: 1, text: 'h' } },
  ];
  fx.native.acp = {
    turns: async (id: string) => acpPage(id === key ? [{ id: 'custom-turn', status: 'completed', items: [] }] : [], null),
  };
  await sw.openCompositeThread('c');
  assert.match(fx.state.runtime.c.turns[0].items[0].text, /acp:other → acp:custom · native-model/);
  fx.state.segments.c[1].handoff.mode = 'delta';
  await sw.openCompositeThread('c');
  assert.match(fx.state.runtime.c.turns[0].items[0].text, /Back on acp:custom/);
});

test("a basic harness's chat writes its handoff note under its own name, not Codex's", async () => {
  fx.state.threads['acp:kimi:9'] = { id: 'acp:kimi:9', cwd: '/proj' };
  fx.native.session = { handoffNote: async () => ({ text: 'note' }) };
  await sw.newChatWithSummary('acp:kimi:9', { family: 'acp', basic: 'qwen' });
  assert.deepEqual(called('toast')[0], ['Preparing a summary of this chat from Kimi Code…']);
});

test('a summary carried into a new chat on any harness; a failed note leaves the chat where it is', async () => {
  fx.state.home = '/home/me';
  fx.state.savedProjects = [{ id: 'p1', name: 'P', roots: [{ path: '/proj' }], source: 'sage', codexId: 'cx1' }];
  fx.state.threads.c = { id: 'c', cwd: '/proj', projectId: 'p1', name: 'Fix the build', preview: 'x' };
  fx.native.session = { handoffNote: async (chat: string, label: string) => ({ text: `note for ${label} from ${chat}` }) };
  const id = await sw.newChatWithSummary('c', { family: 'acp', basic: 'kimi' });
  assert.match(id!, /^acp:kimi:/);
  assert.deepEqual(called('toast')[0], ['Preparing a summary of this chat from Codex…']);
  assert.deepEqual(fx.state.handoffCarry[id!], { text: 'note for Kimi Code from c', fromTitle: 'Fix the build' });
  const proj = fx.state.savedProjects[0];
  assert.deepEqual(called('startNewChat')[0], ['acp', { cwd: '/proj', proj, ephemeral: undefined, basic: 'kimi' }]);
  // the new chat takes the old one's pane
  assert.deepEqual(called('replaceChatInView'), [['c', id]]);
  assert.deepEqual(events, ['focus']);
  // a first-tier target: the chat starts on it, in the project as Codex files it (its Codex id names the same project)
  fx.state.threads.b = { id: 'b', cwd: '/proj', projectId: 'cx1', name: 'B' };
  fx.state.segments.b = [{ harness: 'claude', nativeId: 'claude:s', start: 0, count: null }];
  for (const family of ['codex', 'claude'] as const) {
    const to = await sw.newChatWithSummary('b', { family });
    assert.ok(to!.startsWith(`${family}:`));
    assert.deepEqual(called('startNewChat').at(-1), [family, { cwd: '/proj', proj, ephemeral: undefined, basic: null }]);
    assert.equal(fx.state.handoffCarry[to!].text, `note for ${family === 'codex' ? 'Codex' : 'Claude Code'} from b`);
  }
  assert.deepEqual(called('toast').at(-1), ['Preparing a summary of this chat from Claude Code…']);
  // an unknown chat starts in the home folder, titled after the preview or a fallback; a project no longer saved is none
  fx.state.threads.d = { id: 'd', preview: 'hello', projectId: 'gone' };
  const d = await sw.newChatWithSummary('d', { family: 'acp', basic: 'kimi' });
  assert.deepEqual(called('startNewChat').at(-1), ['acp', { cwd: '/home/me', proj: null, ephemeral: undefined, basic: 'kimi' }]);
  assert.equal(fx.state.handoffCarry[d!].fromTitle, 'hello');
  const e = await sw.newChatWithSummary('e', { family: 'codex' });
  assert.equal(fx.state.handoffCarry[e!].fromTitle, 'the earlier chat');
  assert.deepEqual(called('startNewChat').at(-1)![1].proj, null);
  // no note: no chat is started, and the user is told why
  const started = called('startNewChat').length;
  fx.native.session = { handoffNote: async () => ({ error: 'too long' }) };
  assert.equal(await sw.newChatWithSummary('c', { family: 'claude' }), null);
  assert.deepEqual(called('toast').at(-1), ["Couldn't write the handoff note: too long", 'error']);
  assert.equal(called('startNewChat').length, started);
  // a chat that fails to start rejects (the picker tells the user), and carries nothing
  fx.native.session = { handoffNote: async () => ({ text: 'n' }) };
  fx.store.startNewChat = async () => {
    throw new Error('app-server is down');
  };
  const before = Object.keys(fx.state.handoffCarry).length;
  await assert.rejects(sw.newChatWithSummary('c', { family: 'codex' }), /app-server is down/);
  assert.equal(Object.keys(fx.state.handoffCarry).length, before);
});

test('a new chat with a summary is named by its harness', () => {
  assert.equal(sw.targetLabel({ family: 'codex' }), 'Codex');
  assert.equal(sw.targetLabel({ family: 'claude' }), 'Claude Code');
  assert.equal(sw.targetLabel({ family: 'acp', basic: 'kimi' }), 'Kimi Code');
});

test("a switched chat shows each segment's slice with a divider where the harness changed", async () => {
  fx.state.threads.c = { cwd: '/proj' };
  fx.state.segments.c = [
    { harness: 'codex', nativeId: 'c', start: 0, count: 2, model: 'gpt-5', handoff: null },
    { harness: 'claude', nativeId: 'claude:s', start: 2, count: 1, model: 'opus', handoff: { mode: 'summary', tokens: 1200, text: 'H1' } },
    { harness: 'codex', nativeId: 'c', start: 3, count: null, model: null, handoff: { mode: 'delta', tokens: 10, text: 'H2', caught: 1 } },
  ];
  claudeHistory.set('claude:s', [turn('k1')]);
  const pages: any[] = [];
  fx.store.ensureResumed = async () => {
    throw new Error('not running');
  };
  fx.store.turnFromServer = (t: any) => t;
  fx.native.codex = {
    api: async (_name: string, [id, p]: any[]) => {
      pages.push([id, p.cursor]);
      // newest first, as the app-server pages them
      return p.cursor
        ? // an older turn read back unfinished is not the running one: the latest is (#2332)
          { data: [turn('x2', 'inProgress'), turn('x1')], nextCursor: null }
        : { data: [turn('x4', 'inProgress'), turn('x3')], nextCursor: 'p2' };
    },
  };
  await sw.openCompositeThread('c');
  const rt = fx.state.runtime.c;
  assert.deepEqual(pages, [
    ['c', null],
    ['c', 'p2'],
  ]);
  assert.deepEqual(
    rt.turns.map((t: any) => t.id),
    ['x1', 'x2', 'k1', 'x3', 'x4'],
  );
  assert.deepEqual(called('loadClaudeTurns'), [['claude:s', 'c', '/proj']]);
  const divider = (i: number) => rt.turns[i].items[0];
  assert.equal(divider(2).kind, 'switch');
  assert.equal(divider(2).handoff, 'H1');
  assert.match(divider(2).text, /^Codex → Claude Code · opus/);
  assert.equal(divider(3).handoff, 'H2');
  assert.match(divider(3).text, /Codex/);
  assert.equal(rt.turns[0].items[0].type, 'userMessage');
  assert.equal(rt.activeTurnId, 'x4');
  assert.deepEqual([rt.loaded, rt.loading, rt.olderCursor], [true, false, null]);
});

test('the switch divider names the model as the picker does, not by its id', async () => {
  fx.state.models = [{ model: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol', supportedReasoningEfforts: [] }];
  fx.state.claude = { ...fx.state.claude, models: [{ id: 'sonnet', label: 'Sonnet 5.5' }] };
  fx.state.segments.c = [
    { harness: 'claude', nativeId: 'claude:a', start: 0, count: 1, model: 'sonnet', handoff: null },
    { harness: 'codex', nativeId: 'cx', start: 1, count: 1, model: 'gpt-6.1-sol', handoff: { mode: 'auto', tokens: 1, text: 'x' } },
    { harness: 'claude', nativeId: 'claude:b', start: 2, count: null, model: 'sonnet', handoff: { mode: 'auto', tokens: 1, text: 'y' } },
  ];
  claudeHistory.set('claude:a', [turn('a')]);
  claudeHistory.set('claude:b', [turn('b')]);
  fx.store.ensureResumed = async () => {};
  fx.store.turnFromServer = (t: any) => t;
  fx.native.codex = { api: async () => ({ data: [turn('z')], nextCursor: null }) };
  await sw.openCompositeThread('c');
  const rt = fx.state.runtime.c;
  assert.equal(rt.turns[1].items[0].text, 'Claude Code → Codex · GPT-6.1 Sol');
  assert.equal(rt.turns[2].items[0].text, 'Codex → Claude Code · Sonnet 5.5');
});

test('segments without a handoff get no divider; one without a model leaves it out; nothing running is no active turn', async () => {
  fx.state.segments.c = [
    { harness: 'claude', nativeId: 'claude:a', start: 0, count: 1, model: null, handoff: null },
    { harness: 'claude', nativeId: 'claude:b', start: 1, count: 1, model: null, handoff: null },
    { harness: 'claude', nativeId: 'claude:c', start: 2, count: 1, model: null, handoff: { mode: 'auto', tokens: 1, text: 'x' } },
    { harness: 'codex', nativeId: 'cx', start: 2, count: null, model: null, handoff: { mode: 'delta', tokens: 1, text: 'y' } },
  ];
  claudeHistory.set('claude:a', [turn('a')]);
  claudeHistory.set('claude:b', [turn('b')]);
  claudeHistory.set('claude:c', [turn('c')]);
  fx.store.ensureResumed = async () => {};
  fx.store.turnFromServer = (t: any) => t;
  fx.native.codex = { api: async () => ({ data: [turn('z')], nextCursor: null }) };
  await sw.openCompositeThread('c');
  const rt = fx.state.runtime.c;
  assert.deepEqual(
    rt.turns.map((t: any) => t.items.length),
    [1, 1, 2, 2],
  );
  assert.match(rt.turns[2].items[0].text, /^Claude Code → Claude Code$/);
  assert.match(rt.turns[3].items[0].text, /Codex/);
  assert.equal(rt.turns[3].items[0].text, 'Back on Codex');
  assert.equal(rt.activeTurnId, null);
});

test("a history that can't be read shows the error", async () => {
  fx.state.segments.c = [{ harness: 'codex', nativeId: 'c', start: 0, count: null, model: null, handoff: null }];
  fx.store.ensureResumed = async () => {};
  fx.native.codex = {
    api: async () => {
      throw new Error('gone');
    },
  };
  await sw.openCompositeThread('c');
  assert.equal(fx.state.runtime.c.error, 'gone');
  fx.native.codex = {
    api: async () => {
      throw 'raw';
    },
  };
  await sw.openCompositeThread('c');
  assert.equal(fx.state.runtime.c.error, 'raw');
  // a read that succeeds later (Codex came back, or Retry) takes the failed read's error away
  fx.store.turnFromServer = (t: any) => t;
  fx.native.codex = { api: async () => ({ data: [turn('z')], nextCursor: null }) };
  await sw.openCompositeThread('c');
  assert.equal(fx.state.runtime.c.error, null);
  // and leaves an error that isn't a read's (why a turn was refused)
  fx.state.runtime.c = { ...fx.state.runtime.c, error: 'refused', errorFromRead: false };
  await sw.openCompositeThread('c');
  assert.equal(fx.state.runtime.c.error, 'refused');
});

test("Codex down: a switched chat's Codex part is read from its rollout file, until a read from Codex replaces it", async () => {
  fx.state.threads.c = { cwd: '/proj' };
  fx.state.segments.c = [
    { harness: 'codex', nativeId: 'c', start: 0, count: 1, model: null, handoff: null },
    { harness: 'claude', nativeId: 'claude:s', start: 1, count: null, model: 'opus', handoff: { mode: 'auto', tokens: 10, text: 'H' } },
  ];
  claudeHistory.set('claude:s', [turn('k1')]);
  fx.store.ensureResumed = async () => {
    throw new Error("Codex isn't connected");
  };
  fx.store.turnFromServer = (t: any) => t;
  // the first page read, then the app-server goes: the whole file stands in for it
  let pages = 0;
  fx.native.codex = {
    api: async () => {
      if (pages++ === 0) return { data: [turn('partial')], nextCursor: 'p2' };
      throw new Error("Codex isn't connected");
    },
  };
  onDisk.set('c', [turn('d1')]);
  await sw.openCompositeThread('c');
  let rt = fx.state.runtime.c;
  assert.deepEqual(
    rt.turns.map((t: any) => t.id),
    ['d1', 'k1'],
  );
  assert.equal(rt.fromDisk, true);
  assert.equal(rt.error, null);
  // Codex back: its read replaces what disk showed
  fx.native.codex = { api: async () => ({ data: [turn('x1')], nextCursor: null }) };
  await sw.openCompositeThread('c');
  rt = fx.state.runtime.c;
  assert.deepEqual(
    rt.turns.map((t: any) => t.id),
    ['x1', 'k1'],
  );
  assert.equal(rt.fromDisk, false);
});

test('codex history stops after forty pages', async () => {
  fx.state.segments.c = [{ harness: 'codex', nativeId: 'c', start: 0, count: null, model: null, handoff: null }];
  fx.store.ensureResumed = async () => {};
  fx.store.turnFromServer = (t: any) => t;
  let n = 0;
  fx.native.codex = { api: async () => ({ data: [turn(`t${n++}`)], nextCursor: 'more' }) };
  await sw.openCompositeThread('c');
  assert.equal(n, 40);
});

test('the new chat goes where the earlier chat is once the note is written, not where it was when asked', async () => {
  fx.state.home = '/home/me';
  fx.state.threads.c = { id: 'c', cwd: '/old', name: 'c' };
  fx.native.session = {
    handoffNote: async () => {
      fx.state = { ...fx.state, threads: { ...fx.state.threads, c: { id: 'c', cwd: '/moved', name: 'c' } } };
      return { text: 'note' };
    },
  };
  await sw.newChatWithSummary('c', { family: 'claude' });
  assert.equal(called('startNewChat').at(-1)![1].cwd, '/moved');
});

test('a project kept only in the chat meta follows the chat into a new chat with a summary', async () => {
  fx.state.home = '/home/me';
  fx.state.savedProjects = [{ id: 'p2', name: 'P2', roots: [{ path: '/proj' }], source: 'sage' }];
  fx.state.threads.m = { id: 'm', cwd: '/proj', name: 'm', preview: 'x' };
  fx.state.chatProject.m = 'p2';
  fx.native.session = { handoffNote: async () => ({ text: 'note' }) };
  await sw.newChatWithSummary('m', { family: 'acp', basic: 'kimi' });
  assert.equal(called('startNewChat').at(-1)![1].proj.id, 'p2');
});

test("a switched chat opened while main runs its Claude segment's turn reads that turn open (#1838)", async () => {
  for (const [answers, harness, kRows, live, why] of [
    [['running'], 'claude', 1, true, 'running'],
    [['awaitingUser'], 'claude', 1, true, 'awaiting the user'],
    [['idle'], 'claude', 1, false, 'idle'],
    [['running', 'idle'], 'claude', 1, false, 'ended while it was read'],
    [['running'], 'codex', 1, false, 'a Codex segment'],
    [['running'], 'claude', 0, false, 'the Claude segment has no turn yet'],
  ] as const) {
    reset();
    claudeHistory.clear();
    fx.state.segments.c = [
      { harness: 'codex', nativeId: 'cx', start: 0, count: 1, model: null, handoff: null },
      { harness, nativeId: harness === 'claude' ? 'claude:s' : 'cy', start: 1, count: null, model: null, handoff: null },
    ];
    claudeHistory.set('claude:s', kRows ? [turn('k1')] : []);
    fx.store.ensureResumed = async () => {};
    fx.store.turnFromServer = (t: any) => t;
    fx.native.codex = { api: async (_m: string, p: any) => ({ data: [turn(p.threadId === 'cx' ? 'x1' : 'y1')], nextCursor: null }) };
    let n = 0;
    fx.native.session = { snapshot: async () => ({ turn: answers[Math.min(n++, answers.length - 1)], runningElsewhere: false }) };
    await sw.openCompositeThread('c');
    const rt = fx.state.runtime.c;
    const last = rt.turns.at(-1);
    assert.equal(last.status, live ? 'inProgress' : 'completed', why);
    assert.equal(rt.activeTurnId, live ? 'k1' : null, why);
    if (live) assert.equal(last.completedAt, null);
    if (why === 'ended while it was read')
      assert.deepEqual(called('loadClaudeTurns'), [
        ['claude:s', 'c', '', true],
        ['claude:s', 'c', '', false],
      ]);
  }
});
