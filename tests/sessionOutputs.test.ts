// Output discovery uses completed producer contracts, surviving paths and persisted shell diffs without UI side effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionOutputs, writtenFiles, visualOutput } from '../src/lib/sessionOutputs.ts';
import type { TurnState } from '../src/store/types';
import { toolItem as claudeTool, finishedTool } from './support/claude-translate.ts';
import { toolItem as acpTool } from '../shared/acpItems/toolItems.mjs';

const item = (path: string, kind: any = { type: 'add' }) => ({
  type: 'fileChange',
  id: 'write',
  status: 'completed',
  changes: [{ path, kind, diff: 'new' }],
});
const turn = (id: string, items: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, items, status: 'completed', ...extra }) as TurnState;

test('only confirmed normalized writes count; malformed, failed and pending records have no output', () => {
  for (const input of [
    null,
    [],
    'file',
    {},
    { ...item('a'), changes: null },
    { ...item('a'), status: 'failed' },
    { ...item('a'), status: 'inProgress' },
  ]) {
    assert.deepEqual(writtenFiles(input), []);
  }
  for (const bad of [
    null,
    [],
    {},
    { path: '', kind: { type: 'add' } },
    { path: 4, kind: { type: 'add' } },
    { path: 'a', kind: { type: 'other' } },
    { path: 'a', kind: { type: ['delete'] } },
  ]) {
    assert.deepEqual(writtenFiles({ ...item('a'), changes: [bad] }), []);
  }
  assert.deepEqual(writtenFiles(item('/repo/a.html', { type: 'update', move_path: '/repo/b.html' })), [
    { path: '/repo/a.html', deleted: true },
    { path: '/repo/b.html', deleted: false },
  ]);
});

test('real Claude and ACP edit producers supply the same successful output contract as native file changes', () => {
  const write = { name: 'Write', id: 'c', input: { file_path: '/repo/site.html', content: '<h1>New</h1>' } };
  assert.deepEqual(writtenFiles(claudeTool(write)), []);
  const completed = finishedTool(write, { content: 'saved', is_error: false }, null);
  const basic = acpTool(
    { toolCallId: 'a', kind: 'edit', status: 'completed', rawInput: { path: '/repo/site.html', content: 'new' } },
    '/repo',
  );
  assert.deepEqual(writtenFiles(completed), writtenFiles(item('/repo/site.html')));
  assert.deepEqual(writtenFiles(basic), writtenFiles(item('/repo/site.html')));
});

test('an inventory combines files, takes the latest write, removes deleted or moved paths and excludes undone turns', () => {
  const turns = [
    turn('one', [item('a.html'), item('notes.md'), item('gone.png')]),
    turn('two', [item('a.html'), item('gone.png', { type: 'delete' })]),
    turn('undo', [item('hidden.pdf')], { undone: true }),
  ];
  assert.deepEqual(sessionOutputs(turns, '/repo'), [
    { path: '/repo/a.html', turnId: 'two' },
    { path: '/repo/notes.md', turnId: 'one' },
  ]);
  assert.deepEqual(sessionOutputs([turn('move', [item('a', { type: 'update', move_path: 'b' })])], '/repo'), [
    { path: '/repo/b', turnId: 'move' },
  ]);
});

test('a persisted aggregate diff discovers binary files generated through a command and overrides partial tool evidence', () => {
  const diff =
    'diff --git a/clip.mp4 b/clip.mp4\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/clip.mp4 differ';
  assert.deepEqual(sessionOutputs([turn('shell', [item('unconfirmed.html')], { diff })], '/repo'), [
    { path: '/repo/clip.mp4', turnId: 'shell' },
  ]);
  assert.deepEqual(sessionOutputs([turn('empty', [item('unconfirmed')], { diff: '' })], ''), []);
  assert.deepEqual(sessionOutputs([turn('one', [item('/tmp/report.pdf')])], ''), [{ path: '/tmp/report.pdf', turnId: 'one' }]);
});

test('automatic reveal formats share the viewer classification; ordinary source and documents remain available manually', () => {
  for (const path of ['x.HTML', 'x.htm', 'x.svg', 'x.pdf', 'x.mov', 'x.mp4']) assert.equal(visualOutput(path), true);
  for (const path of ['x.ts', 'x.md', 'x.docx', 'x.mp3', 'folder.html/source']) assert.equal(visualOutput(path), false);
});

test('equivalent dot, absolute and Windows case spellings coalesce before updates and deletion', () => {
  const turns = [turn('first', [item('./report.pdf')]), turn('second', [item('/repo/report.pdf')])];
  assert.deepEqual(sessionOutputs(turns, '/repo'), [{ path: '/repo/report.pdf', turnId: 'second' }]);
  assert.deepEqual(sessionOutputs([...turns, turn('delete', [item('report.pdf', { type: 'delete' })])], '/repo'), []);
  assert.deepEqual(
    sessionOutputs(
      [turn('one', [item('C:/repo/./Report.pdf')]), turn('delete', [item('c:\\repo\\report.pdf', { type: 'delete' })])],
      'C:\\repo',
    ),
    [],
  );
  assert.deepEqual(sessionOutputs([turn('one', [item('./report.pdf')])], ''), [{ path: 'report.pdf', turnId: 'one' }]);
  assert.deepEqual(sessionOutputs([turn('one', [item('link/../report.pdf')])], '/repo'), [
    { path: '/repo/link/../report.pdf', turnId: 'one' },
  ]);
});

test('aggregate renames remove the old output while copies retain both source and destination', () => {
  const before = turn('before', [item('a.pdf')]);
  const rename = 'diff --git a/a.pdf b/b.pdf\nsimilarity index 100%\nrename from a.pdf\nrename to b.pdf';
  const copy = 'diff --git a/a.pdf b/b.pdf\nsimilarity index 100%\ncopy from a.pdf\ncopy to b.pdf';
  assert.deepEqual(sessionOutputs([before, turn('rename', [], { diff: rename })], '/repo'), [{ path: '/repo/b.pdf', turnId: 'rename' }]);
  assert.deepEqual(sessionOutputs([before, turn('copy', [], { diff: copy })], '/repo'), [
    { path: '/repo/b.pdf', turnId: 'copy' },
    { path: '/repo/a.pdf', turnId: 'before' },
  ]);
});
