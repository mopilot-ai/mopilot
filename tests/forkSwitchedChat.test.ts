// Forking a chat that switched harness (src/session/harness/forkSwitched.ts, #1941): every segment's native session is forked,
// so the fork shows the whole conversation with its hand-offs, and runs on where the fork point was.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';

const { forkSwitchedChat, forkedSegments } = await import('../src/session/harness/forkSwitched.ts');

const H1 = { mode: 'auto', tokens: 10, text: 'summary of the Codex part' };
const H2 = { mode: 'delta', tokens: 5, text: 'what Claude Code did', caught: 2 };
const seg = (harness: string, nativeId: string, start: number, count: number | null, handoff: any = null) => ({
  harness,
  nativeId,
  start,
  count,
  model: null,
  handoff,
});
const renamed: [string, string][] = [];
const rename = async (id: string, name: string) => {
  renamed.push([id, name]);
};
const forkCalls = () => ({ codex: called('codex.fork'), claude: called('claude.fork') });

beforeEach(() => {
  reset();
  renamed.length = 0;
  fx.state.threads.cx = { id: 'cx', cwd: '/proj', name: 'renamed chat', projectId: 'p1' };
  fx.native.codex = {
    fork: async (params: any) => (fx.calls.push(['codex.fork', [params]]), { thread: { id: `${params.threadId}-fork`, cwd: '/proj' } }),
  };
  fx.native.claude = {
    fork: async (sid: string, uuid: string | null, discardable?: boolean) => (
      fx.calls.push(['claude.fork', [sid, uuid, discardable]]), { sessionId: `${sid}-fork` }
    ),
  };
});

test('a fork after one switch (Codex → Claude Code) carries both parts, named after the chat', async () => {
  fx.state.segments.cx = [seg('codex', 'cx', 0, 4), seg('claude', 'claude:a', 4, null, H1)];
  const id = await forkSwitchedChat('cx', undefined, rename);
  assert.equal(id, 'cx-fork');
  assert.deepEqual(forkCalls(), {
    codex: [[{ threadId: 'cx', excludeTurns: true, deferGoalContinuation: true }]],
    claude: [['a', null, true]],
  });
  assert.deepEqual(fx.state.segments['cx-fork'], [seg('codex', 'cx-fork', 0, 4), seg('claude', 'claude:a-fork', 4, null, H1)]);
  // marked as a fork, so the window keeps reading it while Codex does not list it
  assert.equal(fx.state.chatForkOf['cx-fork'], 'cx');
  const [[t, bump]] = called('upsertThread');
  assert.deepEqual([t.id, t.name, t.projectId, bump], ['cx-fork', 'renamed chat (fork)', 'p1', true]);
  assert.deepEqual(called('navigate'), [[{ name: 'thread', id: 'cx-fork' }]]);
  assert.deepEqual(called('inheritCodexPin'), [['cx', 'cx-fork']]);
  assert.deepEqual(called('copyChatConfig'), [['cx', 'cx-fork']]);
  // named where its harness lists it, so the name outlives a restart; a rename that fails leaves the fork as made
  assert.deepEqual(renamed, [['cx-fork', 'renamed chat (fork)']]);
  fx.state.segments.cx2 = fx.state.segments.cx;
  const failing = async () => {
    throw new Error('rename refused');
  };
  assert.equal(await forkSwitchedChat('cx2', undefined, failing), 'cx-fork');
});

test('a fork after two switches forks a session a switch back reused once, and keeps every hand-off', async () => {
  fx.state.segments.cx = [seg('codex', 'cx', 0, 2), seg('claude', 'claude:a', 2, 3, H1), seg('codex', 'cx', 5, null, H2)];
  fx.state.claudeChats = { cx: { id: 'acct-2', pinned: true } };
  const id = await forkSwitchedChat('cx', undefined, rename);
  assert.deepEqual(forkCalls(), {
    codex: [[{ threadId: 'cx', excludeTurns: true, deferGoalContinuation: true }]],
    claude: [['a', null, true]],
  });
  assert.deepEqual(fx.state.segments[id!], [
    seg('codex', 'cx-fork', 0, 2),
    seg('claude', 'claude:a-fork', 2, 3, H1),
    seg('codex', 'cx-fork', 5, null, H2),
  ]);
  // the Claude login the chat was pinned to comes along
  assert.deepEqual(fx.state.claudeChats[id!], { id: 'acct-2', pinned: true });
});

