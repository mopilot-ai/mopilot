// A Codex turn's hidden block of Host paths (shared/attachedFiles.mjs) as the thread draws it, live and from a reloaded rollout: the typed words and the file chips, never the Host's private path.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, setStore, resetStore } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Presence.tsx', 'presence', { Collapse: ({ open, children }: any) => (open ? children : null) });
autoMock('src/components/ui/Popover.tsx', 'popover', { Tooltip: ({ children }: any) => children });
autoMock('src/components/thread/PeerMessages.tsx', 'peer', { PeerContext: (await import('react')).createContext([]) });
autoMock('src/session/harness/claude.ts', 'claude', { useCommandProvider: () => null });
const { UserMessage } = await import('../src/components/thread/view/UserMessage.tsx');
const { buildInput } = (await import('node:module')).createRequire(import.meta.url)('../electron/harness/codexParams.cjs');

beforeEach(() => {
  resetStore();
  setStore({ threads: { c1: { id: 'c1', cwd: '/repo' } } });
});

const HOST = '/home/u/.mopilot-host/chat-files/ab12/cd34';
const staged = [
  { kind: 'file', name: 'note-x.txt', path: `${HOST}/0/note-x.txt`, staged: true },
  { kind: 'file', name: 'my proj', path: `${HOST}/1/my proj`, staged: true },
];

for (const [label, content] of [
  // the user item as a reloaded Codex rollout holds it: the text the turn was sent with, and the mentions
  [
    'reloaded rollout',
    [
      { type: 'text', text: buildInput('read them', staged)[0].text, text_elements: [] },
      ...staged.map(({ name }) => ({ type: 'mention', name })),
    ],
  ],
  // the user item a machine chat's own record holds: what was typed and the names
  [
    'machine chat record',
    [{ type: 'text', text: 'read them', text_elements: [] }, ...staged.map(({ name }) => ({ type: 'mention', name }))],
  ],
] as const) {
  test(`the user bubble of a ${label} is the typed words and a chip per file or folder, never the Host path`, async () => {
    const v = await render(
      h(UserMessage, {
        threadId: 'c1',
        turnId: 't1',
        userIndex: 0,
        canEdit: false,
        item: { type: 'userMessage', id: 'u1', content },
      } as any),
    );
    assert.equal(v.$('.user-bubble')?.textContent, 'read them');
    const shown = v.$('.user-message')?.textContent ?? '';
    assert(shown, 'the message is drawn');
    assert(shown.includes('note-x.txt') && shown.includes('my proj'), 'a chip per file and folder');
    assert(!/chat-files|sage-attached|@\//.test(shown), 'no Host path in what is drawn');
    await v.unmount();
  });
}
