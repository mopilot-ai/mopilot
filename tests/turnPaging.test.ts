// Paging a chat's history in the store (src/store/turnPages.ts, loadOlderTurns): which harnesses page older turns,
// one turn under two ids shown once, and older pages kept ahead of a re-read latest page.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';
import { deferred } from './support/async-scenarios.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { noteOwner } = await import('../src/harness/ownership.ts');
const { olderPagesKept } = await import('../src/store/turnPages.ts');
const { claudeTurnKey } = await import('../src/harness/claudeTranslate.ts');
const U = '11111111-1111-1111-1111-111111111111';

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
});

test('a Claude Code chat pages back through its harness; one turn shown live and read back is shown once', async () => {
  noteOwner('claude:o', 'claude');
  set({ runtime: { 'claude:o': { olderCursor: 'h-c', turns: [{ id: `ct-${U}` }, { id: 'h-c' }] } as any } });
  impl['claudeHistory.loadOlderClaudeTurns'] = async () => ({ turns: [{ id: 'h-0' }, { id: `h-${U}` }], nextCursor: 'h-0' });
  await S.loadOlderTurns('claude:o');
  assert.deepEqual(callsOf('claudeHistory.loadOlderClaudeTurns'), [['claude:o', 'h-c']]);
  assert.deepEqual(
    st().runtime['claude:o'].turns.map((t) => t.id),
    ['h-0', `ct-${U}`, 'h-c'],
  );
  assert.equal(st().runtime['claude:o'].olderCursor, 'h-0');
  assert.equal(callsOf('api.threadTurns').length, 0);
});

test('a basic harness pages back through main; a Claude page for a cursor that moved or failed changes nothing', async () => {
  noteOwner('acp:kimi:a', 'acp');
  noteOwner('claude:p', 'claude');
  set({
    runtime: {
      'acp:kimi:a': { olderCursor: 'c', turns: [] } as any,
      'claude:p': { olderCursor: 'h-c', turns: [{ id: 'h-c' }] } as any,
    },
  });
  impl['acp.loadOlderAcpTurns'] = async () => ({ turns: [{ id: 'at-0' }], nextCursor: null });
  await S.loadOlderTurns('acp:kimi:a');
  assert.deepEqual(callsOf('acp.loadOlderAcpTurns'), [['acp:kimi:a', 'c']]);
  assert.equal(st().runtime['acp:kimi:a'].olderCursor, null);
  // the chat was re-read meanwhile (another app wrote it): paging starts over from that read
  const page = deferred<any>();
  impl['claudeHistory.loadOlderClaudeTurns'] = () => page.promise;
  const load = S.loadOlderTurns('claude:p');
  S.patchRuntime('claude:p', () => ({ olderCursor: 'h-fresh' }));
  page.resolve({ turns: [{ id: 'h-0' }], nextCursor: null });
  await load;
  assert.deepEqual(
    st().runtime['claude:p'].turns.map((t) => t.id),
    ['h-c'],
  );
  assert.equal(st().runtime['claude:p'].olderCursor, 'h-fresh');
  // a failed read leaves what is shown, and the next request reads again
  impl['claudeHistory.loadOlderClaudeTurns'] = async () => {
    throw new Error('transcript unreadable');
  };
  await assert.rejects(S.loadOlderTurns('claude:p'), /transcript unreadable/);
  assert.equal(st().runtime['claude:p'].olderCursor, 'h-fresh');
  impl['claudeHistory.loadOlderClaudeTurns'] = async () => ({ turns: [{ id: 'h-0' }], nextCursor: null });
  await S.loadOlderTurns('claude:p');
  assert.deepEqual(
    st().runtime['claude:p'].turns.map((t) => t.id),
    ['h-0', 'h-c'],
  );
});

test('olderPagesKept: older pages stay ahead of a latest page that starts among what is shown, else paging starts over', () => {
  const t = (...ids: string[]) => ids.map((id) => ({ id })) as any[];
  const shown = t('o1', 'o2', 'p3', 'p4');
  assert.deepEqual(olderPagesKept(shown, 'o1', t('p3', 'p4', 'p5'), 'p3'), { before: t('o1', 'o2'), olderCursor: 'o1' });
  // the page starts where what is shown starts, or past all of it: nothing older is kept
  assert.deepEqual(olderPagesKept(shown, 'o1', t('o1', 'o2'), null), { before: [], olderCursor: null });
  assert.deepEqual(olderPagesKept(shown, 'o1', t('n1', 'n2'), 'n1'), { before: [], olderCursor: 'n1' });
  assert.deepEqual(olderPagesKept(shown, 'o1', [], null), { before: [], olderCursor: null });
  // a Claude prompt shown under its live id is the same turn as read back
  const live = t('h-o', `ct-${U}`);
  assert.deepEqual(olderPagesKept(live, 'h-o', t(`h-${U}`), 'h-x', claudeTurnKey), { before: t('h-o'), olderCursor: 'h-o' });
  assert.deepEqual(olderPagesKept(live, 'h-o', t(`h-${U}`), 'h-x'), { before: [], olderCursor: 'h-x' });
});

