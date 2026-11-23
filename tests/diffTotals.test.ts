// One total of added and removed lines for every surface that shows one (src/lib/diff.ts diffTotals): the Changes pane's header, the summary's Branch changes, a turn's edited files; a machine's summary rows (src/lib/hostRepo.ts) total the same lines as the patch the pane parses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTotals, parseUnifiedDiff } from '../src/lib/diff.ts';
import { repoOf } from '../src/lib/hostRepo.ts';

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,3 @@',
  '+1',
  '+2',
  '+3',
  '',
].join('\n');

test('diffTotals adds the lines of every file, and is zero for none', () => {
  assert.deepEqual(diffTotals([]), { added: 0, removed: 0 });
  assert.deepEqual(diffTotals(parseUnifiedDiff(PATCH)), { added: 4, removed: 1 });
});

test('a machine’s summary row totals what the pane’s patch does, new files included', () => {
  const status = {
    isRepo: true as const,
    branch: 'main',
    head: 'h',
    remote: null,
    truncated: false,
    unreadable: false,
    files: [
      { path: 'a.ts', added: 1, removed: 1 },
      { path: 'new.txt', added: 3, removed: 0, untracked: true, counted: true },
    ],
  };
  const row = repoOf(status as never);
  assert.deepEqual({ added: row.added, removed: row.removed }, diffTotals(parseUnifiedDiff(PATCH)));
  assert.equal(row.untracked, 0, 'every new file was counted');
});
