// What the sidebar remembers of its folder groups (src/components/sidebar/folderPrefs.ts): folders chats ran in, the order of groups, and a machine's folder kept under its machine's key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderEntryOf, folderPrefsPatch } from '../src/components/sidebar/folderPrefs.ts';
import { machineFolderKey } from '../src/lib/machineFolder.ts';
import type { ProjectGroupData } from '../src/components/sidebar/projectGroups.ts';

const same = (p: string) => p;
const group = (path: string, over: Partial<ProjectGroupData> = {}): ProjectGroupData => ({
  id: null,
  path,
  name: path.split('/').at(-1)!,
  threads: [{ id: `chat${path}` }] as any,
  saved: false,
  ...over,
});
const on = (id: string) => ({ id, name: id });
const studio = (path: string) => group(path, { machine: on('m1') });
const KEY = machineFolderKey('m1', '/srv/app');

test('a folder group is remembered under its path, a machine group under its machine and path', () => {
  assert.equal(folderEntryOf(group('/work/app')), '/work/app');
  assert.equal(folderEntryOf(studio('/srv/app')), KEY);
});

test('nothing new, nothing saved', () => {
  const groups = [group('/work/app'), studio('/srv/app')];
  const prefs = { sidebarFolders: ['/work/app', KEY], sidebarProjectOrder: ['/work/app', KEY] };
  assert.equal(folderPrefsPatch(groups, prefs, same), null);
});

test('a new folder with chats, here or on a machine, is remembered and takes a place in the order', () => {
  const patch = folderPrefsPatch([group('/work/app'), studio('/srv/app'), group('/work/empty', { threads: [] })], {}, same);
  assert.deepEqual(patch, { sidebarFolders: ['/work/app', KEY], sidebarProjectOrder: ['/work/app', KEY] });
});

test('a saved project and a remembered empty folder keep their place; an empty unknown folder is not remembered', () => {
  const groups = [
    group('/work/saved', { id: 'p1', saved: true, threads: [] }),
    group('/work/kept', { threads: [] }),
    group('/work/gone', { threads: [] }),
  ];
  assert.deepEqual(folderPrefsPatch(groups, { sidebarFolders: ['/work/kept'] }, same), {
    sidebarFolders: ['/work/kept'],
    sidebarProjectOrder: ['p1', '/work/kept'],
  });
});

test('a bare path an older version saved for a machine folder becomes that machine key', () => {
  const groups = [studio('/srv/app')];
  assert.deepEqual(folderPrefsPatch(groups, { sidebarFolders: ['/srv/app', '/work/other'], sidebarProjectOrder: [KEY] }, same), {
    sidebarFolders: [KEY, '/work/other'],
    sidebarProjectOrder: [KEY],
  });
  // once saved under the key there is nothing left to move
  assert.equal(folderPrefsPatch(groups, { sidebarFolders: [KEY, '/work/other'], sidebarProjectOrder: [KEY] }, same), null);
});

test('the bare path stays when a chat of this Mac runs in that path, and two machines with the path both get their key', () => {
  const here = [group('/srv/app'), studio('/srv/app')];
  assert.equal(folderPrefsPatch(here, { sidebarFolders: ['/srv/app', KEY], sidebarProjectOrder: ['/srv/app', KEY] }, same), null);
  const two = [studio('/srv/app'), group('/srv/app', { machine: on('m2') })];
  assert.deepEqual(folderPrefsPatch(two, { sidebarFolders: ['/srv/app'], sidebarProjectOrder: [] }, same)?.sidebarFolders, [
    KEY,
    machineFolderKey('m2', '/srv/app'),
  ]);
});

test('folders of this Mac match by the real path this Mac resolves them to', () => {
  const resolve = (p: string) => (p === '/tmp/x' ? '/private/tmp/x' : p);
  const groups = [group('/private/tmp/x')];
  assert.equal(folderPrefsPatch(groups, { sidebarFolders: ['/tmp/x'], sidebarProjectOrder: ['/private/tmp/x'] }, resolve), null);
});

test('legacy bare worktree paths become machine entries without rewriting folder aliases or custom order', () => {
  const wt = '/srv/app.worktrees/mopilot%2fabcd';
  const alias = machineFolderKey('m1', wt);
  const prefs = { sidebarFolders: [alias, wt, KEY], sidebarProjectOrder: [alias, 'p1', KEY] };
  const groups = [studio('/srv/app')];
  const patch = folderPrefsPatch(groups, prefs, same)!;
  assert.deepEqual(patch, { sidebarFolders: [alias, KEY], sidebarProjectOrder: [alias, 'p1', KEY] });
  assert.equal(folderPrefsPatch(groups, patch, same), null);
  assert.deepEqual(folderPrefsPatch([...groups, group(wt)], prefs, same)?.sidebarFolders, [alias, wt, KEY]);
  assert.equal(folderPrefsPatch(groups, { sidebarFolders: [KEY], sidebarProjectOrder: [alias] }, same), null);
});

test('an unresolved worktree spelling cannot erase a saved checkout or its custom order', () => {
  const nested = machineFolderKey('m1', '/srv/app.worktrees/feature/nested');
  const prefs = { sidebarFolders: [nested, KEY], sidebarProjectOrder: [nested, 'other', KEY] };
  assert.equal(folderPrefsPatch([studio('/srv/app')], prefs, same), null);
});
