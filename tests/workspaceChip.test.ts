// The new-chat context bar's workspace chip (src/components/composer/WorkspaceChip.tsx): shown only where workspaces were brought over, picking one, and a pick whose workspace is gone.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { fakeStore, popoverExports, render, click, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore<any>({ newChatWorkspace: null });
let spaces: Record<string, any> = {};
const asked: string[] = [];
stubStore({ useStore: store.useStore, set: store.setState });
installNativeStub({
  git: {
    worktreeAdopted: async (p: string) => {
      asked.push(p);
      if (spaces[p] instanceof Error) throw spaces[p];
      return spaces[p] === undefined ? [] : spaces[p];
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
const { WorkspaceChip, pickedWorkspace } = await import('../src/components/composer/WorkspaceChip.tsx');

const TOKYO = { path: '/c/tokyo', name: 'tokyo', branch: 'feat/tokyo' };
const LIMA = { path: '/c/lima', name: 'lima', branch: null };
const reset = (state: any = {}) => {
  store.reset({ newChatWorkspace: null, ...state });
  spaces = { '/repo': [TOKYO, LIMA] };
  asked.length = 0;
};
const chip = (path = '/repo') => createElement(WorkspaceChip, { path });
const button = (host: Element) => host.querySelector('button.ctx-btn') as HTMLButtonElement | null;
const items = (host: Element) => [...host.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
const open = async (path?: string) => {
  const v = await render(chip(path));
  await flush();
  return v;
};

test('a folder with nothing brought over, or whose list could not be read, has no chip', async () => {
  for (const answer of [[], new Error('git is missing')]) {
    reset();
    spaces['/repo'] = answer;
    const { host, unmount } = await open();
    assert.equal(host.innerHTML, '');
    await unmount();
  }
});

test('the menu lists the workspaces with their branches; picking one names it on the chip, and the first row undoes it', async () => {
  reset();
  const { host, unmount } = await open();
  assert.deepEqual([button(host)!.textContent, button(host)!.getAttribute('aria-label')], ['Workspaces', 'Workspace']);
  await click(button(host));
  await flush();
  assert.deepEqual(
    items(host).map((i) => [i.textContent, i.getAttribute('aria-checked')]),
    [
      ['New worktree or this folder', 'true'],
      ['tokyofeat/tokyo', 'false'],
      ['limaNo branch checked out', 'false'],
    ],
  );
  // read when the folder is shown and again when the menu opens
  assert.deepEqual(asked, ['/repo', '/repo']);
  await click(items(host)[1]);
  assert.deepEqual(store.getState().newChatWorkspace, { root: '/repo', path: '/c/tokyo', name: 'tokyo' });
  assert.deepEqual([button(host)!.textContent, button(host)!.getAttribute('aria-label')], ['tokyo', 'Workspace: tokyo']);
  assert.deepEqual(
    items(host).map((i) => i.getAttribute('aria-checked')),
    ['false', 'true', 'false'],
  );
  await click(items(host)[0]);
  assert.equal(store.getState().newChatWorkspace, null);
  await unmount();
});

test('a pick belongs to its folder: another folder shows its own list, and a pick whose workspace is gone is dropped', async () => {
  reset({ newChatWorkspace: { root: '/repo', path: '/c/tokyo', name: 'tokyo' } });
  spaces['/other'] = [{ path: '/c/oslo', name: 'oslo', branch: 'main' }];
  assert.equal(pickedWorkspace(store.getState(), '/other'), null);
  const v = await open('/other');
  assert.equal(button(v.host)!.textContent, 'Workspaces');
  // the other folder's pick is not this folder's to drop
  assert.equal(store.getState().newChatWorkspace.path, '/c/tokyo');
  // back on its folder, before that folder's list arrives the pick shows and nothing of the other's does
  let arrive = (_: unknown) => {};
  spaces['/repo'] = new Promise((resolve) => {
    arrive = resolve;
  });
  await v.rerender(chip('/repo'));
  assert.equal(button(v.host)!.textContent, 'tokyo');
  // tokyo was removed meanwhile: the pick goes, and the chat would start as the other controls say
  arrive([LIMA]);
  await flush();
  assert.equal(store.getState().newChatWorkspace, null);
  assert.equal(button(v.host)!.textContent, 'Workspaces');
  await v.unmount();
  // an answer that arrives after the chip is gone changes nothing
  reset({ newChatWorkspace: { root: '/repo', path: '/c/gone', name: 'gone' } });
  let answer = (_: unknown) => {};
  spaces['/repo'] = new Promise((resolve) => {
    answer = resolve;
  });
  const late = await render(chip());
  await late.unmount();
  answer([LIMA]);
  await flush();
  assert.equal(store.getState().newChatWorkspace.path, '/c/gone');
});

test('when git cannot say, or the list cannot be read, a pick stays and still shows: it decides where the chat runs', async () => {
  for (const answer of [null, new Error('git timed out')]) {
    reset({ newChatWorkspace: { root: '/repo', path: '/c/tokyo', name: 'tokyo' } });
    spaces['/repo'] = answer;
    const { host, unmount } = await open();
    assert.equal(button(host)!.getAttribute('aria-label'), 'Workspace: tokyo');
    assert.equal(store.getState().newChatWorkspace.path, '/c/tokyo');
    // its menu still offers the way out
    await click(button(host));
    await flush();
    assert.deepEqual(
      items(host).map((i) => i.textContent),
      ['New worktree or this folder'],
    );
    await unmount();
  }
});
