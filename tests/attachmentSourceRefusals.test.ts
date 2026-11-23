// File, plan and transcript attachment callers must keep their source UI and avoid success claims when admission refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, useRef } from 'react';
import { autoMock, mockStore, resetStore, setStore, render, settle, callsTo, stubComponent, window } from './support/thread-kit.ts';
let calls = 0;
mockStore({ setDraft: (id: string, draft: unknown) => setStore((s: any) => ({ drafts: { ...s.drafts, [id]: draft } })) });
autoMock('src/session/composerAttach.ts', 'attachments', {
  attachToComposer: () => {
    calls++;
    return false;
  },
});
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown') });
autoMock('src/components/panels/DiffPanel.tsx', 'diff', { LangIcon: () => null });
autoMock('src/components/ui/FileMenu.tsx', 'files', { useFileMenu: (_: string, o: any) => ({ trigger: {}, menu: o.extra }) });
autoMock('src/components/ui/Popover.tsx', 'popover', {
  Tooltip: (p: any) => p.children,
  MenuItem: (p: any) => h('button', { onClick: p.onSelect }, p.children),
});
autoMock('src/session/open.ts', 'open');
autoMock('src/store/plans/pane.ts', 'plans');
autoMock('src/lib/messageSelection.ts', 'selection', { messageBodyRange: (r: any) => r });
autoMock('src/lib/selectionAnchor.ts', 'anchor', { selectionSource: () => undefined, selectionRange: () => null });
const { PlanPanel } = await import('../src/components/panels/PlanPanel.tsx');
const { ChangesFileHead } = await import('../src/components/panels/ChangesFileHead.tsx');
const { SelectionToolbar } = await import('../src/components/thread/SelectionToolbar.tsx');
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const button = (host: ParentNode, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!;
test('a refused plan line does not create an editor or draft attachment', async () => {
  resetStore({
    threads: { c: { cwd: '/c' } },
    runtime: { c: { turns: [{ id: 't', status: 'completed', items: [{ type: 'plan', id: 'p', text: 'Do this' }] }] } },
  });
  useSessions.setState({ sessions: { c: { ...EMPTY_SESSION, rev: 1 } } });
  const m = await render(h(PlanPanel, { threadId: 'c' }));
  try {
    await settle(() => button(m.host, 'Comment on lines').click());
    const before = calls;
    await settle(() => button(m.host, 'Comment on plan line 1').click());
    assert.equal(calls, before + 1);
    assert.equal(m.$('input'), null);
  } finally {
    await m.unmount();
  }
});
test('a refused file context action does not announce attachment success', async () => {
  resetStore({});
  const m = await render(
    h(ChangesFileHead, {
      file: { path: '/c/file.txt', added: 1, removed: 0 } as any,
      cwd: '/c',
      chatId: 'c',
      expanded: true,
      viewed: null,
      whitespaceOnly: false,
      openLabel: 'Open file',
      onToggle() {},
      onViewed() {},
    }),
  );
  try {
    const before = calls;
    await settle(() => button(m.host, 'Attach as context').click());
    assert.equal(calls, before + 1);
    assert.equal(
      callsTo('store:toast').some((a) => String(a[0]).startsWith('Attached ')),
      false,
    );
  } finally {
    await m.unmount();
  }
});
test('a refused transcript quote leaves its source selection without opening an annotation editor', async () => {
  resetStore({ drafts: {} });
  Object.defineProperty(globalThis, 'DOMRect', { configurable: true, value: window.DOMRect });
  const priorFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => {
    fn(0);
    return 1;
  };
  const priorRects = window.Range.prototype.getClientRects;
  window.Range.prototype.getClientRects = function () {
    return [new window.DOMRect(100, 100, 100, 20)] as any;
  };
  function Quote() {
    const ref = useRef<HTMLDivElement>(null);
    return h(
      'div',
      {
        ref: (el: HTMLDivElement | null) => {
          ref.current = el;
          if (el) el.getBoundingClientRect = () => new window.DOMRect(0, 0, 800, 600);
        },
      },
      h('div', { className: 'md', 'data-source': 'quote' }, 'Selected words'),
      h(SelectionToolbar, { threadId: 'c', containerRef: ref }),
    );
  }
  const m = await render(h(Quote));
  try {
    const text = m.$('.md')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range as any);
    await settle(() => document.dispatchEvent(new window.Event('selectionchange') as any));
    const before = calls;
    await settle(() => button(document, 'Reply').click());
    assert.equal(calls, before + 1);
    assert.equal(document.querySelector('.annotation-comment-input'), null);
    assert.equal(window.getSelection()!.toString(), 'Selected');
  } finally {
    await m.unmount();
    globalThis.requestAnimationFrame = priorFrame;
    window.Range.prototype.getClientRects = priorRects;
  }
});
