// src/store/turnDiffs.ts: a Claude Code or ACP turn's diff from main lands on the turn whatever the window calls it, and
// never makes up a turn.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, flush, listeners, bootImpls, impl } from './support/store-harness.ts';
import { turnDiffFiles } from '../src/lib/turnDiff.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const { markTurnUndone } = await import('../src/store/turnDiffs.ts');
const st = () => store.useStore.getState();
const set = store.useStore.setState;
const diff = (chatId: string, turnId: string, patch: string | null) => listeners['session.onTurnDiff']({ chatId, turnId, diff: patch });
const patch = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;

before(async () => {
  bootImpls();
  await store.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

const turn = (id: string, items: any[] = []) => ({ id, status: 'inProgress', items, error: null }) as any;
const runtime = (turns: any[]) => ({ turns, activeTurnId: turns.at(-1)?.id ?? null, loaded: true }) as any;

test("main's diff replaces a turn's edit items, under the name the window knows it by", () => {
  // the turn's only file change item is the Edit tool's; a script wrote the other file
  const edit = {
    type: 'fileChange',
    id: 'e',
    status: 'completed',
    changes: [{ path: 'kept.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }],
  };
  set({ runtime: { cl1: runtime([turn('h-old'), turn('ct-p1', [edit])]), acp1: runtime([turn('pending-p2')]) } } as any);
  assert.deepEqual(
    turnDiffFiles(st().runtime.cl1.turns[1]).map((f) => f.path),
    ['kept.ts'],
  );
  diff('cl1', 'ct-p1', patch('kept.ts') + patch('script.ts'));
  assert.deepEqual(
    turnDiffFiles(st().runtime.cl1.turns[1]).map((f) => f.path),
    ['kept.ts', 'script.ts'],
  );
  assert.equal(st().runtime.cl1.turns[0].diff, undefined);
  // a window still showing the turn as pending, and a turn read back (h-) with the live id
  diff('acp1', 'at-p2', patch('a.ts'));
  assert.equal(st().runtime.acp1.turns[0].diff, patch('a.ts'));
  diff('cl1', 'ct-old', '');
  assert.equal(st().runtime.cl1.turns[0].diff, '');
});

test('a diff for a turn or chat the window does not show changes nothing', () => {
  set({ runtime: { cl1: runtime([turn('ct-p1')]) } } as any);
  const before = st().runtime;
  diff('cl1', 'ct-gone', patch('x.ts'));
  diff('nobody', 'ct-p1', patch('x.ts'));
  assert.equal(st().runtime, before);
  assert.equal(st().runtime.nobody, undefined);
});

test('a live diff main takes back leaves the turn to its items again', () => {
  set({ runtime: { cl1: runtime([turn('ct-p1')]) } } as any);
  diff('cl1', 'ct-p1', patch('a.ts'));
  diff('cl1', 'ct-p1', null);
  assert.equal(st().runtime.cl1.turns[0].diff, undefined);
});

test("Undo and Redo on a turn mark it undone and back, leaving the chat's other turns and chats alone (#1939)", () => {
  set({ runtime: { cl1: runtime([turn('h-a'), turn('h-b')]), cl2: runtime([turn('h-a')]) } } as any);
  markTurnUndone('cl1', 'h-b', true);
  assert.deepEqual(
    st().runtime.cl1.turns.map((t: any) => t.undone),
    [undefined, true],
  );
  assert.equal(st().runtime.cl2.turns[0].undone, undefined);
  // the card that undid it may know the turn by its live name (ct-), the chat by its read-back one (h-)
  markTurnUndone('cl1', 'ct-b', false);
  assert.equal(st().runtime.cl1.turns[1].undone, false);
});
