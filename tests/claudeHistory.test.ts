// Claude chat history in the window (src/session/harness/claude/history.ts): the latest page on open with opens replacing each
// other, older pages on request, and a follow refresh that keeps the older pages read before.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset } from './support/harness-logic-fakes.ts';
import { controlledReads } from './support/async-scenarios.ts';
import { turnsOver } from './support/claude-turns-fake.ts';
import { pageBytes, readPage } from './support/claude-translate.ts';
const { openLatestClaudeTurns, loadOlderClaudeTurns, readClaudeTurns } = await import('../src/session/harness/claude/history.ts');
const { createClaudeFollowing } = await import('../src/session/harness/claude/following.ts');

const U = '11111111-1111-1111-1111-111111111111';
const prompt = (uuid: string, ts = '2026-01-01T00:00:00Z') => ({
  type: 'user',
  uuid,
  timestamp: ts,
  message: { role: 'user', content: uuid },
});
const reply = (uuid: string) => ({
  type: 'assistant',
  uuid,
  timestamp: '2026-01-01T00:00:01Z',
  message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
});
/** n prompt/reply pairs: turns h-p0 … h-p<n-1> */
const chat = (n: number) => Array.from({ length: n }, (_, i) => [prompt(`p${i}`), reply(`a${i}`)]).flat();
const ids = (turns: { id: string }[]) => turns.map((t) => t.id);
const ID = 'claude:s';
/** let the opens ask main for the chat's session before their transcript reads go out */
const asked = () => new Promise((r) => setImmediate(r));

beforeEach((t: any) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fx.state.threads[ID] = { id: ID, cwd: '/work', updatedAt: 0 };
  // main runs no turn on the chat unless a test says so
  fx.native.session = { snapshot: async () => null };
});

test('a chat opens on its latest page with the cursor before it; turns streaming meanwhile stay; older pages page in', async () => {
  const asked: any[] = [];
  fx.native.claude = { turns: (sid: string, o: any) => (asked.push([sid, o]), turnsOver(() => chat(35))(sid, o)) };
  fx.state.runtime[ID] = { turns: [{ id: `pending-${U}`, status: 'inProgress', items: [] }] };
  let opened = 0;
  await openLatestClaudeTurns(ID, () => opened++);
  const rt = fx.state.runtime[ID];
  assert.equal(opened, 1);
  assert.deepEqual(ids(rt.turns), [...Array.from({ length: 30 }, (_, i) => `h-p${i + 5}`), `pending-${U}`]);
  assert.equal(rt.olderCursor, 'h-p5');
  assert.equal(rt.loaded, true);
  assert.equal(rt.loading, false);
  assert.deepEqual(asked[0], ['s', { chatId: ID, cwd: '/work', liveTail: true, limit: 30, closedTail: true }]);
  const older = await loadOlderClaudeTurns(ID, 'h-p5');
  assert.deepEqual(ids(older.turns), ['h-p0', 'h-p1', 'h-p2', 'h-p3', 'h-p4']);
  assert.equal(older.nextCursor, null);
  assert.deepEqual(asked[1], ['s', { chatId: ID, cwd: '/work', limit: 30, before: 'h-p5' }]);
  // a chat with no thread record yet reads with no folder
  delete fx.state.threads[ID];
  await loadOlderClaudeTurns(ID, 'h-p5');
  assert.equal(asked[2][1].cwd, '');
});

test('overlapping opens replace each other: an older open settling either way after a newer one shows nothing', async () => {
  for (const order of ['older-last', 'older-first'])
    for (const reject of [false, true]) {
      reset();
      fx.state.threads[ID] = { id: ID, cwd: '/work' };
      const reads = controlledReads<any[]>();
      fx.native.claude = { turns: turnsOver(reads.read) };
      const opened: string[] = [];
      const old = openLatestClaudeTurns(ID, () => opened.push('old'));
      await asked();
      const next = openLatestClaudeTurns(ID, () => opened.push('next'));
      await asked();
      const settleOld = async () => {
        if (reject) reads.requests[0].reject(new Error('old read failed'));
        else reads.requests[0].resolve(chat(1));
        await old;
      };
      if (order === 'older-first') {
        await settleOld();
        assert.equal(fx.state.runtime[ID].loading, true, 'the newer open still owns loading');
        assert.equal(fx.state.runtime[ID].error, null);
      }
      reads.requests[1].resolve(chat(2));
      await next;
      if (order === 'older-last') await settleOld();
      assert.deepEqual(ids(fx.state.runtime[ID].turns), ['h-p0', 'h-p1'], `${order} ${reject}`);
      assert.equal(fx.state.runtime[ID].error, null);
      assert.equal(fx.state.runtime[ID].loading, false);
      assert.deepEqual(opened, ['next']);
    }
});

