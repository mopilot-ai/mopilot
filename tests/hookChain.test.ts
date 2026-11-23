// electron/session/hookChain.cjs: services added to one ChatController hook all run, and the hook already there keeps
// what it reported (a Stop whose pause can't be saved, a peer receipt failure) instead of being replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { addHook, addGuard } = require('../electron/session/hookChain.cjs');

test('addHook with no hook there runs the added one and returns its result', () => {
  const target: any = {};
  addHook(target, 'onStopped', (id: string) => `stopped ${id}`);
  assert.equal(target.onStopped('a'), 'stopped a');
});

test('addHook runs both in order, keeps the earlier result, and a later one never replaces the earlier', () => {
  const calls: string[] = [];
  const target: any = { onFinished: (e: any) => (calls.push(`ledger ${e.chatId}`), 'ledger') };
  addHook(target, 'onFinished', (e: any) => calls.push(`peer ${e.chatId}`));
  addHook(target, 'onFinished', (e: any) => calls.push(`orchestration ${e.chatId}`));
  assert.equal(target.onFinished({ chatId: 'c' }), 'ledger');
  assert.deepEqual(calls, ['ledger c', 'peer c', 'orchestration c']);
});

test('addHook: a throw from either still runs the other, then the first error is thrown', () => {
  const calls: string[] = [];
  const target: any = {
    onStopped: () => {
      calls.push('earlier');
      throw new Error('pause not saved');
    },
  };
  addHook(target, 'onStopped', () => {
    calls.push('added');
    throw new Error('second');
  });
  assert.throws(() => target.onStopped('x'), /pause not saved/);
  assert.deepEqual(calls, ['earlier', 'added']);
  const only: any = { onStopped: () => calls.push('fine') };
  addHook(only, 'onStopped', () => {
    throw new Error('added failed');
  });
  assert.throws(() => only.onStopped('x'), /added failed/);
});

test('addHook: when either returns a promise the result is a promise of the earlier value, rejecting with either', async () => {
  const target: any = { onFinished: async () => 'earlier' };
  addHook(target, 'onFinished', () => undefined);
  assert.equal(await target.onFinished({}), 'earlier');
  const late: any = { onFinished: () => 'sync' };
  addHook(late, 'onFinished', async () => {
    throw new Error('journal write failed');
  });
  await assert.rejects(late.onFinished({}), /journal write failed/);
  const ignored: any = { onFinished: 'not a function' };
  addHook(ignored, 'onFinished', async () => 'only');
  assert.equal(await ignored.onFinished({}), 'only');
});

test('addGuard runs the earlier step first and the added one only after it succeeded; a failure of either fails', async () => {
  const calls: string[] = [];
  const target: any = {
    beforeDispatch: async (e: any) => {
      calls.push(`peer ${e.id}`);
      if (e.block) throw new Error('blocked');
      return 'peer result';
    },
  };
  addGuard(target, 'beforeDispatch', (e: any) => {
    calls.push(`added ${e.id}`);
    if (e.fail) throw new Error('added failed');
  });
  assert.equal(await target.beforeDispatch({ id: 1 }), 'peer result');
  await assert.rejects(target.beforeDispatch({ id: 2, block: true }), /blocked/);
  await assert.rejects(target.beforeDispatch({ id: 3, fail: true }), /added failed/);
  assert.deepEqual(calls, ['peer 1', 'added 1', 'peer 2', 'peer 3', 'added 3']);
  const bare: any = {};
  addGuard(bare, 'onDispatchResult', () => calls.push('bare'));
  assert.equal(await bare.onDispatchResult({}), undefined);
  assert.equal(calls.at(-1), 'bare');
});

test('addHook: when one throws, the other’s rejected promise is noted instead of left unhandled', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const target: any = {
      onFinished: () => {
        throw new Error('ledger failed');
      },
    };
    addHook(target, 'onFinished', async () => {
      throw new Error('journal failed');
    });
    addHook(target, 'onFinished', () => 'sync value');
    assert.throws(() => target.onFinished({}), /ledger failed/);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
