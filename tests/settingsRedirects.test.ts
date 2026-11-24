// Settings pages that moved keep every old link working: Worktrees is a part of the Git page (the sidebar stays at its 21 items), so a link to it, a saved route and a search for a worktree setting all land on Git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV, resolveSection, SIDEBAR_MAX } from '../src/lib/settingsNav.ts';
import { KEYWORDS } from '../src/lib/settingsSearch.ts';

test('a link or saved route to the old Worktrees page opens Git, and the sidebar has no Worktrees item', () => {
  assert.deepEqual(resolveSection('worktrees', undefined), { section: 'git' });
  assert.equal(
    NAV.some((n) => n.id === 'worktrees'),
    false,
  );
  assert.ok(NAV.length <= SIDEBAR_MAX, 'the sidebar cap is not raised');
});

test('the worktree settings are searched under Git, and Connectors keeps its own words', () => {
  const git = KEYWORDS.git;
  for (const word of ['Worktree root', 'Delete old worktrees', 'Delete branch on archive', 'Worktrees to keep', 'Branches'])
    assert.ok(git.includes(word), word);
  assert.equal('worktrees' in KEYWORDS, false);
  assert.ok(KEYWORDS.connectors.includes('Linear'));
});
