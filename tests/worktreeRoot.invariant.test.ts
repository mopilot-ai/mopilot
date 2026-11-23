// #3909: a test that prunes or removes worktrees never works on the real worktree root. One that calls the prune or
// remove code names a temporary or mocked root; an empty root resolves to ~/.mopilot/worktrees on the real Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const SELF = 'worktreeRoot.invariant.test.ts';
const USES = /pruneWorktrees\(|git:worktreePrune|removeWorktree\(/;
const SAFE_ROOT = /mock\.method\(os, 'homedir'|mkdtempSync|\btmp\(|tempRepo\(/;

test('every test that prunes or removes worktrees uses a temporary or mocked root', () => {
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts') && f !== SELF)
    .filter((f) => {
      const src = readFileSync(new URL(f, dir), 'utf8');
      return USES.test(src) && !SAFE_ROOT.test(src);
    });
  assert.deepEqual(offenders, [], 'name a temp or mocked root (never the default folder under the real home)');
});
