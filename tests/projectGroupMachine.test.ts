// The sidebar's project groups are scoped to their machines and keep remote paths off local filesystem actions.
import { beforeEach, mock, test } from 'node:test';
import { act } from 'react';
import assert from 'node:assert/strict';
import { mockSource } from './support/stubs.ts';
import { mapsFromSnapshot } from '../src/lib/chatMeta.ts';

type Chats = { owners: Map<string, string>; status: 'unknown' | 'ready' | 'failed'; answered: boolean };
const A = 'acp:host-claude:11111111-1111-4111-8111-111111111111';
const B = 'acp:host-codex:22222222-2222-4222-8222-222222222222';
const HERE = 'acp:host-claude:33333333-3333-4333-8333-333333333333';
const STUDIO = { id: 'm1', name: 'Studio', status: 'online' };
const BOX = { id: 'm2', name: 'Box', status: 'online' };
let chats: Chats = { owners: new Map(), status: 'ready', answered: true };
const realChats = await import('../src/lib/hostChats.ts');
mockSource('src/lib/hostChats.ts', {
  ...realChats,
  useHostChats: () => chats,
  machineOfChat: (c: Chats, id: string | null) => (!id ? '' : c.status === 'unknown' || !c.answered ? null : (c.owners.get(id) ?? '')),
});
const realMachines = await import('../src/lib/hostMachines.ts');
mockSource('src/lib/hostMachines.ts', { ...realMachines, useHostMachines: () => ({ machines: [STUDIO, BOX], resolved: true }) });
const kit = await import('./support/shell-sidebar-kit.ts');
const { reset, probe, mountSidebar, thread, named, prefsCalls, click, mouse, byText, getState, label, fx, calls, flush } = kit;
const KEY = (id: string, path: string) => `${id}\0${path}`;
const placed = (...owners: [string, string][]) => (chats = { owners: new Map(owners), status: 'ready', answered: true });
const fixture = (prefs: Record<string, unknown> = {}) =>
  reset({
    home: '/home',
    savedProjects: [{ id: 'p1', name: 'app', roots: [{ path: '/srv/app' }] }],
    threadOrder: [A, B, HERE, 'local'],
    threads: {
      [A]: thread(A, { cwd: '/srv/app', updatedAt: 40 }),
      [B]: thread(B, { cwd: '/srv/app', updatedAt: 30 }),
      [HERE]: thread(HERE, { cwd: '/work/here', updatedAt: 20 }),
      local: thread('local', { cwd: '/srv/app', updatedAt: 10 }),
    },
    prefs: { sidebarFolders: [], sidebarProjectOrder: [], ...prefs },
  });

/** the paths this Mac was asked to resolve */
const watchPaths = () => [] as string[][];
const watchedAnswer = (asked: string[][]) => async (paths: string[]) => (asked.push(paths), Object.fromEntries(paths.map((p) => [p, p])));
const groupRow = (host: HTMLElement, name: string) => host.querySelector(`[aria-label="${name}"]`) as HTMLElement;

beforeEach(() => {
  chats = { owners: new Map(), status: 'ready', answered: true };
});

test('one path on two machines and on this Mac is three groups, the machine ones named by their machine; the Host on this Mac keeps its place', async () => {
  placed([A, STUDIO.id], [B, BOX.id]);
  const asked = watchPaths();
  fixture();
  fx.canonicalPaths = watchedAnswer(asked);
  const { get, view } = await probe();
  const { groups, recents } = get();
  const by = Object.fromEntries(groups.map((g: any) => [label(g.machine ? { id: null, path: KEY(g.machine.id, g.path) } : g), g]));
  // this Mac's saved project holds this Mac's own chat; the Host-on-this-Mac chat is placed by its folder as before
  assert.deepEqual(
    by.p1.threads.map((t: any) => t.id),
    ['local'],
  );
  assert.deepEqual(by[KEY('m1', '/srv/app')].machine, { id: 'm1', name: 'Studio' });
  assert.deepEqual(by[KEY('m2', '/srv/app')].machine, { id: 'm2', name: 'Box' });
  assert.deepEqual(
    by[KEY('m1', '/srv/app')].threads.map((t: any) => t.id),
    [A],
  );
  assert.deepEqual(
    by[KEY('m2', '/srv/app')].threads.map((t: any) => t.id),
    [B],
  );
  assert.equal(by[KEY('m1', '/srv/app')].hint, 'Studio');
  assert.equal(by[KEY('m2', '/srv/app')].hint, 'Box');
  assert.equal(by.p1.hint, undefined, 'the local folder icon distinguishes the local app');
  assert.deepEqual(
    by['/work/here'].threads.map((t: any) => t.id),
    [HERE],
  );
  assert.equal(by['/work/here'].machine, undefined);
  // every chat is still in Recents, a Host-on-this-Mac chat among them
  assert.deepEqual(recents.map((t: any) => t.id).sort(), [A, B, HERE, 'local'].sort());
  // this Mac asks only for its own paths
  assert.equal(
    asked.flat().some((p) => p.includes('\0')),
    false,
  );
  const machineOnly = prefsCalls().at(-1);
  assert.ok(machineOnly.sidebarFolders.includes(KEY('m1', '/srv/app')));
  assert.ok(machineOnly.sidebarFolders.includes(KEY('m2', '/srv/app')));
  assert.ok(machineOnly.sidebarProjectOrder.includes(KEY('m1', '/srv/app')));
  await view.unmount();
});