test('a fork from a turn takes the parts through it, cuts every session at its last kept turn, and runs on that harness', async () => {
  // Codex, Claude Code, then back on the same Codex thread: a turn of the Codex thread after the fork point (x3) must not
  // come along in the fork's copy of it (#1941 review)
  fx.state.segments.cx = [seg('codex', 'cx', 0, 2), seg('claude', 'claude:a', 2, 2, H1), seg('codex', 'cx', 4, null, H2)];
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  fx.state.runtime.cx = { turns: ['x1', 'x2', `h-${uuid}`, 'h-k2', 'x3'].map((id) => ({ id, items: [] })) };
  const id = await forkSwitchedChat('cx', `h-${uuid}`, rename);
  assert.deepEqual(forkCalls(), {
    codex: [[{ threadId: 'cx', excludeTurns: true, deferGoalContinuation: true, lastTurnId: 'x2' }]],
    claude: [['a', uuid, true]],
  });
  assert.deepEqual(fx.state.segments[id!], [seg('codex', 'cx-fork', 0, 2), seg('claude', 'claude:a-fork', 2, null, H1)]);
  // a fork point in the first part is a plain fork of that session: no segments to keep
  reset();
  fx.state.threads.cx = { id: 'cx', cwd: '/proj', name: 'c' };
  fx.native.codex = { fork: async (p: any) => (fx.calls.push(['codex.fork', [p]]), { thread: { id: 'cx-fork', cwd: '/proj' } }) };
  fx.state.segments.cx = [seg('codex', 'cx', 0, 2), seg('claude', 'claude:a', 2, null, H1)];
  fx.state.runtime.cx = { turns: [{ id: 'x1' }, { id: 'x2' }, { id: 'k1' }] };
  assert.equal(await forkSwitchedChat('cx', 'x1', rename), 'cx-fork');
  assert.deepEqual(called('codex.fork'), [[{ threadId: 'cx', excludeTurns: true, deferGoalContinuation: true, lastTurnId: 'x1' }]]);
  assert.equal(fx.state.segments['cx-fork'], undefined);
});

test('a chat whose first part is Claude Code forks to a Claude chat; a pending turn id is not a fork point', async () => {
  fx.state.threads['claude:a'] = { id: 'claude:a', cwd: '/proj', name: 'k' };
  fx.state.segments['claude:a'] = [seg('claude', 'claude:a', 0, 1), seg('codex', 'cx', 1, null, H1)];
  fx.state.runtime['claude:a'] = { turns: [{ id: 'h-x' }, { id: 'pending-1' }] };
  const id = await forkSwitchedChat('claude:a', 'pending-1', rename);
  assert.equal(id, 'claude:a-fork');
  assert.deepEqual(called('codex.fork'), [[{ threadId: 'cx', excludeTurns: true, deferGoalContinuation: true }]]);
  const [[t]] = called('upsertThread');
  assert.deepEqual([t.id, t.name], ['claude:a-fork', 'k (fork)']);
  assert.deepEqual(
    fx.state.segments['claude:a-fork'].map((g: any) => g.nativeId),
    ['claude:a-fork', 'cx-fork'],
  );
  // no Codex part: no Codex pin to carry
  reset();
  fx.native.claude = { fork: async (sid: string) => ({ sessionId: `${sid}-f` }) };
  fx.state.segments['claude:a'] = [seg('claude', 'claude:a', 0, 1), seg('claude', 'claude:b', 1, null, H1)];
  assert.equal(await forkSwitchedChat('claude:a', undefined, rename), 'claude:a-f');
  assert.deepEqual(called('inheritCodexPin'), []);
});

