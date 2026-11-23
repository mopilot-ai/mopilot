// A sidebar row's name in motion (#2150), the same on every harness: a new name (the generated title replacing the
// first words) crossfades in, and a working chat's name shimmers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h } from 'react';
import type { Thread } from '../src/store/types.ts';
import { reset, render, update, getState, thread, ThreadRow } from './support/shell-sidebar-kit.ts';
import { MORPH_MS } from '../src/components/ui/MorphText.tsx';

for (const id of ['codex-chat', 'claude-chat', 'acp:gemini:chat']) {
  test(`${id}: the generated title crossfades in, and the name shimmers only while the chat works`, async () => {
    reset();
    const chat = thread(id, { name: 'fix the login bug', status: { type: 'idle' } }) as Thread;
    const view = await render(h(ThreadRow, { thread: chat, active: false }));
    const label = () => view.$('.side-row-label');
    try {
      // the first render does not animate
      assert.equal(label().querySelector('.morph-text')?.textContent, 'fix the login bug');
      assert.equal(label().querySelector('.morph-out'), null);
      assert.equal(label().querySelector('.shimmer-text'), null);
      await update({ ...getState(), sessions: { [id]: { rev: 1, turn: 'running' } } });
      assert.equal(label().querySelector('.shimmer-text')?.textContent, 'fix the login bug');
      // the title arrives while it works: the old name leaves, the new one enters, still shimmering
      await act(async () => view.root.render(h(ThreadRow, { thread: { ...chat, name: 'Login bug' }, active: false })));
      assert.equal(label().querySelector('.morph-out')?.textContent, 'fix the login bug');
      assert.equal(label().querySelector('.morph-enter .shimmer-text')?.textContent, 'Login bug');
      // the crossfade settles: only the new name is left
      await act(() => new Promise((r) => setTimeout(r, MORPH_MS + 20)));
      assert.equal(label().querySelector('.morph-out'), null);
      assert.equal(label().querySelector('.morph-enter'), null);
      assert.equal(label().textContent, 'Login bug');
      await update({ ...getState(), sessions: { [id]: { rev: 2, turn: 'idle' } } });
      assert.equal(label().querySelector('.shimmer-text'), null);
      assert.equal(label().textContent, 'Login bug');
    } finally {
      await view.unmount();
    }
  });
}
