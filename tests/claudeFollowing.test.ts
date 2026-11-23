// External Claude transcript refreshes retain latest-read, native-session and local-stream ownership.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset, called } from './support/harness-logic-fakes.ts';
import { controlledReads, deferred } from './support/async-scenarios.ts';
import { turnsOver } from './support/claude-turns-fake.ts';
import { waitFor } from './support/waitFor.ts';
const { createClaudeFollowing } = await import('../src/session/harness/claude/following.ts');

beforeEach((t: any) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
});

const prompt = () => ({ type: 'user', uuid: 'u', timestamp: new Date().toISOString(), message: { role: 'user', content: 'working' } });
const done = () => [prompt(), { type: 'result', subtype: 'success', is_error: false }];

function fixture() {
  const reads = controlledReads<any[]>();
  fx.state.threads.chat = { id: 'chat', cwd: '/work', updatedAt: 0 };
  fx.state.runtime.chat = { turns: [], loaded: true };
  fx.native.claude = { turns: turnsOver(reads.read) };
  fx.native.session = { snapshot: async () => ({ turn: 'idle', runningElsewhere: true }) };
  fx.store.setElsewhere = (id: string, value: any) => {
    if (value) fx.state.elsewhere[id] = value;
    else delete fx.state.elsewhere[id];
  };
  fx.store.otherAppDone = (id: string) => delete fx.state.elsewhere[id];
  const following = createClaudeFollowing({ fresh: new Set() });
  following.followed.add('chat');
  return { reads, following };
}

test('an old open-tail reply cannot revive another-app busy after a newer completed transcript', async () => {
  const { reads, following } = fixture();
  const old = following.refreshFollowed('chat');
  const next = following.refreshFollowed('chat');
  reads.requests[1].resolve(done());
  await next;
  const turns = fx.state.runtime.chat.turns;
  reads.requests[0].resolve([prompt()]);
  await old;
  assert.equal(fx.state.runtime.chat.turns, turns);
  assert.equal(fx.state.elsewhere.chat, undefined);
});

test('a turn running in another MoPilot window is never an external writer', async () => {
  for (const turn of ['running', 'awaitingUser']) {
    const { reads, following } = fixture();
    fx.sessions.chat = { turn };
    const pending = following.refreshFollowed('chat');
    reads.requests[0]?.resolve([]);
    await pending;
    assert.equal(reads.requests.length, 0);
    assert.equal(called('setElsewhere').length, 0);
  }
});

test('a transcript reply retired by a local stream, native switch or unwatch cannot publish', async () => {
  for (const retire of ['stream', 'switch', 'unwatch', 'main-turn']) {
    reset();
    const { reads, following } = fixture();
    const pending = following.refreshFollowed('chat');
    if (retire === 'stream') fx.state.runtime.chat.turns = [{ id: 'local', status: 'completed' }];
    if (retire === 'switch') fx.state.segments.chat = [{ nativeId: 'replacement', harness: 'claude' }];
    if (retire === 'unwatch') following.followed.delete('chat');
    if (retire === 'main-turn') fx.sessions.chat = { turn: 'running' };
    const turns = fx.state.runtime.chat.turns;
    reads.requests[0].resolve([prompt()]);
    await pending;
    assert.equal(fx.state.runtime.chat.turns, turns, retire);
    assert.equal(fx.state.elsewhere.chat, undefined, retire);
  }
});

test('older successes and failures leave a newer pending refresh intact in either completion order', async () => {
  for (const reject of [false, true]) {
    for (const olderFirst of [false, true]) {
      reset();
      const { reads, following } = fixture();
      const old = following.refreshFollowed('chat');
      const next = following.refreshFollowed('chat');
      const retireOld = async () => {
        if (reject) reads.requests[0].reject(new Error('old read failed'));
        else reads.requests[0].resolve([prompt()]);
        await old;
      };
      if (olderFirst) {
        await retireOld();
        assert.deepEqual(fx.state.runtime.chat.turns, []);
      }
      reads.requests[1].resolve(done());
      await next;
      if (!olderFirst) await retireOld();
      assert.equal(fx.state.runtime.chat.turns[0].status, 'completed');
      assert.equal(fx.state.elsewhere.chat, undefined);
    }
  }
});

