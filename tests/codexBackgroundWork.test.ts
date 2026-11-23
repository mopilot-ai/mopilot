// What a Codex chat runs after its turn, as main counts it for every window (electron/harness/codexBackgroundWork.cjs):
// a thread's background commands, read when its turn ends and every tick while one runs, and its sub-agents' running turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { CodexBackgroundWork, POLL_MS } = require('../electron/harness/codexBackgroundWork.cjs');

type Read = { threadId: string; resolve: (r: unknown) => void; reject: (e: unknown) => void };

function rig() {
  const reads: Read[] = [];
  const published: [string, { shells: number; agents: number }][] = [];
  const turning = new Set<string>();
  const parents = new Map<string, string>();
  const own = new Map<string, string[]>();
  const hidden = new Set<string>();
  const timer = { fn: null as null | (() => void), ms: 0, cleared: 0, set: 0 };
  const w = new CodexBackgroundWork({
    list: (threadId: string, ms: number) => {
      assert.ok(ms > 0, 'a read that does not answer gives up');
      return new Promise((resolve, reject) => reads.push({ threadId, resolve, reject }));
    },
    turning: () => turning,
    rootOf: (id: string) => {
      let k = id;
      while (parents.has(k)) k = parents.get(k)!;
      return k;
    },
    ownCommand: (id: string, item: string) => (own.get(id) ?? []).includes(item),
    shown: (id: string) => !hidden.has(id),
    publish: (threadId: string, work: { shells: number; agents: number }) => published.push([threadId, work]),
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        timer.set++;
        timer.fn = fn;
        timer.ms = ms;
        return { unref() {} };
      },
      clearInterval: () => {
        timer.cleared++;
        timer.fn = null;
      },
    },
  });
  const rows = (...items: string[]) => ({ data: items.map((itemId, i) => ({ itemId, processId: `p${i}`, command: 'sleep 9' })) });
  const answer = async (r: unknown) => {
    reads.shift()!.resolve(r);
    await tick();
  };
  return { w, reads, published, turning, parents, own, hidden, timer, rows, answer };
}

test("a turn's end reads what it left running, every tick reads it again, and the count clears once the commands end", async () => {
  const r = rig();
  r.w.observe('turn/started', { threadId: 't' });
  assert.equal(r.reads.length, 0, 'a turn starting reads nothing: the turn keeps the chat working');
  r.w.observe('turn/completed', { threadId: 't' });
  assert.deepEqual(
    r.reads.map((x) => x.threadId),
    ['t'],
  );
  await r.answer(r.rows('cmd-1', 'cmd-2'));
  assert.deepEqual(r.published, [['t', { shells: 2, agents: 0 }]]);
  assert.equal(r.timer.ms, POLL_MS);
  r.timer.fn!();
  await r.answer(r.rows('cmd-1', 'cmd-2'));
  assert.equal(r.published.length, 2, 'the same count is published again (the session store drops an unchanged key)');
  // a new turn's own command is that turn's work, not background work
  r.own.set('t', ['cmd-3']);
  r.timer.fn!();
  await r.answer(r.rows('cmd-1', 'cmd-3'));
  assert.deepEqual(r.published.at(-1), ['t', { shells: 1, agents: 0 }]);
  r.timer.fn!();
  await r.answer({ data: [] });
  assert.deepEqual(r.published.at(-1), ['t', { shells: 0, agents: 0 }]);
  assert.equal(r.timer.fn, null, 'no command runs: the timer stops');
  assert.equal(r.w.shells.size, 0);
  // a turn that left nothing running publishes nothing
  const before = r.published.length;
  r.w.observe('turn/completed', { threadId: 'u' });
  await r.answer({ data: [] });
  assert.equal(r.published.length, before);
  assert.equal(r.timer.set, 1);
});

