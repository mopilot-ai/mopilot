// What the Conductor import's pages say (src/lib/conductorImport.ts): what is left to bring over, what failed, and the one-line result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counted, failures, importedText, pending, pendingText } from '../src/lib/conductorImport.ts';

const ws = (name: string, adopted = false) => ({ path: `/c/${name}`, name, branch: name, adopted });

test('counts read as a person says them', () => {
  assert.deepEqual(
    [counted(1, 'workspace'), counted(2, 'workspace'), counted(1, 'repository'), counted(0, 'repository')],
    ['1 workspace', '2 workspaces', '1 repository', '0 repositories'],
  );
});

test('only repositories with a workspace still to bring over are pending', () => {
  const found = {
    repos: [
      { repo: '/r/a', name: 'a', workspaces: [ws('x'), ws('y', true)] },
      { repo: '/r/b', name: 'b', workspaces: [ws('z', true)] },
      { repo: '/r/c', name: 'c', workspaces: [ws('p'), ws('q')] },
    ],
    skipped: [],
    truncated: false,
  };
  const repos = pending(found);
  assert.deepEqual(repos, [
    { repo: '/r/a', name: 'a', workspaces: 1 },
    { repo: '/r/c', name: 'c', workspaces: 2 },
  ]);
  assert.equal(pendingText(repos), '3 workspaces in 2 repositories');
  assert.deepEqual(pending(null), []);
});

test('an import says what it brought over and names everything it could not', () => {
  const done = {
    repos: [
      { repo: '/r/a', name: 'a', projectId: 'p1', added: true, workspaces: [{ path: '/c/x', name: 'x', status: 'adopted' as const }] },
      { repo: '/r/b', name: 'b', error: 'not a folder', workspaces: [] },
      {
        repo: '/r/c',
        name: 'c',
        projectId: 'p2',
        workspaces: [
          { path: '/c/p', name: 'p', status: 'failed' as const, error: 'gone' },
          { path: '/c/q', name: 'q', status: 'failed' as const },
          { path: '/c/r', name: 'r', status: 'already' as const },
        ],
      },
    ],
    skipped: [],
    truncated: false,
  };
  assert.deepEqual(failures(done), [
    { path: '/r/b', name: 'b', error: 'not a folder' },
    { path: '/c/p', name: 'c/p', error: 'gone' },
    { path: '/c/q', name: 'c/q', error: 'It could not be opened.' },
  ]);
  assert.equal(importedText(done), 'Imported 1 workspace; 3 could not be imported');
  assert.equal(importedText({ ...done, repos: [done.repos[0]] }), 'Imported 1 workspace');
  assert.equal(importedText({ ...done, repos: [done.repos[1]] }), 'Nothing was imported; 1 could not be imported');
  assert.equal(
    importedText({ ...done, repos: [{ ...done.repos[2], workspaces: [done.repos[2].workspaces[2]] }] }),
    'Everything was already imported',
  );
  // main looked again and what was offered is gone
  assert.equal(importedText({ ...done, repos: [] }), 'Nothing was found to import');
  assert.deepEqual(failures(null), []);
});