test('local writes clear a false notice, retire reads and silence timers without sending held input', async (t) => {
  const { reads, following } = fixture();
  const active = following.refreshFollowed('chat');
  reads.requests[0].resolve([prompt()]);
  await active;
  assert.equal(fx.state.elsewhere.chat.running, true);
  const old = following.refreshFollowed('chat');
  following.localWrite('chat');
  assert.equal(fx.state.elsewhere.chat, undefined);
  reads.requests[1].resolve([prompt()]);
  await old;
  t.mock.timers.tick(31_000);
  assert.equal(reads.requests.length, 2);
  assert.equal(called('sendHeld').length, 0);
  // Open but idle presence is retained; only the running claim was false.
  fx.state.elsewhere.chat = { app: 'claude-cli', running: false };
  following.localWrite('chat');
  assert.equal(fx.state.elsewhere.chat.app, 'claude-cli');
  // A subsequent real external write can still be followed.
  const retry = following.refreshFollowed('chat');
  reads.requests[2].resolve([prompt()]);
  await retry;
  assert.equal(fx.state.elsewhere.chat.running, true);
});

test('a fresh read of a known local terminal tail cannot infer another app; later external activity and rewinds remain visible', async () => {
  const { reads, following } = fixture();
  fx.native.session.snapshot = async () => ({ turn: 'idle', runningElsewhere: false });
  const own = following.refreshFollowed('chat');
  reads.requests[0].resolve([prompt()]);
  await own;
  assert.equal(fx.state.runtime.chat.turns[0].status, 'completed');
  assert.equal(fx.state.elsewhere.chat, undefined);
  fx.native.session.snapshot = async () => ({ turn: 'idle', runningElsewhere: true });
  const external = following.refreshFollowed('chat');
  reads.requests[1].resolve([prompt(), { ...prompt(), uuid: 'external' }]);
  await external;
  assert.equal(fx.state.elsewhere.chat.running, true);
  fx.native.session.snapshot = async () => ({ turn: 'idle', runningElsewhere: false });
  const rewind = following.refreshFollowed('chat');
  reads.requests[2].resolve([]);
  await rewind;
  assert.deepEqual(fx.state.runtime.chat.turns, []);
  assert.equal(fx.state.elsewhere.chat, undefined);
});

test('the main snapshot owns the second read boundary, including obsolete replies and transport recovery', async () => {
  for (const reply of [null, { turn: 'running', runningElsewhere: false }, { turn: 'awaitingUser', runningElsewhere: false }]) {
    reset();
    const { reads, following } = fixture();
    fx.native.session.snapshot = async () => reply;
    const pending = following.refreshFollowed('chat');
    reads.requests[0].resolve([prompt()]);
    await pending;
    assert.deepEqual(fx.state.runtime.chat.turns, []);
  }
  for (const reject of [false, true]) {
    reset();
    const { reads, following } = fixture();
    const snapshot = deferred<any>();
    let requested = false;
    fx.native.session.snapshot = () => ((requested = true), snapshot.promise);
    const old = following.refreshFollowed('chat');
    reads.requests[0].resolve([prompt()]);
    // the page comes through main's paging and the window's read of it
    await waitFor(() => requested, 'the page request');
    assert.equal(requested, true);
    const next = following.refreshFollowed('chat');
    if (reject) snapshot.reject(new Error('retired snapshot'));
    else snapshot.resolve({ turn: 'idle', runningElsewhere: true });
    await old;
    assert.deepEqual(fx.state.runtime.chat.turns, []);
    fx.native.session.snapshot = async () => ({ turn: 'idle', runningElsewhere: false });
    reads.requests[1].resolve(done());
    await next;
    assert.equal(fx.state.runtime.chat.turns[0].status, 'completed');
  }
  reset();
  const { reads, following } = fixture();
  fx.native.session.snapshot = async () => {
    throw new Error('snapshot unavailable');
  };
  const failed = following.refreshFollowed('chat');
  reads.requests[0].resolve([prompt()]);
  await failed;
  assert.deepEqual(fx.state.runtime.chat.turns, []);
  fx.native.session.snapshot = async () => ({ turn: 'idle', runningElsewhere: true });
  const retry = following.refreshFollowed('chat');
  reads.requests[1].resolve([prompt()]);
  await retry;
  assert.equal(fx.state.elsewhere.chat.running, true);
});