test('a chat that left this Claude session while it opened shows nothing from the read; a current failure shows', async () => {
  for (const reject of [false, true]) {
    reset();
    fx.state.threads[ID] = { id: ID, cwd: '/work' };
    const reads = controlledReads<any[]>();
    fx.native.claude = { turns: turnsOver(reads.read) };
    let opened = 0;
    const open = openLatestClaudeTurns(ID, () => opened++);
    await asked();
    fx.state.segments[ID] = [{ nativeId: 'codex-thread', harness: 'codex', start: 0 }];
    if (reject) reads.requests[0].reject(new Error('gone'));
    else reads.requests[0].resolve(chat(1));
    await open;
    assert.equal(opened, 0);
    assert.equal(fx.state.runtime[ID].turns.length, 0);
    assert.equal(fx.state.runtime[ID].error, null);
    // not loading and not loaded: opening the chat again reads it as it is now (its switched history)
    assert.equal(fx.state.runtime[ID].loading, false);
    assert.equal(fx.state.runtime[ID].loaded, false);
  }
  reset();
  fx.native.claude = {
    turns: async () => {
      throw new Error('transcript unreadable');
    },
  };
  await openLatestClaudeTurns(ID, () => assert.fail('a failed read is not opened'));
  assert.equal(fx.state.runtime[ID].error, 'transcript unreadable');
  assert.equal(fx.state.runtime[ID].loaded, true);
  assert.equal(fx.state.runtime[ID].loading, false);
  // a read that succeeds later (Retry) takes the failed read's error away
  fx.native.claude = { turns: turnsOver(async () => chat(1)) };
  await openLatestClaudeTurns(ID, () => {});
  assert.equal(fx.state.runtime[ID].error, null);
  assert.equal(fx.state.runtime[ID].turns.length, 1);
});

test('a page read passes its options through and its closed tail is a turn like the others', async () => {
  const tail = { id: 'h-t', status: 'completed', items: [] };
  fx.native.claude = { turns: async () => pageBytes({ turns: [], olderCursor: null, closedTail: tail }) };
  assert.deepEqual(await readClaudeTurns(ID, ID, '/w', { closedTail: true }), { turns: [], olderCursor: null, closedTail: tail });
  fx.native.claude = { turns: async () => pageBytes({ turns: [], olderCursor: null, closedTail: null }) };
  assert.equal((await readClaudeTurns(ID, ID, '/w')).closedTail, null);
});

test("a turn's saved diff lies on it, on the page and on its closed tail", async () => {
  const turn = (id: string) => ({ id, status: 'completed', items: [] });
  const page = { turns: [turn('h-a'), turn('h-b')], olderCursor: null, closedTail: turn('h-t') };
  fx.native.claude = { turns: async () => pageBytes(page, { 'h-a': 'patch a', 'h-t': 'patch t' }) };
  const read = await readClaudeTurns(ID, ID, '/w');
  assert.deepEqual(read.turns, [{ ...turn('h-a'), diff: 'patch a' }, turn('h-b')]);
  assert.deepEqual(read.closedTail, { ...turn('h-t'), diff: 'patch t' });
});

function following(messages: () => any[]) {
  fx.native.claude = { turns: turnsOver(messages) };
  fx.native.session = { snapshot: async () => ({ turn: 'idle', runningElsewhere: true }) };
  fx.store.setElsewhere = (id: string, value: any) => (value ? (fx.state.elsewhere[id] = value) : delete fx.state.elsewhere[id]);
  fx.store.otherAppDone = (id: string) => delete fx.state.elsewhere[id];
  const f = createClaudeFollowing({ fresh: new Set() });
  f.followed.add(ID);
  return f;
}

