// The renderer's orchestration snapshot contains public session facts and proposal state, never private bookkeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const { orchestrationView } = createRequire(import.meta.url)('../electron/app/orchestration.cjs');

test('orchestrationView gives windows the links and deliveries without the bookkeeping', () => {
  const view = orchestrationView(
    {
      children: {
        a: {
          parentId: 'p',
          name: 'a',
          title: 'A',
          harness: 'claude',
          useWorktree: 1,
          createdAt: 5,
          driven: ['x'],
          lastReport: { how: 'failed', at: 9 },
        },
        b: { parentId: 'p', name: 'b', title: 'B', driven: [], lastReport: null },
      },
      parents: { p: { notes: [{ body: 'secret' }] } },
      deliveries: { x: { kind: 'brief' } },
      proposals: {
        t1: {
          parentId: 'p',
          kind: 'own_initiative',
          args: { background: BACKGROUND, title: 'Old', prompt: 'x'.repeat(5000) },
          status: 'open',
          expiresAt: 10,
        },
        t2: {
          parentId: 'p',
          kind: 'offer',
          args: { background: BACKGROUND, title: 'New', prompt: 'p' },
          status: 'started',
          expiresAt: 1e15,
          chatId: 'c',
        },
        t3: {
          parentId: 'p',
          kind: 'offer',
          args: { background: BACKGROUND, title: 'Ask', prompt: 'q', useWorktree: false },
          status: 'open',
          expiresAt: 1e15,
          waiting: true,
        },
        t4: {
          parentId: 'p',
          kind: 'offer',
          args: { background: BACKGROUND, title: 'Fork', prompt: 'f', context: 'fork' },
          status: 'open',
          expiresAt: 1e15,
        },
      },
    },
    100,
  );
  assert.deepEqual(view.proposals, {
    t1: {
      parentId: 'p',
      kind: 'own_initiative',
      title: 'Old',
      prompt: 'x'.repeat(4000),
      status: 'expired',
      chatId: null,
      expiresAt: 10,
      waiting: false,
      place: 'worktree',
    },
    t2: {
      parentId: 'p',
      kind: 'offer',
      title: 'New',
      prompt: 'p',
      status: 'started',
      chatId: 'c',
      expiresAt: 1e15,
      waiting: false,
      place: 'worktree',
    },
    // an offer whose call waits for the user: the window finds its card by it while the call runs
    t3: {
      parentId: 'p',
      kind: 'offer',
      title: 'Ask',
      prompt: 'q',
      status: 'open',
      chatId: null,
      expiresAt: 1e15,
      waiting: true,
      place: 'folder',
    },
    t4: {
      parentId: 'p',
      kind: 'offer',
      title: 'Fork',
      prompt: 'f',
      status: 'open',
      chatId: null,
      expiresAt: 1e15,
      waiting: false,
      place: 'fork',
    },
  });
  assert.deepEqual(view.queue, []);
  assert.deepEqual(view.plans, {});
  assert.deepEqual(view.wrapUps, {});
  delete (view as any).proposals;
  delete (view as any).queue;
  delete (view as any).plans;
  delete (view as any).wrapUps;
  // a journal from before sessions waited for others has none
  assert.deepEqual(view.waiting, {});
  delete (view as any).waiting;
  assert.deepEqual(view, {
    children: {
      a: {
        parentId: 'p',
        name: 'a',
        title: 'A',
        worked: null,
        paths: null,
        outside: null,
        harness: 'claude',
        useWorktree: true,
        createdAt: 5,
        lastReport: { how: 'failed', report: null, at: 9 },
        facts: null,
        merged: null,
      },
      b: {
        parentId: 'p',
        name: 'b',
        title: 'B',
        worked: null,
        paths: null,
        outside: null,
        harness: null,
        useWorktree: false,
        createdAt: 0,
        lastReport: null,
        facts: null,
        merged: null,
      },
    },
    deliveries: { x: { kind: 'brief' } },
    families: ['p'],
  });
  assert.deepEqual(
    orchestrationView({
      children: { c: { parentId: 'p', name: 'c', title: 'C', driven: [], lastReport: { how: 'lost', report: 'r' } } },
      parents: {},
      deliveries: {},
    }).children.c.lastReport,
    { how: 'lost', report: 'r', at: 0 },
  );
  // a session's git facts and where the user merged it reach the window as main keeps them
  const facts = { branch: 'k', base: 'main', ahead: 1, files: 1, added: 1, removed: 0, uncommitted: 0, pr: null, at: 1 };
  const kept = orchestrationView({
    children: {
      d: { parentId: 'p', name: 'd', title: 'D', driven: [], lastReport: null, facts, merged: { into: 'main', commit: 'c', at: 2 } },
    },
    parents: {},
    deliveries: {},
  }).children.d;
  assert.deepEqual([kept.facts, kept.merged], [facts, { into: 'main', commit: 'c', at: 2 }]);
  // a journal from before proposals has none
  assert.deepEqual(orchestrationView({ children: {}, parents: {}, deliveries: {} }).proposals, {});
  const boxes = orchestrationView({
    children: {},
    parents: {},
    deliveries: {},
    plans: {
      c: { turn: 't', items: [{ content: 'a', status: 'completed' }], at: 1 },
      // a list from before the user's last message says so
      s: { turn: 't', items: [{ content: 'b', status: 'pending' }], at: 1, stale: true },
    },
    wrapUps: {
      // a recap alone draws no box (it is the session's status), nor does a question without answers
      c: { turn: 't', recap: 'r', actions: [], at: 1 },
      e: { turn: 't', recap: 'r3', ask: 'Go?', actions: [], at: 1 },
      d: { turn: 't', recap: 'r2', ask: 'Go?', actions: [{ label: 'Yes', message: null }], at: 1 },
    },
  });
  assert.deepEqual(boxes.plans, {
    c: { items: [{ content: 'a', status: 'completed' }], stale: false },
    s: { items: [{ content: 'b', status: 'pending' }], stale: true },
  });
  assert.deepEqual(boxes.wrapUps, {
    d: { recap: 'r2', ask: 'Go?', actions: [{ label: 'Yes', message: null }] },
  });
});