/** main's page of the chat's own Claude Code session: its latest turns, oldest first */
function sessionPage(turns: any[]) {
  fx.native.claude = {
    turns: async () => ({
      page: new TextEncoder().encode(JSON.stringify({ turns, olderCursor: null, closedTail: null })),
      diffs: {},
    }),
  };
}
const t = (id: string, text = id, extra: any[] = []): any => ({
  id,
  status: 'completed',
  items: [...extra, { type: 'agentMessage', id: `${id}-a`, text }],
});
const divider = { type: 'statusNote', id: 'switch-2', kind: 'switch', text: 'Codex → Claude Code' };
const segs = [
  { harness: 'claude', nativeId: 'chat', start: 0, count: 2 },
  { harness: 'codex', nativeId: 'x', start: 2, count: 2 },
  { harness: 'claude', nativeId: 'chat', start: 4, count: null },
];

test("#4257: a chat back on its own Claude Code session re-reads only that segment's turns, keeping the other harness's", async () => {
  const { following } = fixture();
  fx.state.segments.chat = segs;
  fx.state.runtime.chat = { turns: [t('c1'), t('c2'), t('x1'), t('x2'), t('c3', 'c3', [divider])], loaded: true, olderCursor: null };
  // the session's page reaches back over its first segment: c1 and c2 are its turns too
  sessionPage([t('c1'), t('c2'), t('c3', 'c3 written on'), t('c4')]);
  await following.refreshFollowed('chat');
  const shown = fx.state.runtime.chat.turns;
  assert.deepEqual(
    shown.map((x: any) => x.id),
    ['c1', 'c2', 'x1', 'x2', 'c3', 'c4'],
  );
  // the read-back turn has the new text, and keeps the divider the switch put in front of it
  assert.deepEqual(
    shown[4].items.map((i: any) => i.text),
    ['Codex → Claude Code', 'c3 written on'],
  );
});

test('#4257: a page that does not reach the shown turns of the segment reads the chat whole instead of guessing', async () => {
  fixture();
  const whole: string[] = [];
  const following = createClaudeFollowing({ fresh: new Set(), readWhole: async (id) => void whole.push(id) });
  following.followed.add('chat');
  fx.state.segments.chat = segs;
  fx.state.runtime.chat = { turns: [t('c1'), t('c2'), t('x1'), t('x2'), t('c3')], loaded: true, olderCursor: null };
  sessionPage([t('c9'), t('c10')]);
  await following.refreshFollowed('chat');
  assert.deepEqual(
    fx.state.runtime.chat.turns.map((x: any) => x.id),
    ['c1', 'c2', 'x1', 'x2', 'c3'],
  );
  assert.deepEqual(whole, ['chat']);
});