test('a part on a harness that cannot fork, or a fork that fails, says so and makes nothing', async () => {
  fx.state.segments.cx = [seg('codex', 'cx', 0, 1), seg('acp:kimi', 'acp:kimi:s', 1, null, H1)];
  assert.equal(await forkSwitchedChat('cx', undefined, rename), undefined);
  assert.match(called('toast')[0][0], /can't be forked: its .* part has no fork/);
  assert.deepEqual(forkCalls(), { codex: [], claude: [] });
  reset();
  fx.native.codex = { fork: async () => ({ thread: { id: 'cx-fork' } }) };
  fx.native.claude = {
    fork: async () => {
      throw new Error('session busy');
    },
  };
  fx.state.segments.cx = [seg('codex', 'cx', 0, 1), seg('claude', 'claude:a', 1, null, H1)];
  assert.equal(await forkSwitchedChat('cx', undefined, rename), undefined);
  assert.deepEqual(called('toast'), [["Couldn't fork the chat: session busy", 'error']]);
  assert.deepEqual(called('navigate'), []);
});

test('a fork that fails part way removes the Claude sessions it already made', async () => {
  fx.state.segments['claude:a'] = [seg('claude', 'claude:a', 0, 1), seg('codex', 'cx', 1, null, H1)];
  const removed: string[] = [];
  fx.native.claude.discardFork = async (sid: string) => {
    removed.push(sid);
    if (sid === 'a-fork') throw new Error('locked');
  };
  fx.native.codex = {
    fork: async () => {
      throw new Error('codex down');
    },
  };
  assert.equal(await forkSwitchedChat('claude:a', undefined, rename), undefined);
  assert.deepEqual(removed, ['a-fork']);
  assert.deepEqual(called('toast'), [["Couldn't fork the chat: codex down", 'error']]);
});

test("the account pin that can't be kept is said, and the fork still opens", async () => {
  fx.state.segments.cx = [seg('codex', 'cx', 0, 1), seg('claude', 'claude:a', 1, null, H1)];
  fx.store.inheritCodexPin = async () => {
    throw new Error('pin refused');
  };
  assert.equal(await forkSwitchedChat('cx', undefined, rename), 'cx-fork');
  assert.match(called('toast')[0][0], /couldn't keep this chat's account \(pin refused\)/);
});

test('a fork point in a chat not loaded here forks the whole chat', async () => {
  fx.state.segments.cx = [seg('codex', 'cx', 0, 1), seg('claude', 'claude:a', 1, null, H1)];
  assert.equal(await forkSwitchedChat('cx', 'h-unknown', rename), 'cx-fork');
  assert.deepEqual(forkCalls().claude, [['a', null, true]]);
});

test('the segments a fork takes, and where each session is cut', () => {
  const segs = [seg('codex', 'cx', 0, 2), seg('claude', 'claude:a', 2, null, H1)] as any;
  assert.deepEqual(forkedSegments(segs, -1), { keep: segs, cuts: new Map() });
  assert.deepEqual(forkedSegments(segs, 1), { keep: [segs[0]], cuts: new Map([['cx', 1]]) });
  assert.deepEqual(forkedSegments(segs, 3), {
    keep: segs,
    cuts: new Map([
      ['cx', 1],
      ['claude:a', 3],
    ]),
  });
  // a part with no turns of its own (a switch nothing was sent on) cuts nothing
  const empty = [seg('codex', 'cx', 0, 0), seg('claude', 'claude:a', 0, null, H1)] as any;
  assert.deepEqual(forkedSegments(empty, 0).cuts, new Map([['claude:a', 0]]));
});

const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
const loadOlder = {
  set run(f: () => Promise<void>) {
    fx.store.loadOlderTurns = f;
  },
};

test('a fork from a message loads the turns above the window first, so its sessions are cut at the right turns', async () => {
  fx.state.segments.cx = [seg('codex', 'cx', 0, 3), seg('claude', `claude:${uuid}`, 3, null, H1)];
  fx.state.runtime.cx = { turns: [{ id: 'c' }, { id: `h-${uuid}` }], olderCursor: 'older', turnsAbove: 2 };
  loadOlder.run = async () => {
    fx.state.runtime.cx = { turns: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: `h-${uuid}` }], olderCursor: null, turnsAbove: 0 };
  };
  assert.equal(await forkSwitchedChat('cx', `h-${uuid}`, rename), 'cx-fork');
  // cut at c, the Codex part's last turn, and at the message in the Claude Code part
  assert.equal(forkCalls().codex[0][0].lastTurnId, 'c');
  assert.equal(forkCalls().claude[0][0], uuid);
});

test('a fork from a message that cannot load the turns above says so and forks nothing', async () => {
  fx.state.segments.cx = [seg('codex', 'cx', 0, 3), seg('claude', 'claude:a', 3, null, H1)];
  fx.state.runtime.cx = { turns: [{ id: 'c' }], olderCursor: 'older', turnsAbove: 2 };
  loadOlder.run = async () => {
    throw new Error('disk gone');
  };
  assert.equal(await forkSwitchedChat('cx', 'c', rename), undefined);
  assert.deepEqual(called('toast').at(-1), ["Couldn't fork the chat: disk gone", 'error']);
  assert.deepEqual(forkCalls(), { codex: [], claude: [] });

  // a read that comes back with nothing new can't go on either
  loadOlder.run = async () => {};
  assert.equal(await forkSwitchedChat('cx', 'c', rename), undefined);
  assert.deepEqual(called('toast').at(-1), ["Couldn't fork the chat: its earlier messages stopped loading", 'error']);
  assert.deepEqual(forkCalls(), { codex: [], claude: [] });
});