test('a machine path no chat of this Mac uses is sent to no disk lookup here, and a saved project of this Mac never claims it', async () => {
  placed([A, STUDIO.id]);
  const asked = watchPaths();
  reset({
    home: '/home',
    savedProjects: [{ id: 'p1', name: 'mount', roots: [{ path: '/mnt/box/app' }] }],
    threadOrder: [A],
    threads: { [A]: thread(A, { cwd: '/mnt/box/app', updatedAt: 40 }) },
    prefs: { sidebarFolders: [KEY('m1', '/mnt/box/app')], sidebarProjectOrder: [], hiddenFolders: [KEY('m9', '/mnt/gone')] },
  });
  fx.canonicalPaths = watchedAnswer(asked);
  const { get, view } = await probe();
  assert.equal(asked.flat().includes('/mnt/box/app'), true, 'the saved project root is this Mac');
  assert.equal(
    asked.flat().some((p) => p.includes('\0')),
    false,
    'no machine key reaches the disk lookup',
  );
  const groups = get().groups;
  assert.deepEqual(groups.find((g: any) => g.id === 'p1').threads, [], 'the machine chat is not placed by this Mac project');
  assert.deepEqual(
    groups.find((g: any) => g.machine).threads.map((t: any) => t.id),
    [A],
  );
  await view.unmount();
});

test('before main says where a chat runs it is in Recents only: no group, and nothing is remembered from its path', async () => {
  chats = { owners: new Map(), status: 'unknown', answered: true };
  fixture();
  const { get, view } = await probe();
  const { groups, recents } = get();
  assert.deepEqual(
    groups.flatMap((g: any) => g.threads.map((t: any) => t.id)).sort(),
    ['local'],
    'only the chat that is no ACP chat is placed',
  );
  assert.deepEqual(recents.map((t: any) => t.id).sort(), [A, B, HERE, 'local'].sort());
  assert.equal(
    prefsCalls().some((p: any) => (p.sidebarFolders ?? []).length > 0),
    false,
  );
  await view.unmount();
});

test('until main says where each chat runs every group is listed; then an empty machine folder is listed only when pinned or picked for a new chat on that machine', async () => {
  chats = { owners: new Map(), status: 'unknown', answered: false };
  const empty = KEY(STUDIO.id, '/srv/empty');
  fixture({ sidebarFolders: [empty] });
  const { get, view } = await probe();
  const listed = () => get().listed.map((g: any) => (g.machine ? KEY(g.machine.id, g.path) : label(g)));
  try {
    // the ACP chats wait in Recents, so no group is known to be empty yet
    assert.equal(listed().includes(empty), true);
    placed([A, STUDIO.id], [B, BOX.id]);
    await kit.update({ ...getState() });
    assert.deepEqual(listed().sort(), [KEY(BOX.id, '/srv/app'), KEY(STUDIO.id, '/srv/app'), '/work/here', 'p1'].sort());
    await kit.update({ ...getState(), prefs: { ...getState().prefs, pinnedProjects: [empty] } });
    assert.equal(listed().includes(empty), true);
    const pickHost = (host: { id: string; name: string }) =>
      kit.update({
        ...getState(),
        prefs: { ...getState().prefs, pinnedProjects: [] },
        route: { name: 'home' },
        newChatProjectId: null,
        newChatCwd: null,
        newChatHost: { id: host.id, name: host.name, path: '/srv/empty' },
      });
    await pickHost(STUDIO);
    assert.equal(listed().includes(empty), true);
    // the same path picked on another machine is another folder
    await pickHost(BOX);
    assert.equal(listed().includes(empty), false);
  } finally {
    await view.unmount();
  }
});

