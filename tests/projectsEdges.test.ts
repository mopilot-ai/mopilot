// electron/platform/projects.cjs edge cases and the projects:* IPC, including the background Codex
// import (done once, deduplicated while running, failures recorded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const P = require('../electron/platform/projects.cjs');

function tmpFile(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-edge-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'projects.json');
}

test('normalize: the root keeps its slash and name; import time and failure attempts are validated', () => {
  const s = P.normalize({
    projects: [{ id: 'r', path: '/' }],
    codexImportedAt: 5,
    codexImportFailure: { at: 1, message: 'm', attempts: 0 },
  });
  assert.deepEqual(s.projects, [{ id: 'r', name: '/', path: '/', source: 'sage' }]);
  assert.equal(s.codexImportedAt, 5);
  assert.equal(s.codexImportFailure.attempts, 1);
  assert.equal(P.normalize({ codexImportFailure: { at: 1, message: 'm', attempts: 3 } }).codexImportFailure.attempts, 3);
});

test('mergeCodex: skips bad entries, orders by position, avoids id clashes, names from the folder', () => {
  const base = P.normalize({ projects: [{ id: 'c2', path: '/local' }], codexImportedAt: 1 });
  const next = P.mergeCodex(base, [
    null,
    { id: 'c1', roots: [] },
    { id: 7, roots: [{ path: '/x' }] },
    { id: 'c3', roots: [{ path: '' }] },
    { id: 'c2', roots: [{ path: '/b/' }], position: 2 },
    { id: 'c4', name: 'Four', roots: [{ path: '/a' }] },
  ]);
  assert.deepEqual(
    next.projects.slice(1).map((p: any) => [p.name, p.path, p.codexId]),
    [
      ['Four', '/a', 'c4'],
      ['b', '/b', 'c2'],
    ],
  );
  assert.notEqual(next.projects[2].id, 'c2', 'a clashing id gets a fresh one');
  assert.equal(P.mergeCodex(base, null), base, 'nothing to import, already imported: unchanged');
});

test('failImport counts attempts and names an unknown error', () => {
  const s = P.failImport(P.normalize({}), '', 9);
  assert.deepEqual(s.codexImportFailure, { at: 9, message: 'unknown error', attempts: 1 });
  assert.equal(P.failImport(s, 'again').codexImportFailure.attempts, 2);
});

test('addProject links an existing folder to a codexId once; new ones get a name and optional codexId', () => {
  let s = P.normalize({
    projects: [
      { id: 'a', path: '/a' },
      { id: 'z', path: '/z' },
    ],
  });
  const r1 = P.addProject(s, { path: '/a/', codexId: 'cx' });
  assert.equal(r1.id, 'a');
  assert.equal(r1.state.projects[0].codexId, 'cx');
  const r2 = P.addProject(r1.state, { path: '/a', codexId: 'other' });
  assert.equal(r2.state, r1.state);
  const r3 = P.addProject(s, { path: '/n', name: 'Named', codexId: 'c9' });
  assert.deepEqual({ ...r3.state.projects[0], id: 'x' }, { id: 'x', name: 'Named', path: '/n', source: 'sage', codexId: 'c9' });
  s = r3.state;
});

