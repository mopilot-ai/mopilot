// One owner names a Claude Code session (#1932): only electron/harness/claude/rename.cjs calls the SDK's renameSession, which alone
// leaves the name where the SDK no longer reads it once a transcript passes 128 KB; the owner also writes custom-title.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const ROOTS = ['src', 'electron', 'shared'];
const EXT = /\.(ts|tsx|js|cjs|mjs)$/;
const OWNER = 'electron/harness/claude/rename.cjs';
// a read of the SDK's member, called or destructured
const SDK_RENAME = /\.\s*renameSession\b|\{[^}]*\brenameSession\b[^}]*\}\s*=/;

test('only the rename owner calls the Agent SDK renameSession', () => {
  assert.ok(SDK_RENAME.test("ipcMain.handle('claude:rename', async (_e, id, t) => (await state.sdk()).renameSession(id, t));"));
  assert.ok(SDK_RENAME.test('const { renameSession } = await state.sdk();'));
  assert.ok(!SDK_RENAME.test("rename: rpc('renameSession'),"));
  assert.ok(!SDK_RENAME.test('rename: (sessionId, name) => renameSession(sessionId, name),'));
  // the whole file, so a destructuring Biome wraps over several lines is seen too
  assert.ok(SDK_RENAME.test('const {\n  forkSession,\n  renameSession,\n} = await state.sdk();'));
  const hits = ROOTS.flatMap((r) => treeFiles(r, EXT))
    .filter((f) => f !== OWNER)
    .flatMap((f) => {
      const text = stripComments(fs.readFileSync(f, 'utf8'));
      const at = text.search(SDK_RENAME);
      return at < 0 ? [] : [`${f}:${text.slice(0, at).split('\n').length}`];
    });
  assert.deepEqual(hits, []);
  assert.match(fs.readFileSync(OWNER, 'utf8'), SDK_RENAME);
});
