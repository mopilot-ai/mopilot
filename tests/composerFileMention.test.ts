// src/components/composer/ComposerInput.tsx: an `@path` from the @ menu is one atomic accent chip that serializes back to the
// text the harness reads; names and mail stay text, and chat and tab tokens keep their own chips beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { sessionToken } from '../src/lib/sessionMentions.ts';
import { tabToken } from '../shared/tabMentions.mjs';

const { createElement, createRef, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ComposerInput, references } = await import('../src/components/composer/ComposerInput.tsx');

async function mount(value: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const ref = createRef<any>();
  let state = value;
  const render = () =>
    root.render(
      createElement(ComposerInput, {
        ref,
        value: state,
        attachments: [],
        placeholder: 'Do anything',
        disabled: false,
        hidden: false,
        onKeyDown() {},
        onPaste() {},
        onSelect() {},
        onChange(next: string) {
          state = next;
          render();
        },
      }),
    );
  await act(render);
  return {
    get el() {
      return ref.current as any;
    },
    get value() {
      return state;
    },
    async close() {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

test('a draft naming a file shows it as one uneditable chip holding the @path, and reads back as written', async () => {
  const m = await mount('@Design1_MenggeWang.pdf 看看这个');
  try {
    const chip = m.el.querySelector('.composer-file-token') as HTMLElement;
    assert.ok(chip);
    assert.equal(chip.textContent, '@Design1_MenggeWang.pdf');
    assert.equal(chip.contentEditable, 'false');
    assert.equal(chip.dataset.sessionToken, '@Design1_MenggeWang.pdf');
    assert.equal(chip.dataset.filePath, 'Design1_MenggeWang.pdf');
    assert.equal(chip.title, 'Design1_MenggeWang.pdf');
    assert.equal(m.el.value, '@Design1_MenggeWang.pdf 看看这个');
  } finally {
    await m.close();
  }
});

test('picking a file from the @ menu inserts the chip through the editor, caret after it', async () => {
  const m = await mount('read @Des');
  const original = document.execCommand;
  try {
    (document as any).execCommand = (command: string, _ui: boolean, html: string) => {
      assert.equal(command, 'insertHTML');
      const range = window.getSelection()!.getRangeAt(0);
      range.deleteContents();
      const fragment = range.createContextualFragment(html);
      const last = fragment.lastChild!;
      range.insertNode(fragment);
      range.setStartAfter(last);
      range.collapse(true);
      return true;
    };
    await act(() => m.el.replaceRange(5, 9, '@docs/Design.pdf '));
    assert.equal(m.value, 'read @docs/Design.pdf ');
    assert.equal(m.el.querySelector('.composer-file-token').textContent, '@docs/Design.pdf');
    assert.equal(m.el.selectionStart, 'read @docs/Design.pdf '.length);
  } finally {
    document.execCommand = original;
    await m.close();
  }
});

test('names, mail and versions stay text; chat and tab tokens keep their own chips beside a file', async () => {
  const chat = sessionToken('c2', 'Other chat');
  const tab = tabToken({ where: 'app', title: 'Docs @a.ts', url: 'https://x.test', tabId: '1' });
  const text = `ask @john.doe at me@x.com about @v1.2, ${chat} ${tab} and @src/a.ts`;
  const m = await mount(text);
  try {
    assert.deepEqual(
      [...m.el.querySelectorAll('[data-session-token]')].map((n: any) => n.className),
      ['composer-session-token', 'composer-session-token composer-tab-token', 'composer-file-token'],
    );
    assert.equal(m.el.querySelector('.composer-file-token').textContent, '@src/a.ts');
    assert.equal(m.el.value, text);
  } finally {
    await m.close();
  }
  assert.deepEqual(
    references(text).map((r) => r.kind),
    ['chat', 'tab', 'file'],
  );
});