test('a refresh replaces the latest page and keeps the older pages read before ahead of it', async () => {
  let msgs = chat(40);
  const f = following(() => msgs);
  // shown: the latest page and the older page before it
  fx.state.runtime[ID] = { loaded: true, turns: (await readClaudeTurns(ID, ID, '/work')).turns, olderCursor: null };
  msgs = [...msgs, prompt('p40'), reply('a40')];
  await f.refreshFollowed(ID);
  const rt = fx.state.runtime[ID];
  assert.deepEqual(
    ids(rt.turns),
    Array.from({ length: 41 }, (_, i) => `h-p${i}`),
  );
  assert.equal(rt.olderCursor, null);
  // more turns came than one page holds: what was shown no longer joins the page, so paging starts over from it
  msgs = chat(80);
  await f.refreshFollowed(ID);
  assert.deepEqual(
    ids(fx.state.runtime[ID].turns),
    Array.from({ length: 30 }, (_, i) => `h-p${i + 50}`),
  );
  assert.equal(fx.state.runtime[ID].olderCursor, 'h-p50');
});

test('a turn another app was writing reads closed once no other app is running the chat', async () => {
  const now = () => new Date().toISOString();
  const f = following(() => [...chat(2), prompt('p2', now())]);
  fx.state.runtime[ID] = { loaded: true, turns: [], olderCursor: null };
  await f.refreshFollowed(ID);
  assert.equal(fx.state.runtime[ID].turns.at(-1).status, 'inProgress');
  assert.equal(fx.state.elsewhere[ID].running, true);
  fx.native.session.snapshot = async () => ({ turn: 'idle', runningElsewhere: false });
  await f.refreshFollowed(ID);
  assert.deepEqual(ids(fx.state.runtime[ID].turns), ['h-p0', 'h-p1', 'h-p2']);
  assert.equal(fx.state.runtime[ID].turns.at(-1).status, 'completed');
  assert.equal(fx.state.elsewhere[ID], undefined);
});

/** main's answers to the session snapshots, in order (the last one repeats) */
const snapshots = (...turns: (string | null)[]) => {
  let n = 0;
  return {
    snapshot: async () => ((t) => (t === null ? null : { turn: t, runningElsewhere: false }))(turns[Math.min(n++, turns.length - 1)]),
  };
};
const toolTurn = (status: string) => ({
  id: 'h-p1',
  status,
  items: [
    { type: 'userMessage', id: 'u1', content: [] },
    { type: 'commandExecution', id: 'toolu_1', status },
  ],
});

test('a chat opened while main runs its turn reads that turn open and the window takes it over (#1838)', async () => {
  for (const phase of ['running', 'awaitingUser'] as const) {
    reset();
    fx.state.threads[ID] = { id: ID, cwd: '/work' };
    const asked: any[] = [];
    fx.native.claude = {
      turns: async (_sid: string, o: any) => (
        asked.push(o),
        pageBytes({
          turns: [
            { id: 'h-p0', status: 'completed', items: [] },
            { ...toolTurn('inProgress'), id: 'auto-early' },
          ],
          olderCursor: null,
          closedTail: null,
        })
      ),
    };
    fx.native.session = snapshots(phase);
    // a message that arrived before the chat opened: main's translator opened a turn of its own, and names the read turn by it
    fx.state.runtime[ID] = {
      turns: [{ id: 'auto-early', status: 'inProgress', items: [{ type: 'agentMessage', id: 'm-late', text: 'pulse 3' }] }],
    };
    await openLatestClaudeTurns(ID, () => {});
    const rt = fx.state.runtime[ID];
    assert.equal(asked[0].open, true, 'the turn main runs is read open, its tool calls with it');
    assert.deepEqual(ids(rt.turns), ['h-p0', 'auto-early'], 'the turn that streamed early folds into the transcript turn');
    const last = rt.turns.at(-1);
    assert.deepEqual(
      last.items.map((i: any) => i.id),
      ['u1', 'toolu_1', 'm-late'],
      'what arrived before the chat opened stays',
    );
    assert.equal(last.items[1].status, 'inProgress');
    assert.deepEqual([last.status, last.completedAt, last.durationMs], ['inProgress', null, null]);
    assert.equal(rt.activeTurnId, 'auto-early');
  }
});

test('a quota notice that streamed before the chat opened reconciles with its canonical earlier turn', async () => {
  const first = { type: 'statusNote', kind: 'limit', id: 'canonical', text: 'First reset' };
  const early = { type: 'statusNote', kind: 'limit', id: 'early', text: 'Latest reset' };
  fx.native.claude = {
    turns: async () =>
      pageBytes({
        turns: [
          { id: 'h-first', items: [first] },
          { id: 'auto-early', items: [] },
        ],
        olderCursor: null,
        closedTail: null,
      }),
  };
  fx.native.session = snapshots('running');
  fx.state.runtime[ID] = { turns: [{ id: 'auto-early', status: 'inProgress', items: [early] }] };
  await openLatestClaudeTurns(ID, () => {});
  const notes = fx.state.runtime[ID].turns.flatMap((t: any) => t.items).filter((i: any) => i.kind === 'limit');
  assert.deepEqual(notes, [{ ...first, text: 'Latest reset' }]);
  assert.deepEqual(ids(fx.state.runtime[ID].turns), ['h-first', 'auto-early']);
});