test('#4257: a paged window places the segment by the turns above it, and one with no turn of the segment yet is left as it is', async () => {
  const { currentSegmentPage } = await import('../src/store/turnPages.ts');
  // the window starts 10 turns into the chat: the current segment (from 12) starts at its third turn
  const { following } = fixture();
  fx.state.segments.chat = [segs[0], segs[1], { ...segs[2], start: 12 }];
  fx.state.runtime.chat = { turns: [t('x1'), t('x2'), t('c3')], loaded: true, olderCursor: 'older', turnsAbove: 10 };
  sessionPage([t('c2'), t('c3', 'c3 again')]);
  await following.refreshFollowed('chat');
  assert.deepEqual(
    fx.state.runtime.chat.turns.map((x: any) => x.id),
    ['x1', 'x2', 'c3'],
  );
  // the cut is at the window's third turn (12 - 10): c3 is the segment's, so it takes the page's copy; c2 above the window is skipped
  assert.equal(fx.state.runtime.chat.turns[2].items.at(-1).text, 'c3 again');
  assert.equal(fx.state.runtime.chat.olderCursor, 'older');
  assert.equal(fx.state.runtime.chat.turnsAbove, 10);

  // a segment starting above the window: the cut is the window's top, and every turn is the segment's
  fx.state.segments.chat = [segs[0], segs[1], { ...segs[2], start: 2 }];
  fx.state.runtime.chat = { turns: [t('c5'), t('c6')], loaded: true, olderCursor: 'older', turnsAbove: 10 };
  sessionPage([t('c5', 'c5 again'), t('c6'), t('c7')]);
  await following.refreshFollowed('chat');
  assert.deepEqual(
    fx.state.runtime.chat.turns.map((x: any) => [x.id, x.items.at(-1).text]),
    [
      ['c5', 'c5 again'],
      ['c6', 'c6'],
      ['c7', 'c7'],
    ],
  );

  // the cut moves with what is above: with 11 turns above, the window's second turn already belongs to the segment
  fx.state.segments.chat = [segs[0], segs[1], { ...segs[2], start: 12 }];
  fx.state.runtime.chat = { turns: [t('x2'), t('c3'), t('c4')], loaded: true, olderCursor: 'older', turnsAbove: 11 };
  sessionPage([t('c3', 'c3 again'), t('c4')]);
  await following.refreshFollowed('chat');
  assert.deepEqual(
    fx.state.runtime.chat.turns.map((x: any) => [x.id, x.items.at(-1).text]),
    [
      ['x2', 'x2'],
      ['c3', 'c3 again'],
      ['c4', 'c4'],
    ],
  );

  // pure: nothing of the segment shown yet, the window stays; shown turns before the page's first stay ahead of it
  const shown = [t('x1'), t('c3'), t('c4')];
  assert.equal(currentSegmentPage(shown, 3, [t('c9')]), shown);
  assert.deepEqual(
    currentSegmentPage(shown, 1, [t('c4', 'c4 again'), t('c5')])!.map((x: any) => [x.id, x.items.at(-1).text]),
    [
      ['x1', 'x1'],
      ['c3', 'c3'],
      ['c4', 'c4 again'],
      ['c5', 'c5'],
    ],
  );
  // a divider the read-back turn already carries is not doubled
  const noted = [t('c3', 'c3', [divider])];
  assert.deepEqual(
    currentSegmentPage(noted, 0, [t('c3', 'c3', [divider])])![0].items.map((i: any) => i.id),
    ['switch-2', 'c3-a'],
  );
});

test('#4257: by default a page that cannot be placed reads the chat through the runtime; a chat with no window yet is given none', async () => {
  const { installRuntime } = await import('../src/store/runtime.ts');
  const whole: string[] = [];
  const before = installRuntime({ openCompositeThread: async (id: string) => void whole.push(id) } as any);
  try {
    const { following } = fixture();
    fx.state.segments.chat = segs;
    fx.state.runtime.chat = { turns: [t('c1'), t('c2'), t('x1'), t('x2'), t('c3')], loaded: true, olderCursor: null };
    sessionPage([t('c9')]);
    await following.refreshFollowed('chat');
    assert.deepEqual(whole, ['chat']);

    // the chat's window went while the page was read: nothing of it is shown, so the page places nothing
    delete fx.state.runtime.chat;
    sessionPage([t('c9')]);
    await following.refreshFollowed('chat');
    assert.deepEqual(fx.state.runtime.chat?.turns, []);
    assert.deepEqual(whole, ['chat']);
  } finally {
    installRuntime(before);
  }
});
