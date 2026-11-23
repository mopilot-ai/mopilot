// Relocated session utilities remain available in the chat header across all harnesses and follow main's lineage.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { click, render, popoverExports, byText } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
import type { Thread } from '../src/store/types.ts';
let children: Record<string, any> = {};
const calls: unknown[][] = [];
let fails = false;
stubStore({
  useStore: () => ({}),
  openPaneTab: () => {},
  toast: () => {},
  toastFailure: (what: string) => (error: Error) => calls.push(['error', what, error.message]),
});
installNativeStub({
  shell: {
    reveal: async (path: string) => {
      calls.push(['reveal', path]);
    },
  },
  orchestration: {
    child: async (...args: unknown[]) => {
      calls.push(args);
      if (fails) throw new Error('busy');
      return { detached: true };
    },
  },
});
mock.module('../src/lib/sideSessions.ts', { namedExports: { useOrchestration: () => ({ children }) } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
const { ChatUtilityItems } = await import('../src/components/titleBar/ChatUtilityItems.tsx');

test('header utilities reveal a saved file and detach linked chats without optimistic lineage edits', async () => {
  for (const id of ['codex/chat', 'claude-chat', 'acp:gemini:chat']) {
    calls.length = 0;
    fails = false;
    children = {};
    const thread = { id } as Thread;
    const view = await render(h(ChatUtilityItems, { thread }));
    assert.equal(view.host.textContent, '');
    children = { [id]: { parentId: 'parent' } };
    await view.rerender(h(ChatUtilityItems, { thread: { ...thread, path: '/saved/session.jsonl' } }));
    await click(byText(view.host, 'Reveal session file'));
    await click(byText(view.host, 'Detach to top level'));
    assert.deepEqual(calls, [
      ['reveal', '/saved/session.jsonl'],
      [id, 'detach'],
    ]);
    assert.equal(children[id].detached, undefined);
    fails = true;
    await click(byText(view.host, 'Detach to top level'));
    assert.deepEqual(calls.at(-1), ['error', "Couldn't detach the session. Try again.", 'busy']);
    children = { [id]: { detached: true } };
    await view.rerender(h(ChatUtilityItems, { thread: { ...thread, path: '/saved/session.jsonl' } }));
    assert.equal(view.host.textContent?.includes('Detach to top level'), false);
    await view.unmount();
  }
});
