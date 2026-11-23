// The composer's @ list as Claude Desktop's (src/components/composer/ComposerPopups.tsx, #1931): chats before files, 3 chats for
// a bare "@" and 8 while typing, matched by a plain substring of their title (not by text found inside them).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $$, flush, mount } from './support/composer-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

let fixture: any;
stubStore({
  useStore: Object.assign((f: any) => f(fixture.state), { getState: () => fixture.state }),
  currentCwdForNewChat: () => '/repo',
  threadTitle: (t: any) => t.title,
  searchThreads: (q: string) => fixture.remote(q),
  navigate: () => {},
  toastFailure: () => () => {},
});
installNativeStub({ search: { files: async () => ({ files: fixture.files }) } });
mock.module('../src/components/composer/BrowserTabMentions.tsx', {
  namedExports: { useBrowserTabMentions: () => [], BrowserTabRows: () => null },
});
const { createElement: h } = await import('react');
const { MentionPopup, MENTION_CHATS_EMPTY, MENTION_CHATS_TYPING } = await import('../src/components/composer/ComposerPopups.tsx');

const chat = (i: number) => ({ id: `c${i}`, title: `Calc chat ${i}`, updatedAt: 100 - i, cwd: '/repo' });
beforeEach(() => {
  const chats = Array.from({ length: 12 }, (_, i) => chat(i));
  fixture = {
    state: { threads: Object.fromEntries(chats.map((c) => [c.id, c])), threadOrder: chats.map((c) => c.id), claudeArchived: {} },
    files: [{ path: '/repo/calc.py', file_name: 'calc.py', indices: null }],
    remote: async () => ({ codex: [{ id: 'inside', title: 'Found only inside the transcript', updatedAt: 200, cwd: '/repo' }] }),
  };
});

const shown = async (query: string) => {
  const anchor = document.createElement('div');
  document.body.append(anchor);
  const props = { anchor, threadId: null, query, index: 0, setIndex() {}, onPick() {}, onPickChat() {}, onPickTab() {}, onClose() {} };
  const r = await mount(h(MentionPopup, props as any));
  await flush(200);
  const rows = $$('.composer-popup .menu-item').map((e) => e.textContent ?? '');
  await r.unmount();
  anchor.remove();
  return rows;
};

test('a bare @ offers the 3 most recent chats, then the files', async () => {
  assert.equal(MENTION_CHATS_EMPTY, 3);
  assert.deepEqual(await shown(''), ['Calc chat 0', 'Calc chat 1', 'Calc chat 2', 'calc.py/repo/calc.py']);
});

test('while typing, up to 8 chats whose title holds the term come before the files; text found inside a chat does not match', async () => {
  assert.equal(MENTION_CHATS_TYPING, 8);
  const rows = await shown('calc');
  assert.deepEqual(
    rows.slice(0, 8),
    Array.from({ length: 8 }, (_, i) => `Calc chat ${i}`),
  );
  assert.equal(rows.length, 9);
  assert.match(rows[8], /^calc\.py/);
  assert.doesNotMatch(rows.join('|'), /Found only inside/);
});

test('a chat matched only by text inside it is not offered, even with room in the list', async () => {
  const rows = await shown('chat 1');
  assert.deepEqual(rows.slice(0, 3), ['Calc chat 1', 'Calc chat 10', 'Calc chat 11']);
  assert.doesNotMatch(rows.join('|'), /Found only inside/);
});
