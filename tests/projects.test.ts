// userData/projects.json: the local project list, and its one-way import from Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ProjectsStore, mergeCodex, failImport, normalize, moveProject, writeAtomic } = require('../electron/platform/projects.cjs');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-projects-')), 'projects.json');
const codex = (id: string, p: string, position = 0, name = path.basename(p)) => ({ id, name, roots: [{ path: p }], position });

test('a missing or broken file reads as an empty list', () => {
  const file = tmpFile();
  assert.deepEqual(new ProjectsStore(file).list(), { projects: [], codexImported: false, codexImportFailure: null });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(new ProjectsStore(file).list(), { projects: [], codexImported: false, codexImportFailure: null });
});

test('add, rename, move and remove persist through an atomic write', () => {
  const file = tmpFile();
  const changes: any[] = [];
  const store = new ProjectsStore(file, (snap: any) => changes.push(snap));
  const a = store.add({ path: '/work/a/' });
  const b = store.add({ path: '/work/b', name: 'Bee' });
  assert.equal(store.add({ path: '/work/a' }), a, 'the same folder is not added twice');
  store.rename(a, ' Alpha ');
  store.move(b, a);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.schemaVersion, 2);
  assert.deepEqual(
    disk.projects.map((p: any) => [p.name, p.path, p.source]),
    [
      ['Bee', '/work/b', 'sage'],
      ['Alpha', '/work/a', 'sage'],
    ],
  );
  // no temp files left beside it
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['projects.json']);
  store.remove(b);
  assert.deepEqual(
    new ProjectsStore(file).list().projects.map((p: any) => p.id),
    [a],
  );
  assert.ok(changes.length >= 5);
});

test('writeAtomic replaces the file whole and cleans up after a failed write', () => {
  const file = tmpFile();
  writeAtomic(file, 'one');
  writeAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  // renaming onto a directory fails: the old content stays and no temp file is left
  const dir = path.join(path.dirname(file), 'sub');
  fs.mkdirSync(path.join(dir, 'projects.json'), { recursive: true });
  assert.throws(() => writeAtomic(path.join(dir, 'projects.json'), 'x'));
  assert.deepEqual(fs.readdirSync(dir), ['projects.json']);
});

test('the Codex import appends new projects in Codex order and records itself', () => {
  const s = mergeCodex(normalize(null), [codex('c2', '/w/two', 2), codex('c1', '/w/one', 1)], 1000);
  assert.equal(s.codexImportedAt, 1000);
  assert.deepEqual(
    s.projects.map((p: any) => [p.id, p.path, p.source, p.codexId]),
    [
      ['c1', '/w/one', 'codex', 'c1'],
      ['c2', '/w/two', 'codex', 'c2'],
    ],
  );
});

test('the Codex import dedupes by folder and links rather than repeats', () => {
  const store = new ProjectsStore(tmpFile());
  const mine = store.add({ path: '/w/shared' });
  const snap = store.importCodex([codex('c1', '/w/shared/'), codex('c2', '/w/new'), codex('c3', '/w/new')]);
  assert.equal(snap.codexImported, true);
  assert.deepEqual(
    snap.projects.map((p: any) => [p.id, p.path, p.source, p.codexId]),
    [
      [mine, '/w/shared', 'sage', 'c1'],
      ['c2', '/w/new', 'codex', 'c2'],
    ],
  );
  // a second sync with nothing new changes nothing
  const before = fs.readFileSync(store.file, 'utf8');
  store.importCodex([codex('c1', '/w/shared'), codex('c2', '/w/new')]);
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
});

test('sync is one way: local names stay, and a project removed here stays removed', () => {
  const store = new ProjectsStore(tmpFile());
  store.importCodex([codex('c1', '/w/one', 0, 'one'), codex('c2', '/w/two')]);
  store.rename('c1', 'Mine');
  store.remove('c2');
  const snap = store.importCodex([codex('c1', '/w/one', 0, 'renamed in codex'), codex('c2', '/w/two'), codex('c3', '/w/three')]);
  assert.deepEqual(
    snap.projects.map((p: any) => [p.name, p.path]),
    [
      ['Mine', '/w/one'],
      ['three', '/w/three'],
    ],
  );
});

test('normalize drops malformed and repeated entries', () => {
  const s = normalize({
    schemaVersion: 1,
    projects: [
      { id: 'a', path: '/x' },
      { id: 'b', path: '/x/' },
      { id: 'c' },
      null,
      { id: 'd', path: '/y', name: 'Why', source: 'codex', codexId: 'cd' },
    ],
  });
  assert.deepEqual(s.projects, [
    { id: 'a', name: 'x', path: '/x', source: 'sage' },
    { id: 'd', name: 'Why', path: '/y', source: 'codex', codexId: 'cd' },
  ]);
});

