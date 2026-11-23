// The note and warning when a chat's model changes (src/store/chats.ts modelChangeNote): a window is warned about only
// when a harness reported it while that model ran (or the id names it), never guessed.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const chats = await import('../src/store/chats.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;

beforeEach(() => {
  resetState();
  resetAll();
});

const warned = () => st().toasts.map((t: any) => t.text);
const OVER = (label: string, window: string) => `This chat is over ${label}'s ${window} window. Compacting first`;
/** The chat runs on one Claude session of its own, so its reports are the current segment's. */
const own = (chatId: string) => set({ segments: { ...st().segments, [chatId]: [{ nativeId: chatId, harness: 'claude' }] } as any });
/** A usage report as a harness sends it: `from` names the native session that reported. */
const report = (chatId: string, inputTokens: number, window?: number, from = chatId) =>
  S.applyNotification('thread/tokenUsage/updated', {
    threadId: chatId,
    tokenUsage: { last: { inputTokens }, modelContextWindow: window ?? null },
    tokenUsageSource: { harness: 'claude', nativeId: from },
  } as any);

test('a model change is noted, with no claim about a window nobody reported', () => {
  own('c1');
  assert.equal(S.modelChangeNote('c1', null, 'X'), null);
  assert.equal(S.modelChangeNote('c1', 'a1', 'A1'), null);
  assert.equal(S.modelChangeNote('c1', 'a1', 'A1'), null);
  // 300k held, but no turn has reported any model's window: never "over 200k" for a model that may have 1M
  report('c1', 300_000);
  assert.deepEqual(S.modelChangeNote('c1', 'b1', 'B1'), { kind: 'model', text: 'Model changed to B1' });
  assert.deepEqual(warned(), []);
  // the chat's settings count as its last model
  set({ runtime: { n1: { settings: { model: 'old' } } as any } });
  assert.deepEqual(S.modelChangeNote('n1', 'new1', 'New'), { kind: 'model', text: 'Model changed to New' });
  chats.setLastModel('z1', 'zz1');
  assert.equal(S.modelChangeNote('z1', 'zz1', 'ZZ'), null);
});

test('a window is the window of the model running when it was reported', () => {
  own('c2');
  S.modelChangeNote('c2', 'a2', 'A2');
  S.modelChangeNote('c2', 'b2', 'B2');
  report('c2', 300_000, 200_000);
  // C2 never ran: it has no window to be over; B2 reported 200k
  S.modelChangeNote('c2', 'c2', 'C2');
  assert.deepEqual(warned(), []);
  S.modelChangeNote('c2', 'b2', 'B2');
  assert.deepEqual(warned(), [OVER('B2', '200k')]);
  // a send from another window moves the note but not the warning
  S.modelChangeNote('c2', 'c2', 'C2');
  S.modelChangeNote('c2', 'b2', 'B2', false);
  assert.equal(warned().length, 1);
});

test('a turn that failed before reporting leaves the model without a window', () => {
  own('c3');
  S.modelChangeNote('c3', 'a3', 'A3');
  report('c3', 300_000, 200_000);
  // B3's turn failed with no report, and so did C3's: A3's window is not theirs
  S.modelChangeNote('c3', 'b3', 'B3');
  S.modelChangeNote('c3', 'c3', 'C3');
  S.modelChangeNote('c3', 'b3', 'B3');
  assert.deepEqual(warned(), []);
});

test("a replaced harness's report is neither this chat's context nor a model's window", () => {
  own('c4');
  S.modelChangeNote('c4', 'a4', 'A4');
  // another native session of the chat (the segment before a switch) reports late
  report('c4', 1_200_000, 100, 'old-native');
  S.modelChangeNote('c4', 'x4[1m]', 'X4 1M');
  assert.deepEqual(warned(), [], 'its 1.2M is not what this chat holds');
  // the current segment holds 300k: A4's window would be 100 had the late report been kept
  report('c4', 300_000);
  S.modelChangeNote('c4', 'b4', 'B4');
  S.modelChangeNote('c4', 'a4', 'A4');
  assert.deepEqual(warned(), []);
});

test('an id that names its window is warned about at that window, once the chat holds more', () => {
  own('c5');
  S.modelChangeNote('c5', 'a5', 'A5');
  report('c5', 1_200_000);
  S.modelChangeNote('c5', 'x5[1m]', 'X5 1M');
  assert.deepEqual(warned(), [OVER('X5 1M', '1M')]);
  S.modelChangeNote('c5', 'y5[1m]', 'Y5 1M', false);
  assert.equal(warned().length, 1);
  // a chat with no report yet holds nothing
  set({ runtime: { k5: { settings: { model: 'old' } } as any } });
  S.modelChangeNote('k5', 'z5[1m]', 'Z5 1M');
  assert.equal(warned().length, 1);
});

test('a window reported while no model is known to run is kept for no one', () => {
  own('c6');
  report('c6', 300_000, 200_000);
  assert.equal(S.modelChangeNote('c6', 'a6', 'A6'), null);
  chats.noteReportedWindow('c6', 0);
  chats.noteReportedWindow('c6', null);
  assert.equal(S.modelChangeNote('c6', 'b6', 'B6')!.text, 'Model changed to B6');
  assert.deepEqual(warned(), []);
});

test("a chat opened from disk has its settings' model as the one a report is for; a window that is not a size is dropped", () => {
  own('c7');
  set({ runtime: { c7: { settings: { model: 'old7' } } as any } });
  report('c7', 300_000, 200_000);
  chats.noteReportedWindow('c7', -5);
  S.modelChangeNote('c7', 'new7', 'New7');
  S.modelChangeNote('c7', 'old7', 'Old7');
  assert.deepEqual(warned(), [OVER('Old7', '200k')]);
});

test("a removed chat's last model is forgotten once the map outgrows the chat list; a chat not listed yet keeps its own", () => {
  set({ threads: { keep: { id: 'keep' } as any } });
  chats.setLastModel('keep', 'k1');
  chats.setLastModel('gone', 'g1');
  // 'gone' left the list: the first report marks it, the second drops it ('fresh' is listed by then)
  chats.setLastModel('fresh', 'f1');
  set({ threads: { keep: { id: 'keep' } as any, fresh: { id: 'fresh' } as any } });
  chats.setLastModel('keep', 'k1');
  assert.equal(S.modelChangeNote('gone', 'g2', 'G2'), null, 'no stale previous model');
  assert.deepEqual(S.modelChangeNote('keep', 'k2', 'K2'), { kind: 'model', text: 'Model changed to K2' });
  assert.deepEqual(S.modelChangeNote('fresh', 'f2', 'F2'), { kind: 'model', text: 'Model changed to F2' });
});
