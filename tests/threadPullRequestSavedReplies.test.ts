// The sidebar PR badge's saved replies: a chat's history is read from main again only when the chat changed (its
// updatedAt), not on every minute's refresh; unversioned and failed reads are never kept, and the reader passes the version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anyChatLoading, createPullRequestReader, historyVersion, savedReplies } from '../src/lib/threadPullRequest.ts';

const page = () => ({ data: [], nextCursor: null });

test("a chat's saved replies are read again only when its version changes; unversioned and failed reads are not kept", async () => {
  const reads: string[] = [];
  const fail = new Set<string>();
  const replies = savedReplies(
    async (id) => {
      reads.push(id);
      if (fail.has(id)) throw new Error('history unavailable');
      return [
        { status: 'completed', items: [{ type: 'agentMessage', text: `Opened PR #${reads.length} for ${id}.` }] },
        { status: 'completed', items: [{ type: 'agentMessage', text: 'Ran the tests again.' }] },
      ];
    },
    { limit: 2 },
  );
  const first = await replies('a', '1');
  // only the reply that bears on a PR is kept
  assert.deepEqual(first, [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Opened PR #1 for a.' }] }]);
  // the minute's refresh of an unchanged chat reuses the read
  assert.equal(await replies('a', '1'), first);
  assert.deepEqual(reads, ['a']);
  // the chat changed: its replies are read again
  assert.notEqual(await replies('a', '2'), first);
  assert.deepEqual(reads, ['a', 'a']);
  // no version: always read, and returned whole
  assert.equal((await replies('a')).length, 2);
  await replies('a');
  assert.deepEqual(reads, ['a', 'a', 'a', 'a']);
  // a failed read reaches the caller and is read again next time
  fail.add('b');
  await assert.rejects(replies('b', '1'), /history unavailable/);
  await new Promise((r) => setImmediate(r));
  fail.delete('b');
  await replies('b', '1');
  assert.deepEqual(reads.slice(4), ['b', 'b']);
  // past the limit the chat read longest ago goes first
  await replies('c', '1');
  await replies('b', '1');
  await replies('a', '2');
  assert.deepEqual(reads.slice(6), ['c', 'a']);
});

test('an older failed read never drops the newer version that replaced it', async () => {
  let rejectOld!: (e: Error) => void;
  let calls = 0;
  const replies = savedReplies(
    (id) => {
      calls++;
      return calls === 1
        ? new Promise((_resolve, reject) => {
            rejectOld = reject;
          })
        : Promise.resolve([{ status: 'completed', items: [{ type: 'agentMessage', text: id }] }]);
    },
    { slots: 2 },
  );
  const old = replies('a', '1');
  const fresh = await replies('a', '2');
  rejectOld(new Error('late'));
  await assert.rejects(old, /late/);
  await new Promise((r) => setImmediate(r));
  assert.equal(await replies('a', '2'), fresh);
  assert.equal(calls, 2);
});

test("the reader hands the chat's version to its replies", async () => {
  const versions: unknown[] = [];
  const read = createPullRequestReader({
    attachments: async () => page(),
    legacy: async () => null,
    head: async () => null,
    responses: async (_id, version) => (versions.push(version), []),
    gh: async () => ({ ok: false, stdout: '' }),
  });
  await read('chat', '', true, '7');
  await read('chat');
  assert.deepEqual(versions, ['7', undefined]);
});

test("a chat's history version changes with its update time and with its native session, and keeps the two apart", () => {
  assert.equal(historyVersion(5, 'thread-a'), historyVersion(5, 'thread-a'));
  // a switched harness or native session reads its own history, though the row was not updated
  assert.notEqual(historyVersion(5, 'thread-a'), historyVersion(5, 'thread-b'));
  assert.notEqual(historyVersion(5, 'thread-a'), historyVersion(6, 'thread-a'));
  // delimiters inside an id never make two versions equal
  assert.notEqual(historyVersion(5, '1,x'), historyVersion(51, 'x'));
});

const turn = (text: string) => [{ status: 'completed', items: [{ type: 'agentMessage', text: `PR #1 ${text}` }] }];
const tick = () => new Promise((r) => setImmediate(r));

test('one chat is read from main at a time; the rest wait their turn in the order asked (#2963)', async () => {
  const started: string[] = [];
  const settle = new Map<string, () => void>();
  const replies = savedReplies(
    (id) =>
      new Promise((resolve) => {
        started.push(id);
        settle.set(id, () => resolve(turn(id)));
      }),
  );
  const all = ['a', 'b', 'c'].map((id) => replies(id, '1'));
  await tick();
  // main parses each whole history in its own heap: one at a time keeps its peak to one transcript's
  assert.deepEqual(started, ['a']);
  settle.get('a')!();
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  settle.get('b')!();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  settle.get('c')!();
  assert.equal((await Promise.all(all)).length, 3);
});

test('with more places, that many chats are read at once and the rest wait in the order asked', async () => {
  const started: string[] = [];
  const settle = new Map<string, () => void>();
  const replies = savedReplies(
    (id) =>
      new Promise((resolve) => {
        started.push(id);
        settle.set(id, () => resolve(turn(id)));
      }),
    { slots: 2 },
  );
  const all = ['a', 'b', 'c', 'd', 'e'].map((id) => replies(id, '1'));
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  settle.get('a')!();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  settle.get('c')!();
  settle.get('b')!();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  settle.get('d')!();
  settle.get('e')!();
  assert.equal((await Promise.all(all)).length, 5);
});

test('a failed read gives its place to the next chat and reaches its own caller', async () => {
  const started: string[] = [];
  const replies = savedReplies(
    (id) => {
      started.push(id);
      return id === 'a' ? Promise.reject(new Error('gone')) : Promise.resolve(turn(id));
    },
    { limit: 10 },
  );
  const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map((id) => replies(id, '1')));
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'fulfilled', 'fulfilled', 'fulfilled'],
  );
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
});