test('move puts a project before another, or at the end', () => {
  const s = normalize({ projects: ['a', 'b', 'c'].map((id) => ({ id, path: '/' + id })) });
  assert.deepEqual(
    moveProject(s, 'c', 'a').projects.map((p: any) => p.id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    moveProject(s, 'a', null).projects.map((p: any) => p.id),
    ['b', 'c', 'a'],
  );
});

test('a failed import is recorded with a count, kept across restarts, and cleared by the next success', () => {
  const file = tmpFile();
  const store = new ProjectsStore(file);
  assert.equal(store.snapshot().codexImportFailure, null);
  store.importFailed('no project API');
  assert.equal(store.importFailed('still none').codexImportFailure?.attempts, 2);
  const again = new ProjectsStore(file).snapshot();
  assert.deepEqual([again.codexImported, again.codexImportFailure?.message, again.codexImportFailure?.attempts], [false, 'still none', 2]);
  const ok = store.importCodex([codex('c1', '/w/one')]);
  assert.equal(ok.codexImported, true);
  assert.equal(ok.codexImportFailure, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).codexImportFailure, null);
});

test('failImport truncates the message and normalize drops a malformed record', () => {
  assert.equal(failImport(normalize(null), 'x'.repeat(900), 5).codexImportFailure.message.length, 500);
  assert.equal(normalize({ codexImportFailure: { message: 3 } }).codexImportFailure, null);
});

test('new folders start at the top without moving existing projects or re-added folders', () => {
  const file = tmpFile();
  const store = new ProjectsStore(file);
  const a = store.add({ path: '/work/a' });
  const b = store.add({ path: '/work/b' });
  store.add({ path: '/work/a' });
  assert.deepEqual(
    new ProjectsStore(file).list().projects.map((p: any) => p.id),
    [b, a],
  );
});

test('Windows folders are named by their last segment and match whatever their case or separators', () => {
  const store = new ProjectsStore(tmpFile());
  const a = store.add({ path: 'C:\\Users\\me\\repo' });
  assert.equal(store.add({ path: 'c:/users/ME/repo/' }), a, 'the same folder');
  const listed = store.list().projects;
  assert.deepEqual(
    listed.map((p: any) => [p.name, p.path]),
    [['repo', 'C:\\Users\\me\\repo']],
  );
  // a root keeps its separator, and the UNC share is its own name
  const root = store.add({ path: 'D:\\' });
  assert.equal(store.add({ path: 'd:' }), root);
  store.add({ path: '\\\\server\\share\\' });
  assert.deepEqual(
    store.list().projects.map((p: any) => [p.name, p.path]),
    [
      ['share', '\\\\server\\share'],
      ['D:', 'D:\\'],
      ['repo', 'C:\\Users\\me\\repo'],
    ],
  );
  // on disk and from Codex: one entry per folder, linked rather than repeated
  const state = normalize({
    projects: [
      { id: '1', path: 'C:\\Work\\X\\' },
      { id: '2', path: 'c:/work/x' },
      { id: '3', path: '/' },
      { id: '4', path: '//' },
    ],
  });
  assert.deepEqual(
    state.projects.map((p: any) => [p.id, p.name, p.path]),
    [
      ['1', 'X', 'C:\\Work\\X'],
      ['3', '/', '/'],
    ],
  );
  const merged = mergeCodex(state, [codex('cx', 'C:/work/x/', 0, '')], 5);
  assert.deepEqual(
    merged.projects.map((p: any) => [p.id, p.codexId ?? null]),
    [
      ['1', 'cx'],
      ['3', null],
    ],
  );
});

test('id-based project mutations preserve ambiguous saved collections until repaired', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      projects: [
        { id: 'shared', path: '/first', codexId: '' },
        { id: 'shared', path: '/second' },
        { id: 'second', path: '/second' },
        { id: '', path: '/third' },
        { id: 'third', path: '/third' },
      ],
    }),
  );
  const original = fs.readFileSync(file, 'utf8');
  let store = new ProjectsStore(file);
  assert.deepEqual(
    store.list().projects.map((p: any) => [p.id, p.path]),
    [
      ['shared', '/first'],
      ['second', '/second'],
      ['third', '/third'],
    ],
  );
  assert.equal(Object.hasOwn(store.list().projects[0], 'codexId'), false);
  assert.throws(() => store.rename('shared', 'Renamed'), /saved project list/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), original);
  fs.writeFileSync(file, JSON.stringify({ projects: store.list().projects }));
  store = new ProjectsStore(file);
  store.rename('shared', 'Renamed');
  assert.deepEqual(
    store.list().projects.map((p: any) => p.name),
    ['Renamed', 'second', 'third'],
  );
  store.remove('shared');
  assert.deepEqual(
    new ProjectsStore(file).list().projects.map((p: any) => p.id),
    ['second', 'third'],
  );
});

test('Codex project import rejects empty identities without occupying a healthy project folder', () => {
  const state = mergeCodex(normalize(null), [codex('', '/same'), codex('valid', '/same')]);
  assert.deepEqual(
    state.projects.map((p: any) => [p.id, p.codexId, p.path]),
    [['valid', 'valid', '/same']],
  );
});