const { chatTurnIndex, turnsAboveAfterPage, turnsAboveAfterSwitch } = await import('../src/store/turnPages.ts');
const { taskSourceAt } = await import('../src/store/chatFamily.ts');
const { labelAt } = await import('../src/session/transcript.ts');
const shown = (...ids: string[]) => ids.map((id) => ({ id })) as any[];

test('a switch records the turns above a paged window, and only then', () => {
  // main's segment starts at 800, the window holds two turns of it and a message still on its way
  assert.deepEqual(turnsAboveAfterSwitch({ turns: shown('a', 'b', 'pending-x'), olderCursor: 'c' }, 800), { turnsAbove: 798 });
  // a window with every turn has nothing above it
  assert.deepEqual(turnsAboveAfterSwitch({ turns: shown('a'), olderCursor: null }, 1), {});
  // a second switch adds turns below the window: what is above stays
  assert.deepEqual(turnsAboveAfterSwitch({ turns: shown('a'), olderCursor: 'c', turnsAbove: 5 }, 900), {});
  // main read fewer turns than are shown: never below none
  assert.deepEqual(turnsAboveAfterSwitch({ turns: shown('a', 'b'), olderCursor: 'c' }, 1), { turnsAbove: 0 });
});

test('older pages shrink what is above, down to none when paging ends; an unswitched chat records nothing', () => {
  const window = { turns: shown('a', 'b'), turnsAbove: 100 };
  assert.deepEqual(turnsAboveAfterPage(window, 32, 'next'), { turnsAbove: 70 });
  assert.deepEqual(turnsAboveAfterPage(window, 32, null), { turnsAbove: 0 });
  assert.deepEqual(turnsAboveAfterPage({ ...window, turnsAbove: 10 }, 32, 'next'), { turnsAbove: 0 });
  assert.deepEqual(turnsAboveAfterPage({ turns: shown('a') }, 31, 'next'), {});
  assert.equal(chatTurnIndex(null, 3), 3);
  assert.equal(chatTurnIndex({ turnsAbove: 10 }, 3), 13);
});

const switchedSegments = [
  { harness: 'codex', nativeId: 'chat', start: 0, count: 800, model: null, handoff: null },
  { harness: 'claude', nativeId: `claude:${U}`, start: 800, count: null, model: null, handoff: null },
] as any[];

test("a paged chat after a switch: the switch's event sets the window, new turns are the new harness's, old ones aren't", () => {
  set({
    segments: { chat: switchedSegments },
    runtime: {
      chat: { turns: shown('old-1', 'old-2', 'pending-now'), olderCursor: 'c', checkpoints: {} } as any,
    },
  });
  S.onCodexItem({ kind: 'switched', chatId: 'chat', harness: 'claude', key: `claude:${U}`, model: 'm', fresh: true, start: 800 } as any);
  assert.equal(st().runtime.chat.turnsAbove, 798);
  set((s: any) => ({ runtime: { chat: { ...s.runtime.chat, turns: shown('old-1', 'old-2', 'new-1') } } }));

  // what ran on the earlier harness can't be edited; the message after the switch isn't refused for that
  assert.match(S.editBlockedFor(st(), 'chat', 'old-2'), /earlier harness/);
  assert.doesNotMatch(S.editBlockedFor(st(), 'chat', 'new-1') ?? '', /earlier harness/);

  const above = st().runtime.chat.turnsAbove;
  assert.equal(taskSourceAt('chat', 1, switchedSegments, above).key, 'chat');
  assert.equal(taskSourceAt('chat', 2, switchedSegments, above).key, `claude:${U}`);
  const label = labelAt('chat', switchedSegments, above);
  assert.equal(label(1), 'Codex');
  assert.equal(label(2), 'Claude Code');
});

test('a switched chat pages back through the session its id names, until the window holds every turn', async () => {
  set({
    segments: { [`claude:${U}`]: [{ ...switchedSegments[0], harness: 'claude', nativeId: `claude:${U}` }] },
    runtime: { [`claude:${U}`]: { turns: shown('h-3'), olderCursor: 'c1', turnsAbove: 3 } as any },
  });
  impl['claudeHistory.loadOlderClaudeTurns'] = async () => ({ turns: shown('h-1', 'h-2'), nextCursor: 'c2' });
  await S.loadOlderTurns(`claude:${U}`);
  assert.deepEqual(callsOf('claudeHistory.loadOlderClaudeTurns'), [[`claude:${U}`, 'c1']]);
  assert.equal(st().runtime[`claude:${U}`].turnsAbove, 1);
  impl['claudeHistory.loadOlderClaudeTurns'] = async () => ({ turns: shown('h-0'), nextCursor: null });
  await S.loadOlderTurns(`claude:${U}`);
  assert.equal(st().runtime[`claude:${U}`].turnsAbove, 0);
  assert.equal(st().runtime[`claude:${U}`].olderCursor, null);
  assert.deepEqual(
    st().runtime[`claude:${U}`].turns.map((t: any) => t.id),
    ['h-0', 'h-1', 'h-2', 'h-3'],
  );
});
