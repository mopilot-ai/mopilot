// `git worktree remove` drops a worktree's admin entry even when it could not delete the checkout (a folder Windows still
// holds), so the app runs it only through removeCheckout (electron/platform/worktreeRemoval.cjs), which finishes the delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SOURCE = /\.(?:[cm]?js|tsx?)$/;
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? e.name === 'node_modules'
          ? []
          : files(path.join(dir, e.name))
        : SOURCE.test(e.name)
          ? [path.join(dir, e.name)]
          : [],
    );

test('I: every `git worktree remove` the app runs goes through removeCheckout', () => {
  let seen = 0;
  for (const dir of ['electron', 'host/src', 'shared', 'src'])
    for (const file of files(path.join(ROOT, dir)))
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!/['"]worktree['"],\s*['"]remove['"]/.test(line)) continue;
        seen++;
        assert.match(line, /\bremoveCheckout\(/, `${path.relative(ROOT, file)}: ${line.trim()}`);
      }
  assert.ok(seen >= 2, 'the removals were found');
});