test('remove, rename and move refuse what does not apply', () => {
  const s = P.normalize({
    projects: [
      { id: 'a', path: '/a', codexId: 'ca' },
      { id: 'b', path: '/b' },
    ],
    removedCodexIds: ['ca'],
  });
  assert.equal(P.removeProject(s, 'zz'), s);
  assert.deepEqual(P.removeProject(s, 'a').removedCodexIds, ['ca']);
  assert.deepEqual(P.removeProject(s, 'b').removedCodexIds, ['ca']);
  assert.equal(P.renameProject(s, 'a', '  '), s);
  assert.equal(P.renameProject(s, 'a', 3), s);
  assert.equal(P.moveProject(s, 'zz', null), s);
  assert.equal(P.moveProject(s, 'a', 'a'), s);
  assert.deepEqual(
    P.moveProject(s, 'a', 'missing').projects.map((p: any) => p.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    P.moveProject(s, 'b', 'a').projects.map((p: any) => p.id),
    ['b', 'a'],
  );
});

function ipc(store: any, deps?: any) {
  const h = new Map<string, any>();
  P.registerProjects({ handle: (ch: string, f: any) => h.set(ch, f) }, store, deps);
  return (ch: string, ...a: any[]) => h.get(ch)({}, ...a);
}

test('IPC: list, add (absolute paths only), rename, move, remove, import and failure', (t) => {
  const changes: any[] = [];
  const store = new P.ProjectsStore(tmpFile(t), (s: any) => changes.push(s));
  const call = ipc(store);
  assert.equal(call('projects:add', null), null);
  assert.equal(call('projects:add', { path: 'rel' }), null);
  const a = call('projects:add', { path: '/p/a' });
  const b = call('projects:add', { path: '/p/b' });
  call('projects:rename', a, 'A');
  call('projects:move', b);
  call('projects:move', a, b);
  assert.deepEqual(
    call('projects:list').projects.map((p: any) => p.name),
    ['A', 'b'],
  );
  call('projects:remove', b);
  assert.equal(call('projects:importCodex', 'nope').codexImported, true);
  assert.deepEqual(
    call('projects:importCodex', [{ id: 'k', roots: [{ path: '/k' }] }]).projects.map((p: any) => p.path),
    ['/p/a', '/k'],
  );
  assert.equal(call('projects:importFailed', 'boom').codexImportFailure.message, 'boom');
  assert.ok(changes.length >= 5);
  // the IPC checks the path first; called directly without options there is no folder to add
  assert.throws(() => store.add(undefined), TypeError);
});

test('background import: none without a lister; once; shared while running; failures recorded', async (t) => {
  const store = new P.ProjectsStore(tmpFile(t));
  assert.equal(ipc(store)('projects:importCodexBackground').codexImported, false);

  let calls = 0;
  let release: (v: any) => void = () => {};
  const call = ipc(store, { listCodexProjects: () => (calls++, new Promise((r) => (release = r))) });
  const p1 = call('projects:importCodexBackground');
  assert.equal(call('projects:importCodexBackground'), p1);
  release([{ id: 'c1', roots: [{ path: '/c' }] }]);
  assert.deepEqual(
    (await p1).projects.map((p: any) => p.path),
    ['/c'],
  );
  assert.equal(call('projects:importCodexBackground').codexImported, true, 'already imported');
  assert.equal(calls, 1);

  const s2 = new P.ProjectsStore(tmpFile(t));
  assert.equal((await ipc(s2, { listCodexProjects: async () => null })('projects:importCodexBackground')).codexImported, false);
  const s3 = new P.ProjectsStore(tmpFile(t));
  assert.equal(
    (
      await ipc(s3, {
        listCodexProjects: async () => {
          throw new Error('no codex');
        },
      })('projects:importCodexBackground')
    ).codexImportFailure.message,
    'no codex',
  );
  const s4 = new P.ProjectsStore(tmpFile(t));
  assert.equal(
    (await ipc(s4, { listCodexProjects: () => Promise.reject('raw') })('projects:importCodexBackground')).codexImportFailure.message,
    'raw',
  );
});

test('an unreadable project list is kept aside and remains protected', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, '{"projects": [ torn');
  const store = new P.ProjectsStore(file);
  assert.deepEqual(store.read().projects, []);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{"projects": [ torn');
});

const projectMutations = {
  add: (store: any) => store.add({ path: '/new' }),
  remove: (store: any) => store.remove('a'),
  link: (store: any) => store.linkCodex('a', 'native'),
  rename: (store: any) => store.rename('a', 'Renamed'),
  move: (store: any) => store.move('a', 'b'),
  import: (store: any) => store.importCodex([{ id: 'new', roots: [{ path: '/native' }] }]),
  importFailure: (store: any) => store.importFailed('native error'),
};
for (const [name, mutate] of Object.entries(projectMutations)) {
  test(`project ${name} preserves a future schema and unknown fields`, (t) => {
    const file = tmpFile(t);
    const original = JSON.stringify({
      schemaVersion: 3,
      projects: [
        { id: 'a', name: 'A', path: '/a' },
        { id: 'b', path: '/b' },
      ],
      futureData: { keep: true },
    });
    fs.writeFileSync(file, original);
    const changed: any[] = [];
    const store = new P.ProjectsStore(file, (snap: any) => changed.push(snap));
    assert.equal(store.list().projects.length, 2, 'compatible fields remain readable');
    assert.throws(() => mutate(store), /newer version/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(changed, []);
  });
}
for (const original of ['{ torn', 'null', 'true', '[1,2]', '"not a record"']) {
  test(`project mutations preserve an unreadable root ${original}`, (t) => {
    const file = tmpFile(t);
    fs.writeFileSync(file, original);
    const store = new P.ProjectsStore(file);
    assert.deepEqual(store.list().projects, []);
    for (const mutate of Object.values(projectMutations)) assert.throws(() => mutate(store), /project list/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), original);
  });
}

for (const version of [null, 0, -1, 1.5, '1', 'future', true]) {
  test(`project writes reject unsupported declared schema ${JSON.stringify(version)}`, (t) => {
    const file = tmpFile(t);
    const original = JSON.stringify({ schemaVersion: version, projects: [] });
    fs.writeFileSync(file, original);
    const store = new P.ProjectsStore(file);
    assert.throws(() => store.add({ path: '/new' }), /unsupported schema/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
}

test('background import checks local write admission before querying a native harness', (t) => {
  const file = tmpFile(t);
  const original = JSON.stringify({ schemaVersion: 3, projects: [] });
  fs.writeFileSync(file, original);
  let queried = 0;
  const store = new P.ProjectsStore(file);
  const call = ipc(store, { listCodexProjects: async () => (queried++, []) });
  assert.throws(() => call('projects:importCodexBackground'), /newer version/i);
  assert.equal(queried, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('legacy/current project roots stay writable and invalid current collections stay protected', (t) => {
  for (const data of [{}, { projects: [] }, { schemaVersion: 1, projects: [] }, { schemaVersion: 2, projects: [] }]) {
    const file = tmpFile(t);
    fs.writeFileSync(file, JSON.stringify(data));
    assert.ok(new P.ProjectsStore(file).add({ path: '/new' }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
  }
  const file = tmpFile(t);
  const original = JSON.stringify({ schemaVersion: 1, projects: { hidden: 'original' } });
  fs.writeFileSync(file, original);
  assert.throws(() => new P.ProjectsStore(file).add({ path: '/new' }), /project list/i);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('conditional native linking preserves edits, avoids identity replacement and remembers a late deleted copy', (t) => {
  const store = new P.ProjectsStore(tmpFile(t));
  const call = ipc(store);
  const id = store.add({ path: '/owned' });
  const other = store.add({ path: '/other', codexId: 'already-owned' });
  store.rename(id, 'User name');
  store.move(id, other);
  assert.equal(call('projects:linkCodex', id, 'native').name, 'User name');
  assert.equal(store.list().projects[0].id, id);
  assert.equal(store.linkCodex(id, 'different').codexId, 'native');
  assert.equal(store.linkCodex(null, 'x'), null);
  assert.equal(store.linkCodex(id, null), null);
  store.remove(id);
  assert.equal(store.linkCodex(id, 'late'), null);
  assert.equal(store.linkCodex(id, 'late'), null, 'the late-copy tombstone is idempotent');
  store.importCodex([{ id: 'late', roots: [{ path: '/owned' }] }]);
  assert.deepEqual(
    store.list().projects.map((p: any) => p.id),
    [other],
  );
  store.linkCodex(id, 'already-owned');
  assert.ok(!store.read().removedCodexIds.includes('already-owned'), 'another project keeps its identity');
  const prior = store.add({ path: '/prior' });
  // Older native records can carry their native identity in id without a codexId field.
  store.state.projects.find((p: any) => p.id === prior).source = 'codex';
  store.linkCodex(id, prior);
  assert.ok(!store.read().removedCodexIds.includes(prior));
});

test('deleted paths survive restart and suppress exact native folders until an explicit re-add', (t) => {
  const file = tmpFile(t);
  let store = new P.ProjectsStore(file);
  const id = store.add({ path: 'C:\\Owned\\Folder\\' });
  store.remove(id);
  store = new P.ProjectsStore(file);
  store.importCodex([
    { id: 'deleted', roots: [{ path: 'c:/owned/folder/' }] },
    { id: 'child', roots: [{ path: 'C:/Owned/Folder/child' }] },
    { id: 'other', roots: [{ path: '/other' }] },
  ]);
  assert.deepEqual(
    store.list().projects.map((p: any) => p.id),
    ['child', 'other'],
  );
  const replacement = store.add({ path: 'c:/owned/folder' });
  assert.notEqual(replacement, id);
  store.importCodex([{ id: 'new-native', roots: [{ path: 'C:/Owned/Folder' }] }]);
  assert.equal(store.list().projects.find((p: any) => p.id === replacement).codexId, 'new-native');
  store.linkCodex(id, 'new-native');
  assert.ok(!store.read().removedCodexIds.includes('new-native'));
  assert.equal(store.list().projects.find((p: any) => p.id === replacement).codexId, 'new-native');
});

test('removed path metadata is normalized, deduplicated and cleared by existing explicit additions', () => {
  const state = P.normalize({
    projects: [{ id: 'owned', path: '/owned' }],
    removedPaths: ['/owned/', '/owned', null, '', 'C:/Folder/', 'c:\\folder'],
  });
  assert.deepEqual(state.removedPaths, ['/owned', 'c:\\folder']);
  assert.deepEqual(P.removeProject(state, 'owned').removedPaths, state.removedPaths);
  const added = P.addProject(state, { path: '/owned/' });
  assert.equal(added.id, 'owned');
  assert.deepEqual(added.state.removedPaths, ['c:\\folder']);
});

test('a synchronous change listener can remove a just-linked project without returning a stale row', (t) => {
  let removeOnLink = false;
  let store: any;
  store = new P.ProjectsStore(tmpFile(t), (snapshot: any) => {
    if (removeOnLink && snapshot.projects[0]?.codexId) {
      removeOnLink = false;
      store.remove(snapshot.projects[0].id);
    }
  });
  const id = store.add({ path: '/owned' });
  removeOnLink = true;
  assert.equal(store.linkCodex(id, 'native'), null);
  assert.deepEqual(store.list().projects, []);
});