test('an old bare path remembered for a machine folder becomes that machine key, and a folder of this Mac with the same path stays', async () => {
  placed([A, STUDIO.id]);
  reset({
    home: '/home',
    savedProjects: [],
    threadOrder: [A],
    threads: { [A]: thread(A, { cwd: '/srv/only-on-studio', updatedAt: 40 }) },
    prefs: { sidebarFolders: ['/srv/only-on-studio', '/srv/kept'], sidebarProjectOrder: [] },
  });
  const { get, view } = await probe();
  const groups = get().groups;
  // no second, empty group of this Mac for the old bare path
  assert.equal(groups.filter((g: any) => g.path === '/srv/only-on-studio').length, 1);
  assert.equal(groups.find((g: any) => g.path === '/srv/only-on-studio').machine.id, 'm1');
  const saved = prefsCalls().at(-1);
  assert.deepEqual(saved.sidebarFolders, [KEY('m1', '/srv/only-on-studio'), '/srv/kept']);
  await view.unmount();
});

test("a machine group's menu greys Reveal in Finder with the machine named and never reveals a path here; its folder is not checked on this Mac", async () => {
  placed([A, STUDIO.id]);
  reset({
    home: '/home',
    savedProjects: [],
    threadOrder: [A],
    threads: { [A]: thread(A, { cwd: '/srv/box-app', updatedAt: 40 }) },
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
  });
  const view = await mountSidebar();
  const row = () => groupRow(view.host, 'box-app');
  await mouse(row(), 'contextmenu');
  const reveal = [...view.$('[data-menu]').querySelectorAll('button')].find((b) =>
    b.textContent!.startsWith('Reveal in Finder'),
  ) as HTMLButtonElement;
  assert.equal(reveal.disabled, true);
  assert.equal(reveal.querySelector('.menu-hint')?.textContent, 'On Studio');
  assert.equal(reveal.title, 'This folder is on Studio, not on this Mac');
  await click(reveal);
  assert.deepEqual(named('openPath'), []);
  assert.equal(
    named('exists').some(([p]) => p === '/srv/box-app'),
    false,
  );
  assert.equal(
    named('folderAvailability').some(([paths]) => paths.includes('/srv/box-app')),
    false,
  );
  assert.equal(row().querySelector('.side-row-label')?.textContent, 'box-app');
  assert.equal(row().getAttribute('aria-description'), 'On Studio');
  await view.unmount();
});

test('unavailable local ACP folders hide without consulting a remote or unresolved ACP path locally', async () => {
  placed([A, STUDIO.id]);
  reset({
    threadOrder: [A, HERE],
    threads: { [A]: thread(A, { cwd: '/remote' }), [HERE]: thread(HERE, { cwd: '/local' }) },
  });
  fx.exists = false;
  const { get, view } = await probe();
  try {
    assert.deepEqual(
      get().listed.map((g: any) => g.path),
      ['/remote'],
    );
    assert.deepEqual(named('folderAvailability'), [[['/local']]]);
    assert.deepEqual(
      get()
        .recents.map((t: any) => t.id)
        .sort(),
      [A, HERE].sort(),
    );
    chats = { owners: new Map(), status: 'unknown', answered: false };
    const resolved = watchPaths();
    fx.canonicalPaths = watchedAnswer(resolved);
    const privateMaps = mapsFromSnapshot({
      chats: {
        private: {
          meta: { momo: 'main' },
          segments: [
            { kind: 'codex', nativeId: 'private', start: 0, count: 1 },
            { kind: 'claude', nativeId: 'claude:s9', start: 1, count: null },
          ],
        },
      },
      newer: [],
    } as any);
    for (const id of ['private', 'claude:s9']) {
      await kit.update({
        ...getState(),
        ...privateMaps,
        threads: { [A]: thread(A, { cwd: '/unresolved' }), [id]: thread(id, { cwd: '/unresolved' }) },
        threadOrder: [A, id],
        worktreeOf: { [id]: '/unresolved' },
        prefs: { sidebarFolders: ['/unresolved'], pinnedProjects: ['/unresolved'] },
      });
      assert.equal(
        named('folderAvailability').some(([paths]) => paths.includes('/unresolved')),
        false,
        id,
      );
      assert.equal(resolved.flat().includes('/unresolved'), false, id);
      assert.deepEqual(
        get().recents.map((chat: any) => chat.id),
        [A],
      );
    }
  } finally {
    await view.unmount();
  }
});

