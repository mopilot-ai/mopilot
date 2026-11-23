// When a running turn last made progress, as main sees it on every harness with no window open (#1534, #1511): the
// SessionState `progressAt` the quiet-turn notes measure from (electron/session/turnProgress.cjs, src/lib/turnStall.ts).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick, codex, selectSegment, SessionStore } from './support/controller/fixture';

const require = createRequire(import.meta.url);
const { noteTurnProgress, codexProgress, claudeProgress, PROGRESS_STEP_MS } = require('../electron/session/turnProgress.cjs');

const T0 = 1_700_000_000_000;
mock.timers.enable({ apis: ['Date'], now: T0 });
const at = (ms: number) => mock.timers.setTime(T0 + ms);

test('progressAt moves only for a running turn, at most every few seconds, and goes when the turn ends', () => {
  const published: any[] = [];
  const state = new SessionStore({ publish: (p: any) => published.push(p) });
  assert.equal(noteTurnProgress(state, 'c', T0), false);
  assert.equal(state.get('c').progressAt, null);
  state.patch('c', { turn: 'running', activeTurn: { id: 't', human: true } });
  assert.equal(noteTurnProgress(state, 'c', T0), true);
  assert.equal(noteTurnProgress(state, 'c', T0 + PROGRESS_STEP_MS - 1), false);
  assert.equal(state.get('c').progressAt, T0);
  assert.equal(noteTurnProgress(state, 'c', T0 + PROGRESS_STEP_MS), true);
  // a clock that went back is taken as it is
  assert.equal(noteTurnProgress(state, 'c', T0 - 1), true);
  assert.equal(state.get('c').progressAt, T0 - 1);
  // waiting on the user is still the turn's: progress counts
  state.patch('c', { turn: 'awaitingUser' });
  assert.equal(noteTurnProgress(state, 'c', T0 + 60_000), true);
  // every window hears of it (no window needed for main to hold it)
  assert.deepEqual(published.at(-1).patch, { progressAt: T0 + 60_000 });
  // answered after a long wait: the turn's quiet counts from the answer
  at(5 * 60_000);
  state.patch('c', { turn: 'running' });
  assert.equal(state.get('c').progressAt, T0 + 5 * 60_000);
  state.patch('c', { turn: 'awaitingUser' });
  state.patch('c', { turn: 'running', progressAt: 7 });
  assert.equal(state.get('c').progressAt, 7);
  state.patch('c', { turn: 'idle', activeTurn: null });
  assert.equal(state.get('c').progressAt, null);
  // a patch that names it keeps what it names
  state.patch('c', { turn: 'crashed', progressAt: 5 });
  assert.equal(state.get('c').progressAt, 5);
});

test('what counts as progress: a Codex item or turn moving, any Claude message but its retry note', () => {
  assert.equal(codexProgress('item/agentMessage/delta'), true);
  assert.equal(codexProgress('turn/started'), true);
  assert.equal(codexProgress('thread/tokenUsage/updated'), false);
  assert.equal(codexProgress('error'), false);
  assert.equal(codexProgress(undefined), false);
  assert.equal(claudeProgress({ type: 'stream_event' }), true);
  assert.equal(claudeProgress({ type: 'system', subtype: 'init' }), true);
  assert.equal(claudeProgress({ type: 'system', subtype: 'api_retry' }), false);
  assert.equal(claudeProgress(null), false);
});

/** Each harness family: how a turn starts, one event that is progress, one that isn't, and how it ends or is stopped. */
const FAMILIES: Record<
  string,
  { chat: string; start(f: any): Promise<void>; move(f: any): void; noise(f: any): void; end(f: any): void; stop(f: any): void }
