// The home page's row (src/components/sidebar/homeTarget.ts over src/store/projects.ts newChatGoal): where the new chat goes, picked or by default, as the sidebar lists and marks it, the same decision newChatTarget names on the home page.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const set = S.useStore.setState;
const { newChatTarget } = await import('../src/store/projects.ts');
const { homeTarget: rowOf } = await import('../src/components/sidebar/homeTarget.ts');
const homeTarget = () => rowOf(S.useStore.getState());

const saved = (id: string, path: string) => ({ id, name: path.split('/').pop(), roots: [{ path }] });
const chat = (id: string, cwd: string) => ({ id, cwd, preview: id, updatedAt: 1 });
const PROJECTS = [saved('p1', '/work/alpha'), saved('p2', '/work/beta')];

beforeEach(() => {
  resetState();
  resetAll();
  set({
    home: '/home/me',
    route: { name: 'home' },
    savedProjects: PROJECTS,
    threads: {},
    threadOrder: [],
    chatProject: {},
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: null,
  });
});

test('saved projects, no chats, on home, nothing picked: the home page is the first saved project, as the page names it', () => {
  assert.deepEqual(homeTarget(), { kind: 'project', id: 'p1' });
  assert.equal(newChatTarget()?.projectId, 'p1');
  // nothing saved: no project to be, as for a chat started outside any project
  set({ savedProjects: [] });
  assert.equal(homeTarget(), null);
  assert.equal(newChatTarget(), null);
});

test("the default follows the newest chat's project, and the first saved one once no chat is left", () => {
  set({ threads: { c2: chat('c2', '/work/beta/src'), c1: chat('c1', '/work/alpha') }, threadOrder: ['c2', 'c1'] });
  assert.deepEqual(homeTarget(), { kind: 'project', id: 'p2' });
  // archiving the newest chat moves it to the next chat's project
  set({ threads: { c1: chat('c1', '/work/alpha') }, threadOrder: ['c1'] });
  assert.deepEqual(homeTarget(), { kind: 'project', id: 'p1' });
  set({ threads: {}, threadOrder: [] });
  assert.deepEqual(homeTarget(), { kind: 'project', id: 'p1' });
});

test('a pick replaces the default: a project, a folder outside any project, or a folder on a machine', () => {
  set({ newChatProjectId: 'p2' });
  assert.deepEqual(homeTarget(), { kind: 'project', id: 'p2' });
  assert.equal(newChatTarget()?.projectId, 'p2');
  // a picked project that is gone falls back to the default, as the page does
  set({ newChatProjectId: 'gone' });
  assert.deepEqual(homeTarget(), { kind: 'project', id: 'p1' });
  set({ newChatProjectId: null, newChatCwd: '/work/notes' });
  assert.deepEqual(homeTarget(), { kind: 'folder', path: '/work/notes' });
  assert.equal(newChatTarget()?.path, '/work/notes');
  set({ newChatCwd: null, newChatHost: { id: 'ssh:me@box', name: 'box', path: '/srv/app' } });
  assert.deepEqual(homeTarget(), { kind: 'machine', id: 'ssh:me@box', path: '/srv/app' });
  assert.deepEqual(newChatTarget(), { name: 'app · box', path: '', projectId: null });
  // a project picked after the machine replaces it
  set({ newChatProjectId: 'p2' });
  assert.deepEqual(homeTarget(), { kind: 'project', id: 'p2' });
});

test('no row is the home page for a chat outside any project, or off the home page', () => {
  set({ newChatProjectId: 'none' });
  assert.equal(homeTarget(), null);
  assert.equal(newChatTarget(), null);
  set({ newChatProjectId: 'p2', route: { name: 'projects' } });
  assert.equal(homeTarget(), null);
  set({ route: { name: 'thread', id: 'c1' } });
  assert.equal(homeTarget(), null);
});

test('a store change it does not read finds the same row without searching again; a change it reads finds it anew', () => {
  set({ threads: { c1: chat('c1', '/work/beta') }, threadOrder: ['c1'] });
  const first = homeTarget();
  // every store change runs the sidebar's selectors: one that newChatGoal does not read keeps the answer it had
  set({ searchOpen: true });
  assert.equal(homeTarget(), first);
  set({ savedProjects: [...PROJECTS] });
  const again = homeTarget();
  assert.notEqual(again, first);
  assert.deepEqual(again, { kind: 'project', id: 'p2' });
  set({ newChatProjectId: 'p1' });
  assert.deepEqual(homeTarget(), { kind: 'project', id: 'p1' });
});