test('a read that never settles gives up its place after thirty seconds, and its late answer is still delivered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started: string[] = [];
  let finishHung!: () => void;
  const replies = savedReplies(
    (id) => {
      started.push(id);
      return id === 'a'
        ? new Promise((resolve) => {
            finishHung = () => resolve(turn(id));
          })
        : id === 'b'
          ? new Promise(() => {})
          : Promise.resolve(turn(id));
    },
    { slots: 2 },
  );
  const hung = replies('a', '1');
  void replies('b', '1');
  const next = replies('c', '1');
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  t.mock.timers.tick(30_000);
  assert.equal((await next).length, 1);
  assert.deepEqual(started, ['a', 'b', 'c']);
  // the slot is already free: the late answer neither frees another place nor is lost
  finishHung();
  assert.equal((await hung).length, 1);
});

test('no badge read starts while a chat is being opened; they go on when it is done, or after five seconds of waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const started: string[] = [];
  let opening = true;
  const replies = savedReplies((id) => (started.push(id), Promise.resolve(turn(id))), { limit: 10, opening: () => opening });
  const first = replies('a', '1');
  const second = replies('b', '1');
  await tick();
  assert.deepEqual(started, []);
  // the click's read finishes: the waiting reads start at the next look
  opening = false;
  t.mock.timers.tick(100);
  assert.equal((await first).length + (await second).length, 2);
  assert.deepEqual(started, ['a', 'b']);
  // a chat whose open never ends cannot hold a badge for good
  opening = true;
  const stuck = replies('c', '1');
  t.mock.timers.tick(4_900);
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  t.mock.timers.tick(100);
  assert.equal((await stuck).length, 1);
  assert.deepEqual(started, ['a', 'b', 'c']);
});

test("a hung read's late answer never replaces the newer version's reads for the same chat", async () => {
  let answerOld!: () => void;
  let calls = 0;
  const replies = savedReplies(
    (id) => {
      calls++;
      return calls === 1
        ? new Promise((resolve) => {
            answerOld = () => resolve(turn(`old ${id}`));
          })
        : Promise.resolve(turn(`new ${id}`));
    },
    { slots: 2 },
  );
  const old = replies('a', '1');
  const fresh = await replies('a', '2');
  answerOld();
  assert.match(JSON.stringify(await old), /old a/);
  // the chat's saved reads are the newer version's, whatever the old one answered
  assert.equal(await replies('a', '2'), fresh);
  assert.match(JSON.stringify(fresh), /new a/);
  assert.equal(calls, 2);
});

test('a chat is being opened while any chat is loading its history', () => {
  assert.equal(anyChatLoading(undefined), false);
  assert.equal(anyChatLoading({ a: { loading: false }, b: { loading: false } }), false);
  assert.equal(anyChatLoading({ a: { loading: false }, b: { loading: true } }), true);
});

test('a read still queued when a newer version of its chat replaced it is not parsed again; it answers with the newer one', async () => {
  const reads: string[] = [];
  const settle = new Map<string, () => void>();
  const replies = savedReplies(
    (id) =>
      new Promise((resolve) => {
        reads.push(id);
        settle.set(id, () => resolve(turn(`${id} v${reads.length}`)));
      }),
    { slots: 2 },
  );
  // two slots held by other chats; chat c waits at version 1 and is replaced by version 2 before it starts
  const x = replies('x', '1');
  const y = replies('y', '1');
  const old = replies('c', '1');
  const fresh = replies('c', '2');
  await tick();
  assert.deepEqual(reads, ['x', 'y']);
  settle.get('x')!();
  settle.get('y')!();
  await tick();
  // version 1 reuses version 2's read (the one that parses), so chat c is read once
  assert.deepEqual(reads, ['x', 'y', 'c']);
  settle.get('c')!();
  const [a, b] = await Promise.all([old, fresh, x, y]);
  assert.deepEqual(a, b);
});

test('replaced reads queued behind the busy places cannot hold those places waiting for their replacements', async () => {
  const reads: string[] = [];
  const settle = new Map<string, () => void>();
  const replies = savedReplies(
    (id) =>
      new Promise((resolve) => {
        reads.push(id);
        settle.set(id, () => resolve(turn(id)));
      }),
    { slots: 2 },
  );
  const busy = [replies('x', '1'), replies('y', '1')];
  const old = [replies('c', '1'), replies('d', '1')];
  const fresh = [replies('c', '2'), replies('d', '2')];
  await tick();
  settle.get('x')!();
  settle.get('y')!();
  await tick();
  // the two replaced reads took no place, so both replacements started at once
  assert.deepEqual(reads, ['x', 'y', 'c', 'd']);
  settle.get('c')!();
  settle.get('d')!();
  assert.equal((await Promise.all([...busy, ...old, ...fresh])).length, 6);
});

test('a queued read whose cache entry was evicted is still read, not left without an answer', async () => {
  const reads: string[] = [];
  const settle = new Map<string, () => void>();
  const replies = savedReplies(
    (id) =>
      new Promise((resolve) => {
        reads.push(id);
        settle.set(id, () => resolve(turn(id)));
      }),
    { limit: 1, slots: 2 },
  );
  const all = [replies('x', '1'), replies('y', '1'), replies('c', '1'), replies('d', '1')];
  await tick();
  // c was evicted when d came
  settle.get('x')!();
  settle.get('y')!();
  await tick();
  settle.get('c')!();
  settle.get('d')!();
  assert.equal((await Promise.all(all)).length, 4);
  assert.deepEqual(reads, ['x', 'y', 'c', 'd']);
});
