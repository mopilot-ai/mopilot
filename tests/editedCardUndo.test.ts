// The Edited card's Undo and Redo (src/components/thread/view/TurnCards.tsx): the state lives on the turn, so the
// Changes panel follows the disk (#1939), and the patch never touches a file outside the chat's folder.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, one } from './support/shell-panels-kit.ts';
import { createElement, act } from 'react';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ threads: {}, runtime: {} });
const marks: unknown[][] = [];
stubStore({ ...store.exports, sendMessage: async () => true, markTurnUndone: (...args: unknown[]) => marks.push(args) });
// the plan and review cards beside it are not under test here
mock.module('../src/components/thread/PlanCard.tsx', { namedExports: { PlanCard: () => null } });
mock.module('../src/components/thread/ReviewCard.tsx', { namedExports: { ReviewCard: () => null } });
mock.module('../src/store/session/useSession.ts', {
  namedExports: { flushSessionPatches: () => {}, sessionOf: () => ({}), setSession: async () => {} },
});
const patches: [string, string, boolean][] = [];
const result = { ok: true, stderr: '' };
installNativeStub({
  git: {
    applyPatch: async (cwd: string, patch: string, reverse: boolean) => {
      patches.push([cwd, patch, reverse]);
      return result;
    },
  },
});
const { EditedCard } = await import('../src/components/thread/view/TurnCards.tsx');
const { turnDiffFiles } = await import('../src/lib/turnDiff.ts');

const plan = '/Users/me/Library/Application Support/MoPilot Code/claude-accounts/a1/plans/p.md';
const edit = (path: string) => ({
  id: path,
  type: 'fileChange',
  status: 'completed',
  changes: [{ path, kind: { type: 'add' }, diff: 'hello audit\n' }],
});
const items = [edit('/repo/notes.txt'), edit(plan)] as any[];
const baseTurn = { id: 'h-1', items, status: 'completed' } as any;
const card = (turn: any) =>
  createElement(EditedCard, { threadId: 'c1', turn, items, files: turnDiffFiles({ items }, '/repo'), cwd: '/repo' });

test("Undo reverts only the folder's files and marks the turn undone; Redo restores it (#1939)", async () => {
  const r = await render(card(baseTurn));
  assert.match(one(r.host, '.edited-title').textContent!, /Edited 1 file/);
  await act(async () => one(r.host, '.edited-actions .btn-pill.ghost', 'Undo').click());
  assert.equal(patches.length, 1);
  const [cwd, patch, reverse] = patches[0];
  assert.equal(cwd, '/repo');
  assert.equal(reverse, true);
  assert.match(patch, /notes\.txt/);
  assert.doesNotMatch(patch, /plans\/p\.md/, "the agent's plan file is never deleted by Undo");
  assert.deepEqual(marks.at(-1), ['c1', 'h-1', true]);
  // the store's turn now says undone: the card reads it from there, with Redo
  await r.rerender(card({ ...baseTurn, undone: true }));
  assert.match(one(r.host, '.edited-title').textContent!, /Undid changes to 1 file/);
  await act(async () => one(r.host, '.edited-actions .btn-pill.ghost', 'Redo').click());
  assert.equal(patches.at(-1)![2], false);
  assert.deepEqual(marks.at(-1), ['c1', 'h-1', false]);
  await r.unmount();
});

test('a patch that fails leaves the turn as it was', async () => {
  result.ok = false;
  result.stderr = 'error: patch failed';
  marks.length = 0;
  const r = await render(card(baseTurn));
  await act(async () => one(r.host, '.edited-actions .btn-pill.ghost', 'Undo').click());
  assert.equal(marks.length, 0);
  assert.deepEqual(store.calls.at(-1), ['toast', "Couldn't undo: error: patch failed", 'error']);
  await r.unmount();
});