test("a machine group's name, hiding and new chat go by its machine", async () => {
  placed([A, STUDIO.id]);
  reset({
    home: '/home',
    savedProjects: [],
    threadOrder: [A],
    threads: { [A]: thread(A, { cwd: '/srv/box-app', updatedAt: 40 }) },
    prefs: { sidebarFolders: [KEY('m1', '/srv/box-app')], sidebarProjectOrder: [KEY('m1', '/srv/box-app')] },
  });
  const view = await mountSidebar();
  const row = () => groupRow(view.host, 'box-app');
  // a new chat starts on that machine, in that folder, and never in the path on this Mac
  await click(row().querySelector('[aria-label="New chat in box-app"]')!);
  assert.deepEqual(named('setNewChatHostFolder'), [[{ id: 'm1', name: 'Studio' }, '/srv/box-app']]);
  assert.deepEqual(getState().route, { name: 'home' });
  // hiding it remembers that machine's folder, not the bare path
  (globalThis as any).confirm = mock.fn(() => true);
  await mouse(row(), 'contextmenu');
  await click(byText(view.$('[data-menu]'), 'button', 'Remove from sidebar'));
  assert.deepEqual(getState().prefs.hiddenFolders, [KEY('m1', '/srv/box-app')]);
  assert.equal(
    calls.some((c) => c[0] === 'navigate' && c[1].cwd === '/srv/box-app'),
    false,
  );
  await view.unmount();
});

test('the machine group of a picked folder is the open one on the new-chat page', async () => {
  placed([A, STUDIO.id]);
  reset({
    home: '/home',
    savedProjects: [],
    route: { name: 'home' },
    threadOrder: [A],
    threads: { [A]: thread(A, { cwd: '/srv/box-app', updatedAt: 40 }) },
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: { id: 'm1', name: 'Studio', path: '/srv/box-app' },
  });
  const view = await mountSidebar();
  assert.ok(groupRow(view.host, 'box-app').classList.contains('selected'));
  await kit.update({ ...getState(), newChatHost: { id: 'm2', name: 'Box', path: '/srv/box-app' } });
  assert.equal(groupRow(view.host, 'box-app').classList.contains('selected'), false);
  await view.unmount();
});

test("a machine's folder picked is the home page's only marked row, not the default project's as well", async () => {
  placed([A, STUDIO.id]);
  reset({
    home: '/home',
    savedProjects: [{ id: 'p1', name: 'app', roots: [{ path: '/work/app' }] }],
    route: { name: 'home' },
    threadOrder: [A, 'local'],
    threads: { [A]: thread(A, { cwd: '/srv/box-app', updatedAt: 40 }), local: thread('local', { projectId: 'p1', updatedAt: 10 }) },
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
    // the newest chat's project would be the default, but the machine's folder was picked after it
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: { id: 'm1', name: 'Studio', path: '/srv/box-app' },
  });
  const view = await mountSidebar();
  assert.deepEqual(
    [...view.host.querySelectorAll('.project-row.selected')].map((row) => row.getAttribute('aria-label')),
    ['box-app'],
  );
  await view.unmount();
});

test('a hidden machine folder sends its chats to Recents, a chat with no folder is in Recents only, and a machine no longer listed is named by its id', async () => {
  placed([A, 'm9'], [B, STUDIO.id], [HERE, BOX.id]);
  reset({
    home: '/home',
    savedProjects: [],
    threadOrder: [A, B, HERE],
    threads: {
      [A]: thread(A, { cwd: '/srv/gone-box', updatedAt: 40 }),
      [B]: thread(B, { cwd: '/srv/hidden', updatedAt: 30 }),
      [HERE]: thread(HERE, { cwd: undefined, updatedAt: 20 }),
    },
    prefs: { sidebarFolders: [], sidebarProjectOrder: [], hiddenFolders: [KEY('m1', '/srv/hidden')] },
  });
  const { get, view } = await probe();
  const { groups, recents } = get();
  assert.deepEqual(
    groups.map((g: any) => [g.path, g.machine]),
    [['/srv/gone-box', { id: 'm9', name: 'm9' }]],
  );
  assert.deepEqual(
    recents.map((t: any) => t.id),
    [A, B, HERE],
  );
  await view.unmount();
});