test('a list that fails, or answers in an unexpected shape, settles no command; the next tick reads again', async () => {
  const r = rig();
  r.w.observe('turn/completed', { threadId: 't' });
  await r.answer(r.rows('a'));
  r.timer.fn!();
  r.reads.shift()!.reject(new Error('Codex app-server did not answer thread/backgroundTerminals/list'));
  await tick();
  assert.deepEqual(r.published.at(-1), ['t', { shells: 1, agents: 0 }], 'a failed read keeps the count');
  assert.ok(r.timer.fn, 'and the timer');
  // rows without a process are no command; extra fields are fine
  r.timer.fn!();
  await r.answer({ data: [null, { itemId: 'x' }, { itemId: 'b', processId: 0, extra: true }] });
  assert.deepEqual(r.published.at(-1), ['t', { shells: 1, agents: 0 }]);
  // an answer with no list reads as none running (as the windows' poll reads it)
  for (const bad of [null, {}, { data: 'x' }]) {
    r.w.observe('turn/completed', { threadId: 'v' });
    await r.answer(r.rows('a'));
    r.w.observe('turn/completed', { threadId: 'v' });
    await r.answer(bad);
    assert.deepEqual(r.published.at(-1), ['v', { shells: 0, agents: 0 }]);
  }
  // the other answer shape some app-servers send (the lease and the recycler read it too)
  r.w.observe('turn/completed', { threadId: 'v' });
  await r.answer({ terminals: [{ itemId: 'z', processId: 'p' }, { processId: 'no-item' }] });
  assert.deepEqual(r.published.at(-1), ['v', { shells: 2, agents: 0 }], 'a row without its item is still a command');
  // a first read that fails publishes nothing and keeps no record
  const n = r.published.length;
  r.w.observe('turn/completed', { threadId: 'u' });
  r.reads.shift()!.reject(new Error('down'));
  await tick();
  assert.equal(r.published.length, n);
  assert.equal(r.w.shells.has('u'), false);
  // a thread no chat shows (a sub-agent before its link, a chat main doesn't track) is not read
  r.hidden.add('h');
  r.w.observe('turn/completed', { threadId: 'h' });
  assert.equal(r.reads.length, 0);
  // a notification without a thread is no one's
  r.w.observe('turn/completed', {});
  r.w.observe('turn/completed', null);
  assert.equal(r.reads.length, 0);
});

test('one read per thread at a time: a trigger during it reads once more after it, in either order of answers', async () => {
  const r = rig();
  r.w.observe('turn/completed', { threadId: 't' });
  r.w.observe('turn/completed', { threadId: 't' });
  r.w.observe('turn/completed', { threadId: 't' });
  assert.equal(r.reads.length, 1, 'coalesced');
  await r.answer(r.rows('a'));
  assert.equal(r.reads.length, 1, 'one more read for the triggers during the first');
  await r.answer({ data: [] });
  assert.equal(r.reads.length, 0);
  assert.deepEqual(r.published, [
    ['t', { shells: 1, agents: 0 }],
    ['t', { shells: 0, agents: 0 }],
  ]);
  // two threads read side by side, answered in the other order, each keep their own count
  r.w.observe('turn/completed', { threadId: 'x' });
  r.w.observe('turn/completed', { threadId: 'y' });
  r.reads.pop()!.resolve(r.rows('y1', 'y2'));
  await tick();
  await r.answer(r.rows('x1'));
  assert.deepEqual(r.published.slice(-2), [
    ['y', { shells: 2, agents: 0 }],
    ['x', { shells: 1, agents: 0 }],
  ]);
});

