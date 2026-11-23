// Native fork IPC preserves whole-chat and end-of-turn cuts, SDK return values and exact failure propagation through the fork owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, load } from './support/electron-claude.ts';

test('native fork IPC skips transcript reads for whole chats and cuts through the selected turn', async () => {
  const t = load();
  const calls: unknown[] = [];
  const result = { sessionId: 'new-native' };
  fakes.sdk.forkSession = async (...args: unknown[]) => (calls.push(args), result);
  fakes.sdk.getSessionMessages = async (id: string) => {
    calls.push(['read', id]);
    return [
      { type: 'user', uuid: 'prompt', message: { content: 'first' } },
      { type: 'assistant', uuid: 'answer' },
      { type: 'user', uuid: 'next', message: { content: 'second' } },
    ];
  };
  assert.equal(await t.call('claude:fork', 'parent'), result);
  assert.deepEqual(calls, [['parent', undefined]]);
  calls.length = 0;
  assert.equal(await t.call('claude:fork', 'parent', 'prompt'), result);
  assert.deepEqual(calls, [
    ['read', 'parent'],
    ['parent', { upToMessageId: 'answer' }],
  ]);
  calls.length = 0;
  assert.equal(await t.call('claude:fork', 'parent', 'missing'), result);
  assert.deepEqual(calls, [
    ['read', 'parent'],
    ['parent', undefined],
  ]);
});

test('native fork IPC propagates transcript and fork failures without retrying or falling back to a whole fork', async () => {
  const t = load();
  const readError = new Error('native transcript unreadable');
  let forks = 0;
  fakes.sdk.forkSession = async () => void forks++;
  fakes.sdk.getSessionMessages = async () => {
    throw readError;
  };
  await assert.rejects(t.call('claude:fork', 'parent', 'prompt'), (error) => error === readError);
  assert.equal(forks, 0);
  const forkError = new Error('native fork refused');
  fakes.sdk.forkSession = async () => {
    forks++;
    throw forkError;
  };
  await assert.rejects(t.call('claude:fork', 'parent'), (error) => error === forkError);
  assert.equal(forks, 1);
});