test('a turn that ends while it is read open is read again as it ended; an idle chat reads once', async () => {
  for (const [answers, reads, status] of [
    [['running', 'idle'], [true, undefined], 'completed'],
    [['idle'], [undefined], 'completed'],
  ] as const) {
    reset();
    fx.state.threads[ID] = { id: ID, cwd: '/work' };
    const asked: any[] = [];
    fx.native.claude = {
      turns: async (_s: string, o: any) => (
        asked.push(o), pageBytes({ turns: [toolTurn('completed')], olderCursor: null, closedTail: null })
      ),
    };
    fx.native.session = snapshots(...answers);
    await openLatestClaudeTurns(ID, () => {});
    assert.deepEqual(
      asked.map((o) => o.open),
      reads,
    );
    assert.equal(fx.state.runtime[ID].turns.at(-1).status, status);
  }
});

test("another app's running turn or no answer from main is left as read", async () => {
  for (const kind of ['elsewhere', 'null', 'throws'] as const) {
    reset();
    fx.state.threads[ID] = { id: ID, cwd: '/work' };
    fx.native.claude = { turns: turnsOver(() => chat(1)) };
    fx.native.session = {
      snapshot: async () => {
        if (kind === 'throws') throw new Error('main busy');
        if (kind === 'null') return null;
        return { turn: 'running', runningElsewhere: kind === 'elsewhere' };
      },
    };
    await openLatestClaudeTurns(ID, () => {});
    assert.equal(fx.state.runtime[ID].activeTurnId ?? null, null, kind);
  }
});

test("a turn main's translator hasn't named keeps its transcript id, with nothing to fold in", async () => {
  fx.native.claude = { turns: async () => pageBytes({ turns: [toolTurn('inProgress')], olderCursor: null, closedTail: null }) };
  fx.native.session = snapshots('running');
  await openLatestClaudeTurns(ID, () => {});
  const rt = fx.state.runtime[ID];
  assert.deepEqual(
    rt.turns.at(-1).items.map((i: any) => i.id),
    ['u1', 'toolu_1'],
  );
  assert.equal(rt.activeTurnId, 'h-p1');
});

test('a chat reopened right after its own turn ended shows that turn ended, not left running (#2332)', async () => {
  // the transcript's last prompt was written a moment ago: read with a live tail it comes back open
  const fresh = () => [...chat(1), prompt('p1', new Date().toISOString())];
  for (const [snapshot, status] of [
    [async () => ({ turn: 'idle', runningElsewhere: false }), 'completed'],
    // another app writing it, no answer from main, or a failed read: the tail stays a running turn, as the follow reads it
    [async () => ({ turn: 'idle', runningElsewhere: true }), 'inProgress'],
    [async () => null, 'inProgress'],
    [
      async () => {
        throw new Error('main busy');
      },
      'inProgress',
    ],
  ] as const) {
    reset();
    fx.state.threads[ID] = { id: ID, cwd: '/work' };
    fx.native.claude = { turns: turnsOver(fresh) };
    fx.native.session = { snapshot };
    await openLatestClaudeTurns(ID, () => {});
    const rt = fx.state.runtime[ID];
    assert.deepEqual(ids(rt.turns), ['h-p0', 'h-p1']);
    assert.equal(rt.turns.at(-1).status, status);
    assert.equal(rt.loading, false);
  }
});

test('a blank terminal assistant reply is idle even while the recent-tail heuristic keeps it open', async () => {
  const { claudeTailRunning } = await import('../electron/session/contract/reconcile.cjs');
  const now = new Date().toISOString();
  const records = [
    prompt('p1', now),
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: now,
      message: { id: 'm-a1', role: 'assistant', content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' },
    },
  ];
  const elsewhere = claudeTailRunning(records.map((r) => JSON.stringify(r)));
  assert.equal(elsewhere, false, 'main sees a terminal reply, so no external writer owns the chat');
  const build = turnsOver(() => records);
  assert.equal(readPage(await build('s', { chatId: ID, cwd: '/work', liveTail: true })).turns.at(-1)?.status, 'inProgress');
  fx.native.claude = { turns: build };
  fx.native.session = { snapshot: async () => ({ turn: 'idle', runningElsewhere: elsewhere }) };
  await openLatestClaudeTurns(ID, () => {});
  assert.equal(fx.state.runtime[ID].turns.at(-1).status, 'completed');
});

