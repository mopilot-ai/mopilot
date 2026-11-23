// Whole-repository guard (#1939): a turn-scoped Changes surface (the Changes pane and historical turn cards)
// counts a turn through changedFiles, which leaves out edits still awaiting approval, files outside the chat's folder
// and turns undone from their Edited card. Only the Edited card itself reads turnDiffFiles: it keeps an undone turn's
// files to Redo them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const GUARDS = ['src/'];

const ALLOWED = new Map([
  ['src/lib/turnDiff.ts', 'where it is defined'],
  ['src/components/thread/view/TurnView.tsx', "the Edited card keeps an undone turn's files for Redo"],
]);

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

test("only the Edited card reads a turn's raw files; every Changes surface uses changedFiles", () => {
  const readers = [...sources('src')].filter((file) => /\bturnDiffFiles\s*\(/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(
    readers.filter((file) => !ALLOWED.has(file)),
    [],
  );
  assert.ok(readers.includes('src/components/thread/view/TurnView.tsx'), 'the allowlist names a reader that still exists');
});
