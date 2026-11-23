// Approving a MoMo routine is the user's: only the routine store and the Settings' routines IPC say `approved: true`, and no
// module that registers agent tools approves one (electron/momo/routineStore.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['electron/'];

test('approval is the user’s: no agent tool and no module but the store and Settings’ routines IPC gives it', () => {
  // which files may say `approved: true` to a routine, and why
  // the store itself, and Settings' Approve (its IPC)
  const ALLOWED = new Set(['electron/momo/routineStore.cjs', 'electron/momo/routinesIpc.cjs']);
  const sources = treeFiles('electron', /\.c?js$/);
  const approving = sources.filter((f) => /approved:\s*true/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(
    approving.filter((f) => !ALLOWED.has(f)),
    [],
  );
  // and a module that registers agent tools may read routines, never approve one
  const tools = sources.filter((f) => /\.register\(/.test(fs.readFileSync(f, 'utf8')) && /handler/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(tools.length > 5, `the tool modules were found (${tools.length})`);
  assert.deepEqual(
    tools.filter((f) => /routineStore\.cjs/.test(fs.readFileSync(f, 'utf8')) && /approved/.test(fs.readFileSync(f, 'utf8'))),
    [],
  );
});
