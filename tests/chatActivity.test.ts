// src/lib/chatActivity.ts: a chat's last activity (the sidebar's order) and the store change that records it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityAt, byActivity, isChatOutput, touched, withChatRewinds } from '../src/lib/chatActivity.ts';

test("a chat's activity is the later of its harness's last write and the last activity seen here", () => {
  // Codex moves recencyAt only when the user starts a turn; the agent's output after it moves updatedAt
  assert.equal(activityAt({ updatedAt: 500, recencyAt: 100 }), 500);
  // a turn seen here before the harness's own list caught up
  assert.equal(activityAt({ updatedAt: 100, recencyAt: 500 }), 500);
  assert.equal(activityAt({ updatedAt: 7, recencyAt: null }), 7);
  assert.equal(activityAt({ updatedAt: 7 }), 7);
  const chats = [
    { id: 'sent-to', updatedAt: 10, recencyAt: 300 },
    { id: 'answered', updatedAt: 400, recencyAt: 100 },
    { id: 'idle', updatedAt: 200 },
  ];
  assert.deepEqual(
    chats.sort(byActivity).map((c) => c.id),
    ['answered', 'sent-to', 'idle'],
  );
});

test('an item boundary requires output, excluding synthetic notes and output polling', () => {
  assert.equal(isChatOutput('item/completed'), false);
  assert.equal(isChatOutput('item/completed', 'statusNote'), false);
  assert.equal(isChatOutput('item/updated', 'commandExecution'), false);
  assert.equal(isChatOutput('item/started', 'commandExecution'), true);
  const state = { threads: { chat: { updatedAt: 9, preview: '' } }, threadOrder: ['chat'] };
  assert.equal(touched(state, 'chat', 3).threads?.chat.updatedAt, 9);
});

test('rewind activity decorates only loaded chats with newer activity without changing the original rows', () => {
  const threads = { first: { updatedAt: 2 }, second: { updatedAt: 1, recencyAt: 1 } };
  assert.equal(withChatRewinds(threads), threads);
  assert.equal(withChatRewinds(threads, { first: 2, unloaded: 9, toString: 9 }), threads);
  const shown = withChatRewinds(threads, { first: 3, second: 4 });
  assert.deepEqual(shown, { first: { updatedAt: 2, recencyAt: 3 }, second: { updatedAt: 1, recencyAt: 4 } });
  assert.deepEqual(threads.second, { updatedAt: 1, recencyAt: 1 });
});

test('activity sets both timestamps; only a starting turn leads the list and fills an empty preview', () => {
  const s: {
    threads: Record<string, { updatedAt: number; recencyAt?: number | null; preview: string; ephemeral?: boolean }>;
    threadOrder: string[];
  } = {
    threads: {
      a: { updatedAt: 5, recencyAt: null, preview: '' },
      b: { updatedAt: 9, recencyAt: 9, preview: 'kept' },
      side: { updatedAt: 1, preview: '', ephemeral: true },
    },
    threadOrder: ['b', 'a', 'side'],
  };
  // a turn ending (or an answer) is activity, but doesn't reshuffle which chats the list holds
  const ended = touched(s, 'a', 50);
  assert.deepEqual(ended, { threads: { ...s.threads, a: { updatedAt: 50, recencyAt: 50, preview: '' } } });
  assert.equal('threadOrder' in ended, false);
  // a starting turn: first in the list, named by its message only when the chat has no preview yet
  assert.deepEqual(touched(s, 'a', 60, { text: 'hello' }), {
    threads: { ...s.threads, a: { updatedAt: 60, recencyAt: 60, preview: 'hello' } },
    threadOrder: ['a', 'b', 'side'],
  });
  assert.equal(touched(s, 'b', 60, { text: 'other' }).threads?.b.preview, 'kept');
  // a side chat never joins the sidebar
  const side = touched(s, 'side', 70, { text: 'x' });
  assert.equal(side.threadOrder, s.threadOrder);
  assert.equal(side.threads?.side.recencyAt, 70);
  // a chat this window doesn't hold yet: nothing to stamp, but a starting turn still leads the list
  assert.deepEqual(touched(s, 'gone', 80), {});
  assert.deepEqual(touched(s, 'gone', 80, { text: 'x' }), { threads: s.threads, threadOrder: ['gone', 'b', 'a', 'side'] });
});