test('a thread unloading or the app-server exiting ends its work, and a read still in flight then publishes nothing', async () => {
  const r = rig();
  r.w.observe('turn/completed', { threadId: 't' });
  await r.answer(r.rows('a'));
  r.timer.fn!();
  r.timer.fn!();
  assert.equal(r.reads.length, 1, 'a tick does not ask again behind a read still out');
  r.w.observe('thread/closed', { threadId: 't' });
  assert.deepEqual(r.published.at(-1), ['t', { shells: 0, agents: 0 }]);
  assert.equal(r.timer.fn, null);
  const n = r.published.length;
  await r.answer(r.rows('a'));
  assert.equal(r.published.length, n, 'the read from before it unloaded is retired');
  // a thread that never ran work unloads quietly
  r.w.observe('thread/closed', { threadId: 'never' });
  assert.equal(r.published.length, n);

  // the app-server exits with a command and a sub-agent running, and a read in flight
  r.parents.set('k', 't');
  r.turning.add('k');
  r.w.observe('turn/started', { threadId: 'k' });
  r.w.observe('turn/completed', { threadId: 't' });
  await r.answer(r.rows('a'));
  r.timer.fn!();
  assert.deepEqual(r.published.at(-1), ['t', { shells: 1, agents: 1 }]);
  r.turning.clear(); // the adapter clears its running turns first
  r.w.clear();
  assert.deepEqual(r.published.at(-1), ['t', { shells: 0, agents: 0 }]);
  assert.equal(r.timer.fn, null);
  const m = r.published.length;
  await r.answer(r.rows('a'));
  assert.equal(r.published.length, m, 'a read of the process that exited is retired');
  // the next process's work is counted again (setup, cleanup, setup)
  r.w.observe('turn/completed', { threadId: 't' });
  await r.answer(r.rows('b'));
  assert.deepEqual(r.published.at(-1), ['t', { shells: 1, agents: 0 }]);
  assert.ok(r.timer.fn);
});

test('a sub-agent counts on its spawning thread while it runs a turn, through a spawn linked after its turn started', async () => {
  const r = rig();
  // the child's turn starts before anything links it: it is a thread of its own, with nothing to read
  r.turning.add('k');
  r.w.observe('turn/started', { threadId: 'k' });
  assert.deepEqual(r.published, []);
  r.parents.set('k', 't');
  r.w.observe('item/started', { threadId: 't', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['k'] } });
  assert.deepEqual(r.published, [['t', { shells: 0, agents: 1 }]]);
  // a grandchild counts on the chat at the top of the chain
  r.parents.set('g', 'k');
  r.turning.add('g');
  r.w.observe('turn/started', { threadId: 'g' });
  assert.deepEqual(r.published.at(-1), ['t', { shells: 0, agents: 2 }]);
  // the parent's own turn doesn't count as background
  r.turning.add('t');
  r.w.observe('turn/started', { threadId: 't' });
  r.turning.delete('g');
  r.w.observe('turn/completed', { threadId: 'g' });
  assert.deepEqual(r.published.at(-1), ['t', { shells: 0, agents: 1 }]);
  assert.equal(r.reads.length, 0, "a sub-agent's turn ending reads no list");
  r.turning.delete('k');
  r.w.observe('turn/completed', { threadId: 'k' });
  assert.deepEqual(r.published.at(-1), ['t', { shells: 0, agents: 0 }]);
  // other items change nothing
  const n = r.published.length;
  r.w.observe('item/started', { threadId: 't', item: { type: 'agentMessage' } });
  r.w.observe('item/completed', { threadId: 't', item: { type: 'collabAgentToolCall', tool: 'wait' } });
  assert.equal(r.published.length, n);
});

test('a sub-agent thread unloading mid-turn takes its count off the chat that spawned it', () => {
  const r = rig();
  r.parents.set('k', 't');
  r.turning.add('k');
  r.w.observe('turn/started', { threadId: 'k' });
  assert.deepEqual(r.published, [['t', { shells: 0, agents: 1 }]]);
  // codexParents forgets the link before this tracker sees the thread close; its turn never reports an end
  r.parents.delete('k');
  r.w.observe('thread/closed', { threadId: 'k' });
  assert.deepEqual(r.published.at(-1), ['t', { shells: 0, agents: 0 }]);
});

test('an app-server without the list method is not asked again until the next one runs', async () => {
  const r = rig();
  r.w.observe('turn/completed', { threadId: 't' });
  r.reads.shift()!.reject(Object.assign(new Error('method not found'), { code: -32601 }));
  await tick();
  r.w.observe('turn/completed', { threadId: 't' });
  assert.equal(r.reads.length, 0);
  assert.deepEqual(r.published, []);
  r.w.clear();
  r.w.observe('turn/completed', { threadId: 't' });
  assert.equal(r.reads.length, 1, 'a restarted app-server may have it');
});
