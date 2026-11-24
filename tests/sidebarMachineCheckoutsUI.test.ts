// The project sidebar groups different working directories of a checkout on the Host that owns them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineFolderKey } from '../src/lib/machineFolder.ts';
import { native } from '../src/lib/native.ts';
import { fakeNative } from './support/ports/native.ts';
import { byText, click, flush, getState, mountSidebar, mouse, named, reset, thread, update } from './support/shell-sidebar-kit.ts';

test('one Host groups a Git checkout, its subfolder and its linked worktree without an origin', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'host-project-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, 'checkout');
  const source = join(checkout, 'src');
  const managed = join(dir, 'checkout.worktrees', 'feature');
  const nested = join(managed, 'nested');
  const notes = join(dir, 'checkout.worktrees', 'notes');
  const linked = join(dir, 'linked');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  mkdirSync(source, { recursive: true });
  git(checkout, 'init', '-q');
  git(checkout, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-qm', 'Initial');
  git(checkout, 'worktree', 'add', '-q', '--detach', linked);
  git(checkout, 'worktree', 'add', '-q', '--detach', managed);
  mkdirSync(nested);
  mkdirSync(notes);
  git(nested, 'init', '-q');

  const hosts = ['ssh:one', 'ssh:two'];
  const ids = [
    'acp:host-codex:root',
    'acp:host-claude:src',
    'acp:kimi:linked',
    'acp:host-codex:nested',
    'acp:host-codex:other',
    'acp:host-codex:notes',
  ];
  const paths = [checkout, source, linked, nested, checkout, notes];
  reset({ threadOrder: ids, threads: Object.fromEntries(ids.map((id, index) => [id, thread(id, { cwd: paths[index] })])) });
  const previous = native.host;
  let checkoutAvailable = true;
  native.host = fakeNative({
    host: {
      access: async () => true,
      onAccess: () => () => undefined,
      machines: async () => ({
        machines: hosts.map((id) => ({ id, name: id, note: '', status: 'online', repositoryScope: `${id}:paired` })),
        resolved: true,
      }),
      onMachines: () => () => undefined,
      remoteChats: async () => ids.map((chatId, index) => ({ chatId, hostId: index === 4 ? hosts[1] : hosts[0] })),
      sidebarRepository: async (id: string, query: { path: string; checkout?: true }) => {
        if (!query.checkout || !checkoutAvailable) return { value: null };
        if (id === hosts[1]) return { value: 'invalid relative path' };
        if (query.path === notes) return { value: notes };
        return { value: git(query.path, 'worktree', 'list', '--porcelain', '-z').split('\0')[0].slice('worktree '.length) };
      },
    },
  }).host;
  t.after(() => {
    native.host = previous;
  });

  let view = await mountSidebar();
  try {
    await flush();
    const members = view
      .$$('.project-group')
      .map((group) => [...group.querySelectorAll('[data-sidebar-chat]')].map((row) => row.getAttribute('data-sidebar-chat')).sort());
    assert.deepEqual(members.filter((ids) => ids.length).sort(), [ids.slice(0, 3).sort(), ...ids.slice(3).map((id) => [id])].sort());
    assert.deepEqual(
      ids.map((id) => getState().threads[id].cwd),
      paths,
    );

    const key = machineFolderKey(hosts[0], checkout);
    const alias = machineFolderKey(hosts[0], source);
    await update({
      ...getState(),
      collapsedProjects: { [alias]: true },
      prefs: {
        ...getState().prefs,
        chatSort: 'manual',
        chatOrder: { [alias]: [ids[2], ids[1], ids[0]] },
        folderNames: { [alias]: 'Renamed checkout' },
        pinnedProjects: [alias],
      },
    });
    const header = view.$('.project-row[aria-label="Renamed checkout"]');
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    await click(header);
    assert.equal(getState().collapsedProjects[key], false);
    const chats = header.closest('.project-group')!.querySelectorAll('[data-sidebar-chat]');
    assert.deepEqual(
      [...chats].map((row) => row.getAttribute('data-sidebar-chat')),
      [ids[2], ids[1], ids[0]],
    );
    await click(view.$('[aria-label="New chat in Renamed checkout"]'));
    assert.deepEqual(named('setNewChatHostFolder'), [[{ id: hosts[0], name: hosts[0], scope: `${hosts[0]}:paired` }, checkout]]);

    await update({
      ...getState(),
      threads: { [ids[1]]: getState().threads[ids[1]] },
      threadOrder: [ids[1]],
      collapsedProjects: {},
      prefs: { sidebarFolders: [checkout], pinnedProjects: [checkout], chatOrder: {} },
    });
    await flush();
    const headings = view.$$('.project-row');
    assert.equal(headings.length, 2, 'a pinned local folder is independent of the Host checkout with the same path');
    assert.ok(headings.some((row) => !row.querySelector('.host-mark')));
    assert.ok(getState().prefs.sidebarFolders.includes(checkout));

    const confirm = globalThis.confirm;
    globalThis.confirm = () => true;
    t.after(() => {
      globalThis.confirm = confirm;
    });
    await mouse(headings.find((row) => row.querySelector('.host-mark'))!, 'contextmenu');
    await click(byText(view.$('[data-menu]'), 'button', 'Remove from sidebar'));
    assert.ok(getState().prefs.hiddenFolders.includes(alias));
    await view.unmount();
    checkoutAvailable = false;
    view = await mountSidebar();
    await flush();
    assert.equal(view.$$('.project-row').length, 1, 'the hidden checkout stays hidden without a Host reply');
    assert.ok(view.$(`[data-sidebar-chat="${ids[1]}"]`), 'the hidden chat is still available in Recents');
  } finally {
    await view.unmount();
  }
});
