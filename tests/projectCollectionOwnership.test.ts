// Project edits preserve complete persisted collections whose entries, fields or canonical identities cannot be owned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { ProjectsStore } = createRequire(import.meta.url)('../electron/platform/projects.cjs');
const project = { id: 'known', name: 'Known', path: '/work/known', source: 'sage' };
const extras = [
  null,
  [],
  {},
  { id: '', path: '/new' },
  { id: 7, path: '/new' },
  { id: 'new' },
  { id: 'new', path: 7 },
  { id: 'new', path: '' },
  { ...project, id: 'new', path: '/new', name: { future: 'keep' } },
  { ...project, id: 'new', path: '/new', source: 'future' },
  { ...project, id: 'new', path: '/new', codexId: 7 },
  { ...project, id: 'new', path: '/new', future: { keep: true } },
  { ...project, id: 'known', path: '/other' },
  { ...project, id: 'other', path: '/work/known/' },
];
function fixture(t: any, raw: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-ownership-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, raw);
  return { file, preserved: () => assert.equal(fs.readFileSync(file, 'utf8'), raw) };
}
const mutations = [
  (s: any) => s.add({ path: '/new' }),
  (s: any) => s.remove('known'),
  (s: any) => s.rename('known', 'Renamed'),
  (s: any) => s.move('known', null),
  (s: any) => s.linkCodex('known', 'native'),
  (s: any) => s.importCodex([]),
  (s: any) => s.importFailed('offline'),
];
for (const extra of extras) {
  test(`project mutations retain an unowned entry: ${JSON.stringify(extra)}`, (t) => {
    const raw = JSON.stringify({ schemaVersion: 2, projects: [project, extra] });
    const { file, preserved } = fixture(t, raw);
    const store = new ProjectsStore(file);
    assert.ok(store.list().projects.some((p: any) => p.id === 'known'));
    for (const mutate of mutations) {
      assert.throws(() => mutate(store), /saved project list/);
      preserved();
    }
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), raw);
  });
}
for (const fields of [
  { future: { keep: true } },
  { codexImportedAt: 'future' },
  { codexImportFailure: [] },
  { codexImportFailure: {} },
  { codexImportFailure: { at: 1, message: 42 } },
  { codexImportFailure: { at: 'future', message: 'error' } },
  { codexImportFailure: { at: 1, message: 'error', attempts: 0 } },
  { codexImportFailure: { at: 1, message: 'error', attempts: 1.5 } },
  { codexImportFailure: { at: 1, message: 'error', attempts: 'future' } },
  { codexImportFailure: { at: 1, message: 'error', future: true } },
  { removedPaths: null },
  { removedPaths: [''] },
  { removedPaths: [42] },
  { removedCodexIds: null },
  { removedCodexIds: [42] },
]) {
  test(`project metadata retains an unowned field: ${JSON.stringify(fields)}`, (t) => {
    const raw = JSON.stringify({ schemaVersion: 2, projects: [project], ...fields });
    const { file, preserved } = fixture(t, raw);
    assert.throws(() => new ProjectsStore(file).rename('known', 'Renamed'), /saved project list/);
    preserved();
  });
}

test('project persistence rejects non-finite metadata and canonical Windows path collisions', (t) => {
  for (const raw of [
    '{"projects":[],"codexImportedAt":1e400}',
    '{"projects":[],"codexImportFailure":{"at":1e400,"message":"error"}}',
    JSON.stringify({
      projects: [
        { id: 'a', path: 'C:\\Work' },
        { id: 'b', path: 'c:/work/' },
      ],
    }),
  ]) {
    const { file, preserved } = fixture(t, raw);
    assert.throws(() => new ProjectsStore(file).add({ path: '/new' }), /saved project list/);
    preserved();
  }
});

test('legacy optional project fields remain writable and a restored file recovers in a new store', (t) => {
  const { file } = fixture(t, JSON.stringify({ projects: [project, null] }));
  assert.throws(() => new ProjectsStore(file).rename('known', 'Changed'), /saved project list/);
  fs.writeFileSync(
    file,
    JSON.stringify({ projects: [{ id: 'known', path: '/work/known' }], codexImportFailure: { at: 1, message: 'error' } }),
  );
  const store = new ProjectsStore(file);
  store.rename('known', 'Changed');
  assert.equal(store.list().projects[0].name, 'Changed');
  assert.equal(store.list().codexImportFailure.attempts, 1);
  store.linkCodex('known', 'native');
  store.importCodex([{ id: 'other', roots: [{ path: '/other' }] }]);
  const reopened = new ProjectsStore(file);
  assert.equal(reopened.list().projects[0].codexId, 'native');
  assert.equal(reopened.list().projects[1].source, 'codex');
});
