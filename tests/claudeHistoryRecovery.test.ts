// A Claude history page cannot overwrite text that streamed during its final session-state await.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset } from './support/harness-logic-fakes.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { pageBytes } from './support/claude-translate.ts';

const { openLatestClaudeTurns } = await import('../src/session/harness/claude/history.ts');
const ID = 'claude:history-recovery';
const tail = (text: string) => ({ id: 'ct-live', status: 'inProgress', items: [{ type: 'agentMessage', id: 'm', text }] });
beforeEach(() => reset());

test('earlier Claude prompts return without replacing live text received during the final session snapshot', async () => {
  const finalState = deferred();
  const state = { turn: 'running', runningElsewhere: false };
  let snapshots = 0;
  let reads = 0;
  fx.native.session = { snapshot: () => (++snapshots === 2 ? finalState.promise : Promise.resolve(state)) };
  const older = { id: 'h-old', status: 'completed', items: [{ type: 'userMessage', id: 'old-prompt', content: [] }] };
  fx.native.claude = {
    turns: async () => pageBytes({ turns: [older, tail(++reads === 1 ? 'Hel' : 'Hello')], olderCursor: null, closedTail: null }),
  };
  fx.state.runtime[ID] = { turns: [tail('Hel')] };
  const opening = openLatestClaudeTurns(ID, () => {});
  await tick();
  fx.state.runtime[ID].turns = [tail('Hello')];
  finalState.resolve(state);
  await opening;
  assert.deepEqual(
    fx.state.runtime[ID].turns.map((t: any) => t.id),
    ['h-old', 'ct-live'],
  );
  assert.equal(fx.state.runtime[ID].turns[1].items[0].text, 'Hello');
  assert.equal(fx.state.runtime[ID].loaded, true);
  assert.equal(fx.state.runtime[ID].loading, false);
});

test('a partial live turn containing a steered prompt cannot replace its original stored conversation', async () => {
  const user = (id: string, text: string, clientId: string | null = null) => ({
    type: 'userMessage',
    id,
    clientId,
    content: [{ type: 'text', text }],
  });
  const original = user('original', 'Original user request');
  const reply = { type: 'agentMessage', id: 'reply', text: 'Earlier assistant reply' };
  const steer = user('steer', 'A follow-up while working');
  fx.native.session = { snapshot: async () => ({ turn: 'running', runningElsewhere: false }) };
  fx.native.claude = {
    turns: async () =>
      pageBytes({ turns: [{ id: 'ct-live', status: 'inProgress', items: [original, reply, steer] }], olderCursor: null, closedTail: null }),
  };
  fx.state.runtime[ID] = {
    turns: [{ id: 'ct-live', status: 'inProgress', items: [user('local-steer', 'A follow-up while working', 'steer')] }],
  };
  await openLatestClaudeTurns(ID, () => {});
  assert.deepEqual(fx.state.runtime[ID].turns[0].items, [original, reply, steer]);
});