test('an idle history read rechecks a writer that starts while the transcript is pending', async () => {
  for (const writer of ['elsewhere', 'main', 'unknown'] as const) {
    reset();
    fx.state.threads[ID] = { id: ID, cwd: '/work' };
    const fresh = [...chat(1), prompt('p1', new Date().toISOString())];
    const pending = controlledReads<any[]>();
    const options: any[] = [];
    const build = turnsOver(() => (options.length === 1 ? pending.read() : fresh));
    fx.native.claude = { turns: (id: string, o: any) => (options.push(o), build(id, o)) };
    let writing = false;
    fx.native.session = {
      snapshot: async () =>
        writing && writer === 'unknown'
          ? null
          : {
              turn: writing && writer === 'main' ? 'running' : 'idle',
              runningElsewhere: writing && writer === 'elsewhere',
            },
    };
    const open = openLatestClaudeTurns(ID, () => {});
    await asked();
    writing = true;
    pending.requests[0].resolve(fresh);
    await open;
    assert.equal(fx.state.runtime[ID].turns.at(-1).status, 'inProgress', writer);
    assert.equal(options.length, writer === 'main' ? 2 : 1, 'only a main writer needs its tools read open again');
    if (writer === 'main') assert.equal(options[1].open, true);
  }
});

test('a writer that starts and ends during successive reads leaves the tail closed', async () => {
  const options: any[] = [];
  const fresh = [...chat(1), prompt('p1', new Date().toISOString())];
  const build = turnsOver(() => fresh);
  fx.native.claude = { turns: (id: string, o: any) => (options.push(o), build(id, o)) };
  fx.native.session = snapshots('idle', 'running', 'idle', 'idle');
  await openLatestClaudeTurns(ID, () => {});
  assert.deepEqual(
    options.map((o) => o.open === true),
    [false, true, false],
  );
  assert.equal(fx.state.runtime[ID].turns.at(-1).status, 'completed');
});

test('a retired open never rereads the transcript after the writer changes', async () => {
  const pending = controlledReads<any[]>();
  const options: any[] = [];
  const build = turnsOver(pending.read);
  fx.native.claude = { turns: (id: string, o: any) => (options.push(o), build(id, o)) };
  fx.native.session = snapshots('idle', 'running');
  const open = openLatestClaudeTurns(ID, () => assert.fail('retired open'));
  await asked();
  fx.state.segments[ID] = [{ nativeId: 'codex-thread', harness: 'codex', start: 0 }];
  pending.requests[0].resolve(chat(1));
  await open;
  assert.equal(options.length, 1);
  assert.equal(fx.state.runtime[ID].loading, false);
  assert.equal(fx.state.runtime[ID].turns.length, 0);
});

test('an open replaced during its initial status read never dispatches a transcript read', async () => {
  let reads = 0;
  const build = turnsOver(() => (reads++, chat(1)));
  fx.native.claude = { turns: build };
  fx.native.session = snapshots('idle');
  const opened: string[] = [];
  const old = openLatestClaudeTurns(ID, () => opened.push('old'));
  const next = openLatestClaudeTurns(ID, () => opened.push('next'));
  await Promise.all([old, next]);
  assert.equal(reads, 1);
  assert.deepEqual(opened, ['next']);
});

test('a continuously changing writer leaves a retryable error instead of loading forever', async () => {
  const options: any[] = [];
  const build = turnsOver(() => chat(1));
  fx.native.claude = { turns: (id: string, o: any) => (options.push(o), build(id, o)) };
  fx.native.session = snapshots('idle', 'running', 'idle', 'running', 'idle');
  await openLatestClaudeTurns(ID, () => assert.fail('unstable read cannot open'));
  assert.equal(options.length, 4);
  assert.equal(fx.state.runtime[ID].loading, false);
  assert.equal(fx.state.runtime[ID].error, 'The chat kept changing while its history loaded. Try again.');
  fx.native.session = snapshots('idle');
  await openLatestClaudeTurns(ID, () => {});
  assert.equal(fx.state.runtime[ID].error, null);
  assert.equal(fx.state.runtime[ID].turns.length, 1);
});
