// Follow ownership serializes cleanup and replacement even after a failed request.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followRequest } from '../mobile/src/presentation/follow';
import type { MobileRuntime } from '../mobile/src/contracts';
test('unfollow completes before a replacement follow and failures do not block retry', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const runtime = {
    snapshot: () => ({ selectedPair: 'p' }),
    request: async (method: string) => {
      calls.push(method);
      if (method === 'chat.unfollow')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (method === 'chat.follow' && calls.length === 1) throw new Error('offline');
    },
  } as unknown as MobileRuntime;
  await assert.rejects(followRequest(runtime, 'chat', 'chat.follow'));
  const old = followRequest(runtime, 'chat', 'chat.unfollow');
  const next = followRequest(runtime, 'chat', 'chat.follow');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['chat.follow', 'chat.unfollow']);
  release();
  await old;
  await next;
  assert.deepEqual(calls, ['chat.follow', 'chat.unfollow', 'chat.follow']);
});

test('retired queued work cannot follow a different computer', async () => {
  let pair = 'one';
  let release!: () => void;
  const calls: string[] = [];
  const runtime = {
    snapshot: () => ({ selectedPair: pair }),
    request: async (method: string) => {
      calls.push(method);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  } as unknown as MobileRuntime;
  const first = followRequest(runtime, 'chat', 'chat.follow');
  await new Promise((resolve) => setImmediate(resolve));
  const second = followRequest(runtime, 'chat', 'chat.unfollow');
  pair = 'two';
  release();
  await first;
  await assert.rejects(second, /computer changed/);
  assert.deepEqual(calls, ['chat.follow']);
});

test('same computer reconnect retires queued work', async () => {
  let generation = 1;
  let release!: () => void;
  const calls: string[] = [];
  const runtime = {
    snapshot: () => ({ selectedPair: 'one', generation }),
    request: async (method: string) => {
      calls.push(method);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  } as unknown as MobileRuntime;
  const first = followRequest(runtime, 'chat', 'chat.follow');
  await new Promise((resolve) => setImmediate(resolve));
  const second = followRequest(runtime, 'chat', 'chat.unfollow');
  generation++;
  release();
  await first;
  await assert.rejects(second, /computer changed/);
  assert.deepEqual(calls, ['chat.follow']);
});