> = {
  codex: {
    chat: 't1',
    async start(f) {
      f.c.send('t1', { text: 'hi', opts: { human: true } }, 1);
      f.execs[0].done({ started: true, turnId: 'turn-1' });
      await tick();
      f.c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
    },
    move: (f) => f.c.onCodexMessage(codex('item/agentMessage/delta', { threadId: 't1', turnId: 'turn-1', delta: 'x' })),
    noise: (f) => {
      f.c.onCodexMessage(codex('thread/tokenUsage/updated', { threadId: 't1' }));
      // no thread, or a thread no chat holds
      f.c.onCodexMessage(codex('item/started', {}));
      f.c.onCodexMessage(codex('item/started', { threadId: 'nobody' }));
    },
    end: (f) => f.c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } })),
    stop: (f) => f.c.codexStopped('t1', 'turn-1'),
  },
  claude: {
    chat: 'claude:s1',
    async start(f) {
      f.c.send('claude:s1', { text: 'hi', opts: { human: true } }, 1);
      await f.c.claudeSend('claude:s1', 'claude:s1', { sessionId: 's1' }, { role: 'user', content: 'hi' }, undefined, {
        human: true,
        uuid: 'u1',
      });
    },
    move: (f) =>
      f.c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'stream_event', event: { type: 'content_block_delta' } } }),
    noise: (f) =>
      f.c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10 } }),
    end: (f) => f.c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'result', subtype: 'success' } }),
    stop: (f) => {
      f.c.onClaudeControl('claude:s1', 'interrupt');
      f.c.onClaudeEvent({ key: 'claude:s1', kind: 'message', msg: { type: 'result', subtype: 'error_during_execution' } });
    },
  },
  acp: {
    chat: 'acp:opencode:o1',
    async start(f) {
      f.c.send('acp:opencode:o1', { text: 'hi', opts: { human: true } }, 1);
      await tick();
      f.c.onAcpEvent({ key: 'acp:opencode:o1', kind: 'turnStart', turnId: 'at-1', human: true });
    },
    move: (f) =>
      f.c.onAcpEvent({
        key: 'acp:opencode:o1',
        kind: 'update',
        turnId: 'at-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
      }),
    // the session's usage or catalog changing is not the turn moving
    noise: (f) =>
      f.c.onAcpEvent({
        key: 'acp:opencode:o1',
        kind: 'update',
        turnId: null,
        update: { sessionUpdate: 'usage_update', used: 5, size: 10 },
      }),
    end: (f) => f.c.onAcpEvent({ key: 'acp:opencode:o1', kind: 'turnEnd', turnId: 'at-1', stopReason: 'end_turn' }),
    stop: (f) => {
      f.c.acpCancel('acp:opencode:o1');
      f.c.onAcpEvent({ key: 'acp:opencode:o1', kind: 'turnEnd', turnId: 'at-1', stopReason: 'cancelled' });
    },
  },
};

for (const [family, h] of Object.entries(FAMILIES)) {
  test(`${family}: progress telemetry tracks actual activity without treating silence as failure`, async () => {
    at(0);
    const f = setup();
    await h.start(f);
    const s = () => f.s(h.chat);
    assert.equal(s().turn, 'running');
    at(10_000);
    h.move(f);
    assert.equal(s().progressAt, T0 + 10_000);
    // what isn't the turn moving leaves it
    at(30_000);
    h.noise(f);
    assert.equal(s().progressAt, T0 + 10_000);
    at(90_000);
    assert.equal(s().turn, 'running');
    assert.equal(s().progressAt, T0 + 10_000);
    h.move(f);
    assert.equal(s().progressAt, T0 + 90_000);
    // the turn ends: no progress left over for the next one
    h.end(f);
    await tick();
    assert.equal(s().turn, 'idle');
    assert.equal(s().progressAt, null);
  });

  test(`${family}: a turn stopped while it is quiet takes its progress with it`, async () => {
    at(0);
    const f = setup();
    await h.start(f);
    h.move(f);
    assert.equal(f.s(h.chat).progressAt, T0);
    at(120_000);
    h.stop(f);
    await tick();
    assert.equal(f.s(h.chat).turn, 'idle');
    assert.equal(f.s(h.chat).progressAt, null);
  });
}

test("a harness's events for a segment the chat moved on from are not its turn's progress", async () => {
  at(0);
  const f = setup();
  // the chat runs on Codex now; its earlier Claude Code session still sends
  selectSegment(f.c, f.chats, 'mixed', [
    ['claude', 'claude:old'],
    ['codex', 'mixed'],
  ]);
  f.c.send('mixed', { text: 'hi', opts: { human: true } }, 1);
  f.execs[0].done({ started: true, turnId: 'turn-m' });
  await tick();
  f.c.onClaudeEvent({ key: 'claude:old', kind: 'message', msg: { type: 'stream_event' } });
  f.c.onAcpEvent({
    key: 'mixed',
    kind: 'update',
    turnId: null,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
  });
  assert.equal(f.s('mixed').progressAt, null);
  f.c.onCodexMessage(codex('item/started', { threadId: 'mixed', turnId: 'turn-m' }));
  assert.equal(f.s('mixed').progressAt, T0);
});
