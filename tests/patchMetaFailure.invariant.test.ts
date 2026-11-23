// ChatsStore.patchMeta answers false for a patch that changed nothing as well as for one that could not be saved (it
// documents "Returns whether it changed"), so a caller that raises or gives up on `!patchMeta(...)` reports a no-op as a
// failure (set_session_effort on a chat already at that effort, 2026-11-04). Such a site either saves through
// saveMeta (shared/metaSave.mjs) or states, in a `patchMeta-changes:` comment on the line above, why its patch always changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.cjs') ? [path.join(dir, e.name)] : []));

test('I: no electron code treats a false patchMeta as a failure without saying why its patch always changes', () => {
  let seen = 0;
  for (const file of files(path.join(ROOT, 'electron'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/![ (]*[A-Za-z_.?]*\bpatchMeta\(|\b(?:const|let)\s+\w+\s*=\s*[A-Za-z_.?]*\bpatchMeta\(/.test(line)) return;
      seen++;
      assert.match(
        lines[i - 1] ?? '',
        /patchMeta-changes: \S/,
        `${path.relative(ROOT, file)}:${i + 1} uses !patchMeta(...) with no patchMeta-changes: reason; use saveMeta`,
      );
    });
  }
  assert.ok(seen >= 10, 'the sites were found');
});
