// src/session/harness/acp.ts: a basic chat whose transcript couldn't be read says why, and a read that succeeds later (Retry) takes it away.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset } from './support/harness-logic-fakes.ts';

const acp = await import('../src/session/harness/acp.ts');
const ID = 'acp:kimi:o';
const reply = { turns: [{ id: 't1', status: 'completed', items: [] }], activeTurnId: null };
const read = {
  page: new TextEncoder().encode(JSON.stringify({ turns: reply.turns, olderCursor: null })),
  activeTurnId: reply.activeTurnId,
  diffs: {},
};

beforeEach(() => reset());

test("a read that succeeds after a failed one takes the failed read's error away", async () => {
  fx.native.acp = {
    turns: async () => {
      throw new Error('unreadable');
    },
  };
  await acp.openAcpThread(ID);
  assert.equal(fx.state.runtime[ID].error, 'unreadable');
  assert.equal(fx.state.runtime[ID].errorFromRead, true);
  fx.native.acp = { turns: async () => read };
  await acp.openAcpThread(ID);
  assert.equal(fx.state.runtime[ID].error, null);
  assert.equal(fx.state.runtime[ID].turns.length, 1);
});

test("a read that succeeds leaves an error that isn't a read's", async () => {
  fx.state.runtime[ID] = { turns: [], activeTurnId: null, loaded: true, loading: false, error: 'refused', errorFromRead: false };
  fx.native.acp = { turns: async () => read };
  await acp.openAcpThread(ID);
  assert.equal(fx.state.runtime[ID].error, 'refused');
});
