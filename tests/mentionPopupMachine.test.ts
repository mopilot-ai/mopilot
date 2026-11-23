// The "@" list for a chat on a machine (src/components/composer/ComposerPopups.tsx, #4106): its files are searched on the machine through its Host, never on this Mac; the machine's answer shows as rows, a line says it is searching or cannot, and an offline machine is not asked.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $$, flush, mount } from './support/composer-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const state: any = { threads: { self: { id: 'self', title: 'Current', updatedAt: 1, cwd: '/srv/app' } }, threadOrder: ['self'] };
stubStore({
  useStore: Object.assign((f: any) => f(state), { getState: () => state }),
  currentCwdForNewChat: () => '/repo',
  threadTitle: (t: any) => t.title,
  searchThreads: async () => ({}),
  navigate: () => {},
  toastFailure: () => () => {},
});
const searched: string[] = [];
installNativeStub({
  search: { files: async (cwd: string) => (searched.push(cwd), { files: [{ path: `${cwd}/file1`, file_name: 'file1', indices: null }] }) },
});
// where the chat runs, and what its machine answered
let machine: { id: string; name: string; away: boolean } | null = null;
let answer: any = { state: 'ready', files: [] };
const asked: unknown[][] = [];
mock.module('../src/lib/chatMachine.ts', {
  namedExports: {
    useChatMachine: () => ({ machine, pending: false }),
    useFolderHere: (_id: string | null, cwd: string) => (machine ? '' : cwd),
  },
});
mock.module('../src/lib/hostFileSearch.ts', { namedExports: { useRemoteSearch: (...a: unknown[]) => (asked.push(a), answer) } });
mock.module('../src/components/composer/BrowserTabMentions.tsx', {
  namedExports: { useBrowserTabMentions: () => [], BrowserTabRows: () => null },
});
const { createElement: h } = await import('react');
const { MentionPopup } = await import('../src/components/composer/ComposerPopups.tsx');

const BOX = { id: 'ssh:me@box', name: 'box', away: false };
beforeEach(() => {
  machine = BOX;
  delete state.newChatHost;
  state.newChatProjectId = null;
  state.newChatCwd = null;
  answer = { state: 'ready', files: [] };
  asked.length = 0;
  searched.length = 0;
});
async function open(query = 'fi', threadId: string | null = 'self') {
  const anchor = document.createElement('div');
  document.body.append(anchor);
  const picked: string[] = [];
  const r = await mount(
    h(MentionPopup, {
      anchor,
      threadId,
      query,
      index: 0,
      setIndex() {},
      onPick: (p: string, dir: boolean) => picked.push(p + (dir ? '/' : '')),
      onPickChat() {},
      onPickTab() {},
      onClose() {},
    } as any),
  );
  await flush(130);
  const rows = () => $$('.composer-popup .menu-item').map((x) => x.textContent);
  return { r, picked, rows, row: (i: number) => $$('.composer-popup .menu-item')[i] };
}

test('the files the machine found are the rows, named and with their path in the chat’s folder, and picking one gives that path; this Mac is not searched', async () => {
  answer = { state: 'ready', files: ['src/file1.ts', 'README.md'] };
  const p = await open();
  assert.deepEqual(p.rows(), ['file1.tssrc/file1.ts', 'README.mdREADME.md']);
  assert.deepEqual(asked.at(-1), [BOX.id, '/srv/app', 'fi'], 'the machine is asked about the chat’s own folder');
  const { act } = await import('react');
  await act(async () => p.row(0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  assert.deepEqual(p.picked, ['src/file1.ts']);
  assert.deepEqual(searched, [], 'this Mac was not searched');
  await p.r.unmount();
});

test('while the machine has not answered a line says it is searching; a machine that cannot search says so; neither shows this Mac’s files; no files and no note shows nothing', async () => {
  answer = { state: 'searching' };
  let p = await open();
  assert.deepEqual(p.rows(), ['Searching on box…']);
  assert.equal(p.row(0).getAttribute('role'), 'status');
  await p.r.unmount();
  answer = { state: 'unavailable', notice: 'That folder is outside what this machine shares.' };
  p = await open();
  assert.deepEqual(p.rows(), ["Can't search box"]);
  await p.r.unmount();
  answer = { state: 'ready', files: [] };
  p = await open();
  assert.deepEqual(p.rows(), []);
  await p.r.unmount();
  assert.deepEqual(searched, []);
});

test('an offline machine is not asked and says it cannot be searched', async () => {
  machine = { ...BOX, away: true };
  const p = await open();
  assert.deepEqual(p.rows(), ["Can't search box"]);
  assert.equal(asked.at(-1)![0], null, 'no machine id: nothing is asked');
  assert.deepEqual(searched, []);
  await p.r.unmount();
});

test('a chat on this Mac still searches its own folder, and asks no machine', async () => {
  machine = null;
  answer = { state: 'ready', files: ['never.txt'] };
  const p = await open();
  assert.deepEqual(searched, ['/srv/app']);
  assert.deepEqual(p.rows(), ['file1/srv/app/file1']);
  assert.equal(asked.at(-1)![0], null);
  await p.r.unmount();
});

test('a new chat with a machine and folder picked in the host chip searches that folder on the machine, not this Mac’s', async () => {
  machine = null;
  state.newChatHost = { id: BOX.id, name: 'box', path: '/w/proj' };
  state.newChatProjectId = null;
  state.newChatCwd = null;
  answer = { state: 'ready', files: ['lib/x.ts'] };
  const p = await open('x', null);
  assert.deepEqual(p.rows(), ['x.tslib/x.ts']);
  assert.deepEqual(asked.at(-1), [BOX.id, '/w/proj', 'x']);
  assert.deepEqual(searched, [], 'the new-chat folder on this Mac was not searched');
  await p.r.unmount();
  // a pick of a project or a folder here replaces the machine's
  state.newChatProjectId = 'p1';
  await (await open('x', null)).r.unmount();
  assert.equal(asked.at(-1)![0], null);
});
