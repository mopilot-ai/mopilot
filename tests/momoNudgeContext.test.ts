// What MoMo's next turn learns of its nudges (#2139 P4): the nudge notes it showed in a chat lately (electron/app/momoNudges.cjs recentNudges) reach the turn's <momo-context> block under their own note, as quoted data (shared/momoContext.mjs, contract/context.cjs); a nudge note keeps its why when a window puts it back among the turns (shared/chatNotes.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recentNudges, RECENT_MS, RECENT_MAX } = require('../electron/app/momoNudges.cjs');
const { momoBlock, NUDGES_NOTE } = require('../shared/momoContext.mjs');
const { memoryContextProvider } = require('../electron/momo/contract/context.cjs');
const { withChatNotes } = require('../shared/chatNotes.mjs');

const NOW = Date.UTC(2030, 2, 20, 12);
const note = (at: number, title = 'Renew the lease', text = 'Still on the lease?') => ({
  id: `n${at}`,
  kind: 'nudge',
  text,
  at,
  turnId: null,
  turn: 9,
  nudge: { title },
});

test('recent nudges: the chat’s nudge notes of the last days, at most a few, one quoted line each', () => {
  const notes = [
    note(NOW - RECENT_MS - 1),
    { id: 'x', kind: 'model', text: 'switched', at: NOW },
    { kind: 'nudge', at: NOW },
    ...Array.from({ length: RECENT_MAX + 1 }, (_, i) => note(NOW - i - 1, `Loop ${i}`, `Line "${i}"`)),
  ];
  const lines = recentNudges(notes, NOW);
  assert.equal(lines.length, RECENT_MAX);
  assert.equal(lines.at(-1), '- 2030-03-20 11:59 UTC, about "Loop 5": "Line \\"5\\""');
  assert.deepEqual(recentNudges(undefined, NOW), []);
  assert.deepEqual(recentNudges('x', NOW), []);
});

test('the block carries them under their own note; none, none', () => {
  const block = momoBlock({ facts: [], nudges: ['- one', ' ', 7] });
  assert.ok(block.includes(`${NUDGES_NOTE}\n- one`));
  assert.equal(momoBlock({ nudges: [] }), null);
  assert.ok(!momoBlock({ facts: ['a fact'] }).includes(NUDGES_NOTE));
});

test('the provider asks for the chat’s recent nudges; one that fails gives the turn its memory without them', () => {
  const store = { available: () => true, summary: () => ({ persona: '', aboutYou: '', facts: ['Likes tea'] }) };
  const asked: string[] = [];
  const provider = memoryContextProvider({
    store,
    allowed: () => true,
    isMomoChat: () => true,
    nudges: (id: string) => (asked.push(id), ['- the lease']),
  });
  assert.match(provider('momo-main', { query: '' }), /- the lease/);
  assert.deepEqual(asked, ['momo-main']);
  const failing = memoryContextProvider({
    store,
    allowed: () => true,
    isMomoChat: () => true,
    nudges: () => {
      throw new Error('no record');
    },
  });
  const block = failing('momo-main', { query: '' });
  assert.match(block, /Likes tea/);
  assert.ok(!block.includes(NUDGES_NOTE));
  const none = memoryContextProvider({ store, allowed: () => true, isMomoChat: () => true });
  assert.ok(!none('momo-main', { query: '' }).includes(NUDGES_NOTE));
});

test('a nudge note keeps its why among the turns; other notes as before', () => {
  const turns = [{ id: 't1', items: [{ id: 'a' }] }];
  const why = { loopId: 'L1', title: 'Renew', quote: 'renew', saidAt: 1, trigger: 'due', why: 'due' };
  const [t] = withChatNotes(turns, [
    { id: 'n1', kind: 'nudge', text: 'Lease?', turnId: null, turn: 9, at: 1, nudge: why },
    { id: 'n2', kind: 'model', text: 'm', turnId: null, turn: 9, at: 2 },
  ]);
  assert.deepEqual(t.items[1], { type: 'statusNote', id: 'n1', kind: 'nudge', text: 'Lease?', nudge: why });
  assert.deepEqual(t.items[2], { type: 'statusNote', id: 'n2', kind: 'model', text: 'm' });
});