test('a chat starting on a machine is shown in that machine folder, and its path is not looked up here', async () => {
  placed([A, STUDIO.id]);
  const asked = watchPaths();
  reset({
    home: '/home',
    savedProjects: [],
    threadOrder: [A],
    threads: { [A]: thread(A, { cwd: '/srv/box-app', updatedAt: 40 }) },
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
  });
  fx.canonicalPaths = watchedAnswer(asked);
  const { useChatStarts } = await import('../src/lib/chatStarts.ts');
  useChatStarts.setState([{ id: 's1', name: 'New chat', cwd: '/srv/starting', projectId: null, hostId: STUDIO.id, updatedAt: 1 }], true);
  const { get, view } = await probe();
  const starting = get().groups.find((g: any) => g.path === '/srv/starting');
  assert.deepEqual(starting.machine, { id: 'm1', name: 'Studio' });
  assert.equal(starting.starting.length, 1);
  assert.equal(asked.flat().includes('/srv/starting'), false);
  useChatStarts.setState([], true);
  await view.unmount();
});

test('a remote project card names its machine with the path in details and no local file action', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    placed([A, STUDIO.id]);
    reset({
      home: '/home',
      savedProjects: [],
      threadOrder: [A],
      threads: { [A]: thread(A, { cwd: '/srv/box-app', updatedAt: 40 }) },
      prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
    });
    const view = await mountSidebar();
    await mouse(groupRow(view.host, 'box-app'), 'mouseover');
    await flush();
    await act(async () => mock.timers.tick(600));
    await flush();
    const card = view.$('.project-card');
    assert.ok(card.querySelector('.project-card-head .lucide-monitor'));
    assert.doesNotMatch(card.textContent!, /\/srv\/box-app/);
    const location = byText(card, '.project-card-row', 'On Studio');
    assert.equal(location.tagName, 'DIV');
    assert.equal(location.title, 'On Studio\n/srv/box-app');
    await click(location);
    assert.deepEqual(named('openPath'), []);
    await view.unmount();
  } finally {
    mock.timers.reset();
  }
});

test('a folder of this Mac with a chat starting in it stays when a machine has a chat starting in the same path', async () => {
  placed();
  reset({
    home: '/home',
    savedProjects: [],
    threadOrder: [],
    threads: {},
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
  });
  const { useChatStarts } = await import('../src/lib/chatStarts.ts');
  useChatStarts.setState(
    [
      { id: 's1', name: 'New chat', cwd: '/srv/same', projectId: null, updatedAt: 2 },
      { id: 's2', name: 'New chat', cwd: '/srv/same', projectId: null, hostId: STUDIO.id, updatedAt: 1 },
    ],
    true,
  );
  const { get, view } = await probe();
  assert.deepEqual(
    get().groups.map((g: any) => [g.path, g.machine?.id, g.starting.length]),
    [
      ['/srv/same', undefined, 1],
      ['/srv/same', 'm1', 1],
    ].sort(),
  );
  useChatStarts.setState([], true);
  await view.unmount();
});

test("a machine picked with no folder yet, or a folder of it no chat ran in, has no row: New chat is the home page's current entry", async () => {
  placed([A, STUDIO.id]);
  reset({
    home: '/home',
    savedProjects: [{ id: 'p1', name: 'app', roots: [{ path: '/work/app' }] }],
    route: { name: 'home' },
    threadOrder: [A, 'local'],
    threads: { [A]: thread(A, { cwd: '/srv/box-app', updatedAt: 40 }), local: thread('local', { projectId: 'p1', updatedAt: 10 }) },
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
    newChatProjectId: null,
    newChatCwd: null,
    newChatHost: { id: 'm1', name: 'Studio', path: '' },
  });
  const view = await mountSidebar();
  const newChat = () => view.host.querySelector('.sidebar-nav > .side-row') as HTMLElement;
  try {
    assert.equal(view.host.querySelector('.project-row.selected'), null);
    assert.match(newChat().className, /selected-soft/);
    await kit.update({ ...getState(), newChatHost: { id: 'm1', name: 'Studio', path: '/srv/untouched' } });
    assert.equal(view.host.querySelector('.project-row.selected'), null);
    assert.match(newChat().className, /selected-soft/);
  } finally {
    await view.unmount();
  }
});
