// Quota notices reconcile against the actual store across fresh readers, adopted turns and real recovery boundaries.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, impl } from './support/store-harness.ts';
import { ClaudeTranslator, buildTurns } from './support/claude-translate.ts';
import { subagentItems } from './support/claude-translate.ts';
import { coalesceLimitNotes, limitNoteHome } from '../shared/limitNotices.mjs';
import { claudeLimitNotifications } from './fixtures/claude-limit-notifications.mjs';

const { store: S, resetState } = await loadStore();
const { noteOwner } = await import('../src/harness/ownership.ts');
const id = 'claude:quota';
const turns = () => S.useStore.getState().runtime[id].turns;
const notes = () =>
  turns()
    .flatMap((t: any) => t.items)
    .filter((i: any) => i.kind === 'limit');
const translator = () => new ClaudeTranslator(id, '/repo', S.applyNotification);
const error = (uuid: string, text: string) => ({
  type: 'assistant',
  uuid,
  error: 'rate_limit',
  message: { content: [{ type: 'text', text }] },
});
const read = () => buildTurns(claudeLimitNotifications(), id, '/repo');
const show = (value: any[]) => S.useStore.setState({ runtime: { [id]: { turns: value } as any } });

beforeEach(() => {
  resetState();
  resetAll();
});

test('a fresh translator after an idle history reopen updates the prior notice rather than adding another', () => {
  show(read());
  const previous = notes()[0].id;
  const tr = translator();
  tr.onMessage(error('later', 'Latest reset time'));
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].id, previous);
  assert.equal(notes()[0].text, 'Latest reset time');
  assert.equal(turns().length, 4, 'only the genuine new automatic turn opens');
});

test('an early error adopted into a replayed turn never resurrects the retired auto turn', () => {
  show([]);
  const tr = translator();
  tr.onMessage(error('early', 'Early reset'));
  const early = tr.turnId!;
  const history = read();
  const tail = history.at(-1)!;
  tail.items.push(...turns()[0].items);
  tr.turnId = tail.id;
  show(coalesceLimitNotes(history));
  tr.onMessage(error('next', 'New reset'));
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].text, 'New reset');
  assert.ok(turns().every((t: any) => t.id !== early));
});

test('real output or input arriving after the read keeps the newer episode, including a switched harness', () => {
  for (const item of [
    { type: 'agentMessage', id: 'recovered', text: 'Recovered' },
    { type: 'userMessage', id: 'retry', content: [{ type: 'text', text: 'Try again' }] },
  ]) {
    show(read());
    const tail = turns().at(-1)!;
    S.applyNotification('item/completed', { threadId: id, turnId: tail.id, item });
    const tr = translator();
    tr.turnId = tail.id;
    tr.onMessage(error('new-error', 'A new episode'));
    assert.equal(notes().length, 2);
    assert.equal(notes()[1].text, 'A new episode');
  }
});

test('snapshot reconciliation preserves independent episodes and unchanged identities', () => {
  const note = (id: string, text: string) => ({ type: 'statusNote', kind: 'limit', id, text });
  const original = [{ id: 'one', items: [note('first', 'First'), { type: 'statusNote', kind: 'task' }, { type: 'hookPrompt' }] }];
  assert.equal(coalesceLimitNotes(original), original);
  const duplicate = [...original, { id: 'two', items: [note('late', 'Latest')] }];
  const merged = coalesceLimitNotes(duplicate);
  assert.deepEqual(merged[0].items[0], note('first', 'Latest'));
  assert.deepEqual(merged[1].items, []);
  assert.equal((original[0].items[0] as any).text, 'First');
  const recovered = [...duplicate, { id: 'three', items: [{ type: 'agentMessage', text: 'Recovered' }, note('again', 'New limit')] }];
  assert.equal(
    coalesceLimitNotes(recovered)
      .flatMap((t) => t.items)
      .filter((i: any) => i.kind === 'limit').length,
    2,
  );
  assert.equal(limitNoteHome([], 'turn', note('standalone', 'Limit')).turnId, 'turn');
});

test('paging older history reconciles a visible quota note with its historical owner', async () => {
  noteOwner(id, 'claude');
  show([{ id: 'h-new', items: [{ type: 'statusNote', kind: 'limit', id: 'late', text: 'Latest' }] }]);
  S.useStore.setState({ runtime: { [id]: { turns: turns(), olderCursor: 'h-new' } as any } });
  impl['claudeHistory.loadOlderClaudeTurns'] = async () => ({
    turns: [{ id: 'h-old', items: [{ type: 'statusNote', kind: 'limit', id: 'first', text: 'First' }] }],
    nextCursor: null,
  });
  await S.loadOlderTurns(id);
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].id, 'first');
  assert.equal(notes()[0].text, 'Latest');
});

test('account, model and harness changes preserve separate quota owners', () => {
  for (const kind of ['account', 'model', 'switch']) {
    const first = { type: 'statusNote', kind: 'limit', id: 'first', text: 'First login' };
    const next = { type: 'statusNote', kind: 'limit', id: 'next', text: 'Another login' };
    const values = [{ id: 'turn', items: [first, { type: 'statusNote', kind }, next] }];
    assert.equal(coalesceLimitNotes(values), values);
    assert.equal(limitNoteHome([{ id: 'turn', items: [first, { type: 'statusNote', kind }] }], 'turn', next).item.id, 'next');
  }
});

test('a first quota event without a loaded runtime is retained, and sparse paging snapshots keep their identity', () => {
  S.applyNotification('item/completed', {
    threadId: id,
    turnId: 'first',
    item: { type: 'statusNote', kind: 'limit', id: 'new', text: 'Limit' },
  });
  assert.equal(notes().length, 1);
  const sparse = [{ id: 'unloaded' }] as any;
  assert.equal(coalesceLimitNotes(sparse), sparse);
  assert.equal(limitNoteHome(sparse, 'first', { type: 'statusNote', kind: 'limit', id: 'new' }).turnId, 'first');
});

test('upstream errors and nonempty synthetic messages never impersonate successful quota recovery', () => {
  for (const message of [
    {
      type: 'assistant',
      uuid: 'server-error',
      error: 'server_error',
      message: { content: [{ type: 'text', text: 'Provider unavailable' }] },
    },
    { type: 'assistant', uuid: 'synthetic', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Internal status' }] } },
  ]) {
    show(read());
    const tr = translator();
    tr.onMessage(message);
    tr.onMessage(error('later-failure', 'Still limited'));
    assert.equal(notes().length, 1);
    const replay = buildTurns([error('first', 'First limit'), message, error('last', 'Still limited')], id, '/repo');
    assert.equal(replay.flatMap((t) => t.items).filter((i: any) => i.kind === 'limit').length, 1);
    assert.equal(
      (subagentItems([error('first', 'First limit'), message, error('last', 'Still limited')], id, '/repo') as any[]).filter(
        (i) => i.kind === 'limit',
      ).length,
      1,
    );
  }
});
