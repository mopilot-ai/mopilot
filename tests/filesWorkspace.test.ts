// src/lib/filesWorkspace.ts: the Files pane's open files per folder (tabs, the front one with its lines, the tree
// shown or hidden, reveals), kept per window for a bounded number of folders.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render, settle } from './support/shell-panels-kit.ts';
import {
  FILES_WORKSPACES_MAX,
  closeWorkspaceFile,
  filesWorkspace,
  openWorkspaceFile,
  resetFilesWorkspaces,
  revealInFileTree,
  setWorkspaceTree,
  useFilesWorkspace,
} from '../src/lib/filesWorkspace.ts';
import { act } from 'react';

beforeEach(() => resetFilesWorkspaces());

test('a folder starts with nothing open and the tree shown', () => {
  assert.deepEqual(filesWorkspace('/repo'), { open: [], active: null, span: {}, seq: 0, tree: true, reveal: null });
});

test('opening files adds tabs in order and brings an open one to the front at its new lines, each open a new request', () => {
  openWorkspaceFile('/repo', '/repo/a.ts');
  openWorkspaceFile('/repo', '/repo/b.ts', { line: 4 });
  const first = filesWorkspace('/repo').seq;
  openWorkspaceFile('/repo', '/repo/a.ts', { line: 2, endLine: 5 });
  const s = filesWorkspace('/repo');
  assert.deepEqual(s.open, ['/repo/a.ts', '/repo/b.ts']);
  assert.equal(s.active, '/repo/a.ts');
  assert.deepEqual(s.span, { line: 2, endLine: 5 });
  assert.ok(s.seq > first);
  openWorkspaceFile('/repo', '/repo/a.ts', { line: 2, endLine: 5 });
  assert.ok(filesWorkspace('/repo').seq > s.seq, 'the same lines asked again are a new request');
  assert.deepEqual(filesWorkspace('/other').open, [], 'another folder has its own tabs');
});

test('closing the front tab brings the next one forward (the previous for the last), and the tree back once none is open', () => {
  for (const p of ['a', 'b', 'c']) openWorkspaceFile('/r', `/r/${p}`);
  setWorkspaceTree('/r', false);
  openWorkspaceFile('/r', '/r/b', { line: 3 });
  closeWorkspaceFile('/r', '/r/b');
  assert.deepEqual([filesWorkspace('/r').open, filesWorkspace('/r').active], [['/r/a', '/r/c'], '/r/c']);
  assert.deepEqual(filesWorkspace('/r').span, {}, 'the closed file’s lines go with it');
  closeWorkspaceFile('/r', '/r/c');
  assert.equal(filesWorkspace('/r').active, '/r/a');
  openWorkspaceFile('/r', '/r/c', { line: 1 });
  closeWorkspaceFile('/r', '/r/a');
  assert.deepEqual([filesWorkspace('/r').active, filesWorkspace('/r').span], ['/r/c', { line: 1 }], 'a background tab closes quietly');
  assert.equal(filesWorkspace('/r').tree, false);
  closeWorkspaceFile('/r', '/r/c');
  assert.deepEqual([filesWorkspace('/r').active, filesWorkspace('/r').tree], [null, true]);
  const before = filesWorkspace('/r');
  closeWorkspaceFile('/r', '/r/missing');
  assert.equal(filesWorkspace('/r'), before, 'closing a file that is not open changes nothing');
});

test('hiding the tree, and a reveal that shows it again with the file to scroll to', () => {
  setWorkspaceTree('/r', false);
  assert.equal(filesWorkspace('/r').tree, false);
  const same = filesWorkspace('/r');
  setWorkspaceTree('/r', false);
  assert.equal(filesWorkspace('/r'), same, 'no change, no new state');
  revealInFileTree('/r', '/r/src/a.ts');
  const s = filesWorkspace('/r');
  assert.equal(s.tree, true);
  assert.equal(s.reveal?.path, '/r/src/a.ts');
  revealInFileTree('/r', '/r/src/a.ts');
  assert.ok(filesWorkspace('/r').reveal!.seq > s.reveal!.seq, 'revealing again scrolls again');
});

test('only the most recently changed folders are kept', () => {
  for (let i = 0; i <= FILES_WORKSPACES_MAX; i++) openWorkspaceFile(`/f${i}`, `/f${i}/x`);
  assert.deepEqual(filesWorkspace('/f0').open, [], 'the oldest folder was dropped');
  assert.deepEqual(filesWorkspace(`/f${FILES_WORKSPACES_MAX}`).open, [`/f${FILES_WORKSPACES_MAX}/x`]);
});

test('a view of a folder follows its changes and stops listening when it goes', async () => {
  function Probe({ cwd }: { cwd: string }) {
    const s = useFilesWorkspace(cwd);
    return h('i', null, `${s.active ?? 'none'}|${s.tree}`);
  }
  const r = await render(h(Probe, { cwd: '/v' }));
  assert.equal(r.host.textContent, 'none|true');
  await act(async () => openWorkspaceFile('/v', '/v/a'));
  assert.equal(r.host.textContent, '/v/a|true');
  await act(async () => resetFilesWorkspaces());
  assert.equal(r.host.textContent, 'none|true');
  await r.unmount();
  openWorkspaceFile('/v', '/v/b');
  await settle(act);
});
