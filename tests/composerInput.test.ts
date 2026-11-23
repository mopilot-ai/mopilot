import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { sessionToken } from '../src/lib/sessionMentions.ts';
import { tabToken } from '../shared/tabMentions.mjs';
import type { Attachment } from '../src/store/types.ts';

const opened: string[] = [];
mock.module('../src/components/markdown/SkillLink.tsx', {
  namedExports: { openSkill: (p: string) => opened.push('skill:' + p) },
});
mock.module('../src/session/open.ts', { namedExports: { openPath: (p: string) => opened.push('file:' + p) } });
const { createElement, createRef, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ComposerInput } = await import('../src/components/composer/ComposerInput.tsx');
const skill: Attachment = { kind: 'skill', name: 'ut-pr-merge', displayName: 'UT → PR → main', path: '/skills/ut-pr-merge/SKILL.md' };
const file: Attachment = { kind: 'file', name: 'README.md', path: '/repo/README.md' };

test('session token opens its stable chat and offers explicit sending without changing the draft', async () => {
  const token = sessionToken('stable-B', 'Same title');
  const actions: string[] = [];
  const m = await mount(`Ask ${token} to review`, [], {
    onSessionOpen: (id: string) => actions.push(`open:${id}`),
    onSessionSend: (id: string) => actions.push(`send:${id}`),
  });
  try {
    const mention = m.el.querySelector('[data-session-token]')!;
    await act(() => mention.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(actions, ['open:stable-B']);
    await act(() =>
      mention.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })),
    );
    const button = [...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Send message');
    assert.ok(button);
    await act(() => button.click());
    assert.deepEqual(actions, ['open:stable-B', 'send:stable-B']);
    assert.equal(m.el.value, `Ask ${token} to review`);
    assert.equal(m.host.querySelector('[role="menu"]') === null, true);
  } finally {
    await m.close();
  }
});

test('the session token menu opens the chat, closes, and is dismissed by Escape or a click elsewhere', async () => {
  const token = sessionToken('stable-B', 'Same title');
  const actions: string[] = [];
  const m = await mount(`Ask ${token} to review`, [], {
    onSessionOpen: (id: string) => actions.push(`open:${id}`),
    onSessionSend: (id: string) => actions.push(`send:${id}`),
  });
  const openMenu = () =>
    act(() =>
      m.el
        .querySelector('[data-session-token]')!
        .dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })),
    );
  const menu = () => m.host.querySelector('[role="menu"]') as HTMLElement | null;
  const item = (text: string) => [...menu()!.querySelectorAll('button')].find((b) => b.textContent === text)!;
  try {
    await openMenu();
    assert.equal(menu()!.style.left, '5px');
    await act(() => item('Open chat').click());
    assert.deepEqual(actions, ['open:stable-B']);
    assert.equal(menu(), null);
    await openMenu();
    await act(() => item('Close').click());
    assert.equal(menu(), null);
    // other keys and presses inside the menu keep it; Escape or a press elsewhere dismisses it
    await openMenu();
    await act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }) as any));
    await act(() => item('Close').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any));
    assert.ok(menu());
    await act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }) as any));
    assert.equal(menu(), null);
    await openMenu();
    await act(() => document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any));
    assert.equal(menu(), null);
    assert.deepEqual(actions, ['open:stable-B']);
    assert.equal(m.el.value, `Ask ${token} to review`);
  } finally {
    await m.close();
  }
});

async function mount(value = '', attachments: Attachment[] = [], extra: Record<string, any> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const ref = createRef<any>();
  let state = { value, attachments };
  const changes: { value: string; attachments: Attachment[]; caret: number }[] = [];
  const render = () =>
    root.render(
      createElement(ComposerInput, {
        ref,
        ...state,
        placeholder: 'Do anything',
        disabled: false,
        hidden: false,
        onKeyDown() {},
        onPaste() {},
        onSelect() {},
        ...extra,
        onChange(value, attachments, caret) {
          changes.push({ value, attachments, caret });
          state = { value, attachments };
          render();
        },
      }),
    );
  await act(render);
  return {
    host,
    ref,
    changes,
    get el() {
      return ref.current as any;
    },
    get state() {
      return state;
    },
    async update(value: string, attachments: Attachment[]) {
      state = { value, attachments };
      await act(render);
    },
    async input() {
      await act(() => ref.current.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })));
    },
    async close() {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

test('placeholder is present only in an empty editor, including after the final skill is deleted', async () => {
  const m = await mount();
  try {
    assert.equal(m.el.dataset.placeholder, 'Do anything');
    await m.update('', [skill]);
    assert.equal(m.el.dataset.placeholder, '');
    assert.equal(m.el.textContent, skill.displayName);
    assert.equal(m.el.value, '');
    m.el.querySelector('[data-skill-id]').remove();
    await m.input();
    assert.deepEqual(m.state.attachments, [] as any[]);
    assert.equal(m.el.dataset.placeholder, 'Do anything');
  } finally {
    await m.close();
  }
});

test('native token deletion removes only that occurrence and preserves prompt text and file attachments', async () => {
  const m = await mount(' investigate', [file, skill, { ...skill }]);
  try {
    m.el.querySelector('[data-skill-id]').remove();
    await m.input();
    assert.equal(m.state.value, ' investigate');
    assert.equal(m.state.attachments.length, 2);
    assert.deepEqual(m.state.attachments[0], file);
    assert.equal(m.state.attachments[1].name, skill.name);
    assert.equal(m.state.attachments[1].textOffset, 0);
    assert.equal(m.el.querySelectorAll('[data-skill-id]').length, 1);
  } finally {
    await m.close();
  }
});

test('select-all deletion clears text and skills together while keeping the file tray intact', async () => {
  const m = await mount(' fix this', [file, skill]);
  try {
    // Browser editing is the boundary: apply its DOM mutation, then exercise the real input handler.
    m.el.replaceChildren();
    await m.input();
    assert.equal(m.state.value, '');
    assert.deepEqual(m.state.attachments, [file]);
    assert.equal(m.el.dataset.placeholder, 'Do anything');
  } finally {
    await m.close();
  }
});

test('undo can restore a deleted skill using its original invocation identity', async () => {
  const m = await mount(' hi', [skill]);
  try {
    const token = m.el.querySelector('[data-skill-id]');
    token.remove();
    await m.input();
    assert.deepEqual(m.state.attachments, [] as any[]);
    m.el.prepend(token);
    await m.input();
    assert.equal(m.state.attachments[0].name, skill.name);
    assert.equal(m.state.attachments[0].path, skill.path);
    assert.equal(m.state.value, ' hi');
  } finally {
    await m.close();
  }
});

test('typing before a skill updates its position without rebuilding the DOM or losing the caret', async () => {
  const m = await mount(' after', [skill]);
  try {
    m.el.focus();
    const token = m.el.querySelector('[data-skill-id]');
    const text = document.createTextNode('before ');
    m.el.insertBefore(text, token);
    const range = document.createRange();
    range.setStart(text, 7);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range as any);
    await m.input();
    assert.equal(m.state.value, 'before  after');
    assert.equal(m.state.attachments[0].textOffset, 7);
    assert.equal(m.el.querySelector('[data-skill-id]'), token);
    assert.equal(m.el.selectionStart, 7);
    assert.equal(m.changes.at(-1)?.caret, 7);
  } finally {
    await m.close();
  }
});

test('line breaks and consecutive empty lines survive browser-created blocks and draft restoration', async () => {
  const m = await mount();
  try {
    m.el.innerHTML = 'first<div><br></div><div>third</div><div><br></div>';
    await m.input();
    assert.equal(m.state.value, 'first\n\nthird\n');
    await m.update('restored\n\ntext', []);
    assert.equal(m.el.value, 'restored\n\ntext');
    m.el.focus();
    m.el.setSelectionRange(11, 11);
    assert.equal(m.el.selectionStart, 11);
  } finally {
    await m.close();
  }
});

test('IME edits commit after composition ends without replacing the composing nodes', async () => {
  const m = await mount('', [skill]);
  try {
    const token = m.el.querySelector('[data-skill-id]');
    await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
    m.el.append(document.createTextNode('中文'));
    await m.input();
    assert.equal(m.changes.length, 0);
    assert.equal(m.el.querySelector('[data-skill-id]'), token);
    await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    assert.equal(m.state.value, '中文');
    assert.equal(m.state.attachments[0].name, skill.name);
  } finally {
    await m.close();
  }
});

test('IME marked text hides the empty-editor placeholder before the draft changes', async () => {
  const m = await mount();
  try {
    m.el.focus();
    assert.equal(m.el.dataset.placeholder, 'Do anything');
    await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
    assert.equal(m.el.dataset.placeholder, '');
    const marked = document.createTextNode('SD');
    m.el.append(marked);
    await m.input();
    assert.equal(m.state.value, '');
    assert.equal(m.el.dataset.placeholder, '');
    assert.equal(m.el.lastChild, marked);
    marked.textContent = '收到';
    await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    assert.equal(m.state.value, '收到');
    assert.equal(m.el.dataset.placeholder, '');
    m.el.replaceChildren();
    await m.input();
    assert.equal(m.el.dataset.placeholder, 'Do anything');
  } finally {
    await m.close();
  }
});

test('cancelling IME composition restores the placeholder and allows another composition', async () => {
  const m = await mount();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
      assert.equal(m.el.dataset.placeholder, '');
      await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
      assert.equal(m.state.value, '');
      assert.equal(m.el.dataset.placeholder, 'Do anything');
    }
  } finally {
    await m.close();
  }
});

test('blur releases IME suppression and preserves any marked text before restoring a draft', async () => {
  for (const markedText of ['', '中文']) {
    const m = await mount();
    try {
      m.el.focus();
      await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
      m.el.append(document.createTextNode(markedText));
      await act(() => m.el.blur());
      assert.equal(m.state.value, markedText);
      assert.equal(m.el.dataset.placeholder, markedText ? '' : 'Do anything');
      await m.update('another draft', [skill]);
      assert.equal(m.el.value, 'another draft');
      await m.update('', []);
      assert.equal(m.el.dataset.placeholder, 'Do anything');
      m.el.focus();
      const before = m.changes.length;
      await act(() => m.el.blur());
      assert.equal(m.changes.length, before);
    } finally {
      await m.close();
    }
  }
});

test('idle Escape blurs without deleting; a popup or running-turn handler can consume it first', async () => {
  for (const consumed of [false, true]) {
    const m = await mount('', [skill], {
      onKeyDown(e: any) {
        if (consumed) e.preventDefault();
      },
    });
    try {
      m.el.focus();
      await act(() => m.el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      assert.equal(document.activeElement === m.el, consumed);
      assert.equal(m.el.querySelectorAll('[data-skill-id]').length, 1);
      assert.equal(m.changes.length, 0);
    } finally {
      await m.close();
    }
  }
});

test('a disabled editor cannot edit but stays focusable (#1658), and voice mode hides the entire inline editor', async () => {
  const m = await mount('', [skill], { disabled: true, hidden: true });
  try {
    assert.equal(m.el.getAttribute('contenteditable'), 'true');
    assert.equal(m.el.getAttribute('aria-disabled'), 'true');
    assert.equal(m.el.classList.contains('voice-hidden'), true);
  } finally {
    await m.close();
  }
});

test('switching drafts keeps each skill at its text offset and handles duplicate invocation paths', async () => {
  const m = await mount('one two', [{ ...skill, textOffset: 4 }]);
  try {
    assert.equal(m.el.textContent, 'one ' + skill.displayName + 'two');
    await m.update('other', [file, { ...skill, textOffset: 0 }, { ...skill, textOffset: 5 }]);
    assert.equal(m.el.value, 'other');
    assert.equal(m.el.querySelectorAll('[data-skill-id]').length, 2);
    assert.equal(m.el.textContent, skill.displayName + 'other' + skill.displayName);
    assert.equal(m.el.textContent.includes(file.name), false);
  } finally {
    await m.close();
  }
});

test('skill clicks open details; modifier-clicks preserve the upstream open-file behavior', async () => {
  const m = await mount('', [skill]);
  try {
    opened.length = 0;
    const label = m.el.querySelector('[data-skill-id] > span:last-child');
    await act(() => label.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await act(() => label.dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: true })));
    assert.deepEqual(opened, ['skill:' + skill.path, 'file:' + skill.path]);
  } finally {
    await m.close();
  }
});

test('Enter is delegated to the send handler and can prevent insertion of a newline', async () => {
  let enterCount = 0;
  const m = await mount('hello', [skill], {
    onKeyDown(e: any) {
      if (e.key === 'Enter') {
        enterCount++;
        e.preventDefault();
      }
    },
  });
  try {
    const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(() => m.el.dispatchEvent(event));
    assert.equal(enterCount, 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(m.el.value, 'hello');
  } finally {
    await m.close();
  }
});

test('pasted markup is inserted as plain text; file paste handled by the attachment boundary is left alone', async () => {
  const inserted: unknown[][] = [];
  (document as any).execCommand = (...args: unknown[]) => {
    inserted.push(args);
    return true;
  };
  for (const filePaste of [false, true]) {
    const m = await mount('', [], {
      onPaste(e: any) {
        if (filePaste) e.preventDefault();
      },
    });
    try {
      const data = new window.DataTransfer();
      data.setData('text/plain', 'literal <span>text</span>');
      data.setData('text/html', '<span data-skill-id="forged">text</span>');
      const event = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      await act(() => m.el.dispatchEvent(event));
      assert.equal(event.defaultPrevented, true);
    } finally {
      await m.close();
    }
  }
  assert.deepEqual(inserted, [['insertText', false, 'literal <span>text</span>']]);
});

test('a session token displays its escaped title atomically and retains the serialized id in the prompt', async () => {
  const title = '<img src=x> [中文]';
  const token = sessionToken('chat:id', title);
  const m = await mount('Compare ' + token + ' please', [file, { ...skill, textOffset: 0 }]);
  try {
    const chip = m.el.querySelector('[data-session-token]');
    assert.equal(chip.textContent, title);
    assert.equal(chip.contentEditable, 'false');
    assert.equal(chip.querySelector('img') === null, true);
    assert.equal(m.el.value, 'Compare ' + token + ' please');
    assert.equal(m.el.querySelectorAll('[data-skill-id]').length, 1);
    assert.equal(m.el.querySelectorAll('[data-session-token]').length, 1);
  } finally {
    await m.close();
  }
});

test('native session deletion clears one complete reference while keeping skills and files', async () => {
  const token = sessionToken('chat', 'Other chat');
  const m = await mount(token + ' ' + token + ' compare', [file, skill]);
  try {
    m.el.querySelector('[data-session-token]').remove();
    await m.input();
    assert.equal(m.state.value, ' ' + token + ' compare');
    assert.equal(m.el.querySelectorAll('[data-session-token]').length, 1);
    assert.equal(m.state.attachments.length, 2);
    assert.equal(m.state.attachments[0], file);
    assert.equal(m.state.attachments[1].name, skill.name);
    assert.equal(m.state.attachments[1].textOffset, 0);
  } finally {
    await m.close();
  }
});

test('draft changes restore serialized session references alongside skill offsets and multiline text', async () => {
  const token = sessionToken('chat', 'Other chat');
  const m = await mount('first', [skill]);
  try {
    await m.update('line one\n' + token + '\nline three', [{ ...skill, textOffset: 9 }]);
    assert.equal(m.el.value, 'line one\n' + token + '\nline three');
    assert.equal(m.el.querySelector('[data-session-token]').textContent, 'Other chat');
    assert.equal(m.el.querySelectorAll('[data-skill-id]').length, 1);
    await m.update('first', [skill]);
    assert.equal(m.el.querySelector('[data-session-token]') === null, true);
    assert.equal(m.el.value, 'first');
  } finally {
    await m.close();
  }
});

test('caret offsets count the full serialized reference and placement cannot enter its label', async () => {
  const token = sessionToken('chat', 'Other chat');
  const m = await mount('before ' + token + ' after');
  try {
    m.el.focus();
    m.el.setSelectionRange(7, 7);
    assert.equal(m.el.selectionStart, 7);
    m.el.setSelectionRange(7 + token.length, 7 + token.length);
    assert.equal(m.el.selectionStart, 7 + token.length);
    m.el.setSelectionRange(8, 8);
    assert.equal(m.el.selectionStart, 7 + token.length);
    assert.equal(window.getSelection()!.anchorNode, m.el);
  } finally {
    await m.close();
  }
});

test('copying a selected session preserves its serialized reference for paste into another draft', async () => {
  const token = sessionToken('chat', 'Other chat');
  const m = await mount('before ' + token + ' after');
  try {
    m.el.focus();
    m.el.setSelectionRange(7, 7 + token.length);
    const data = new window.DataTransfer();
    await act(() => m.el.dispatchEvent(new window.ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })));
    assert.equal(data.getData('text/plain'), token);
  } finally {
    await m.close();
  }
});

test('choosing a chat replaces the typed query with an atomic token through the native undo boundary', async () => {
  const token = sessionToken('chat', 'Other chat');
  const m = await mount('compare @Other');
  try {
    const inserted: string[] = [];
    (document as any).execCommand = (command: string, _ui: boolean, html: string) => {
      assert.equal(command, 'insertHTML');
      inserted.push(html);
      const range = window.getSelection()!.getRangeAt(0);
      range.deleteContents();
      const fragment = range.createContextualFragment(html);
      const last = fragment.lastChild!;
      range.insertNode(fragment);
      range.setStartAfter(last);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      return true;
    };
    await act(() => m.el.replaceRange(8, 14, token + ' '));
    assert.equal(m.state.value, 'compare ' + token + ' ');
    assert.equal(m.el.querySelector('[data-session-token]').textContent, 'Other chat');
    assert.equal(inserted.length, 1);
  } finally {
    await m.close();
  }
});

// happy-dom does not implement browser editing commands; mock only that boundary.
function mockDeleteCommand() {
  const calls: string[] = [];
  const deleted: DocumentFragment[] = [];
  const original = document.execCommand;
  (document as any).execCommand = (command: string) => {
    calls.push(command);
    const range = window.getSelection()!.getRangeAt(0);
    deleted.push((range as any).extractContents());
    range.collapse(true);
    return true;
  };
  return {
    calls,
    deleted,
    restore() {
      document.execCommand = original;
    },
  };
}

function selectCaret(node: Node, offset: number, end = offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range as any);
}

async function press(m: Awaited<ReturnType<typeof mount>>, key: string, options: Record<string, any> = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await act(() => m.el.dispatchEvent(event));
  return event;
}

test('Mac Delete (Backspace) removes a sole inline skill across empty caret hosts and restores the placeholder', async () => {
  for (const containerCaret of [false, true]) {
    const m = await mount('', [file, skill]);
    const command = mockDeleteCommand();
    try {
      m.el.focus();
      selectCaret(containerCaret ? m.el : m.el.lastChild, containerCaret ? m.el.childNodes.length : 0);
      const event = await press(m, 'Backspace');
      assert.equal(event.defaultPrevented, true);
      assert.deepEqual(command.calls, ['delete']);
      assert.deepEqual(m.state.attachments, [file]);
      assert.equal(m.state.value, '');
      assert.equal(m.el.dataset.placeholder, 'Do anything');
      // Native undo restores the archived invocation, rather than turning its label into text.
      m.el.append(command.deleted[0]);
      await m.input();
      assert.equal(m.state.attachments[1].path, skill.path);
      assert.equal(m.state.value, '');
    } finally {
      command.restore();
      await m.close();
    }
  }
});

test('forward Delete removes only the adjacent duplicate skill and preserves text and files', async () => {
  const m = await mount('before after', [file, { ...skill, textOffset: 7 }, { ...skill, textOffset: 7 }]);
  const command = mockDeleteCommand();
  try {
    m.el.focus();
    selectCaret(m.el.firstChild, 7);
    assert.equal((await press(m, 'Delete')).defaultPrevented, true);
    assert.deepEqual(command.calls, ['delete']);
    assert.equal(m.state.value, 'before after');
    assert.equal(m.state.attachments.length, 2);
    assert.equal(m.state.attachments[0], file);
    assert.equal(m.state.attachments[1].textOffset, 7);
    assert.equal(m.el.querySelectorAll('[data-skill-id]').length, 1);
  } finally {
    command.restore();
    await m.close();
  }
});

test('backspace at a skill boundary removes that occurrence rather than the last attachment', async () => {
  const m = await mount('middle', [skill, { ...skill, textOffset: 6 }]);
  const command = mockDeleteCommand();
  try {
    m.el.focus();
    selectCaret(m.el.querySelector('[data-skill-id]').nextSibling, 0);
    await press(m, 'Backspace');
    assert.equal(m.state.value, 'middle');
    assert.equal(m.state.attachments.length, 1);
    assert.equal(m.state.attachments[0].textOffset, 6);
  } finally {
    command.restore();
    await m.close();
  }
});

test('normal text deletion and selected text remain with the browser', async () => {
  const m = await mount('hello', [skill]);
  const command = mockDeleteCommand();
  try {
    m.el.focus();
    selectCaret(m.el.lastChild, 3);
    assert.equal((await press(m, 'Backspace')).defaultPrevented, false);
    assert.equal((await press(m, 'Delete')).defaultPrevented, false);
    selectCaret(m.el.lastChild, 0, 3);
    assert.equal((await press(m, 'Backspace')).defaultPrevented, false);
    assert.deepEqual(command.calls, []);
    assert.equal(m.changes.length, 0);
  } finally {
    command.restore();
    await m.close();
  }
});

test('IME, modifiers, disabled editors, and consumed keys do not remove skills', async () => {
  for (const options of [
    { isComposing: true },
    { keyCode: 229 },
    { metaKey: true },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { disabled: true },
    { consumed: true },
    { composing: true },
  ]) {
    const m = await mount('', [skill], {
      disabled: !!options.disabled,
      onKeyDown(e: any) {
        if (options.consumed) e.preventDefault();
      },
    });
    const command = mockDeleteCommand();
    try {
      m.el.focus();
      selectCaret(m.el.lastChild, 0);
      if (options.composing) await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
      await press(m, 'Backspace', options);
      assert.deepEqual(command.calls, []);
      assert.equal(m.changes.length, 0);
      assert.equal(m.el.querySelectorAll('[data-skill-id]').length, 1);
    } finally {
      command.restore();
      await m.close();
    }
  }
});

test('deletion never crosses an intervening session reference, newline, or editor boundary', async () => {
  for (const text of [sessionToken('chat', 'Other'), '\n']) {
    const m = await mount(text, [skill]);
    const command = mockDeleteCommand();
    try {
      m.el.focus();
      selectCaret(m.el.lastChild, m.el.lastChild.textContent.length);
      await press(m, 'Backspace');
      assert.deepEqual(command.calls, []);
      const outside = document.createTextNode('');
      document.body.append(outside);
      selectCaret(outside, 0);
      await press(m, 'Backspace');
      outside.remove();
      assert.deepEqual(command.calls, []);
    } finally {
      command.restore();
      await m.close();
    }
  }
});

test('a browser-created block boundary keeps Backspace native instead of deleting a skill on the preceding line', async () => {
  const m = await mount('', [skill]);
  const command = mockDeleteCommand();
  try {
    const block = document.createElement('div');
    block.append(document.createTextNode('next line'));
    m.el.append(block);
    m.el.focus();
    selectCaret(block.firstChild!, 0);
    assert.equal((await press(m, 'Backspace')).defaultPrevented, false);
    assert.deepEqual(command.calls, []);
  } finally {
    command.restore();
    await m.close();
  }
});

test('when the browser command declines, the selected skill is left for native deletion', async () => {
  const m = await mount('', [skill]);
  const original = document.execCommand;
  (document as any).execCommand = () => false;
  try {
    m.el.focus();
    selectCaret(m.el.lastChild, 0);
    assert.equal((await press(m, 'Backspace')).defaultPrevented, false);
    assert.equal(window.getSelection()!.toString(), skill.displayName);
    assert.equal(m.changes.length, 0);
  } finally {
    document.execCommand = original;
    await m.close();
  }
});

test('skill deletion handles element caret offsets, nested inline wrappers, and empty caret nodes in both directions', async () => {
  for (const key of ['Backspace', 'Delete']) {
    for (const shape of ['direct', 'nested', 'empty', 'empty-wrapper', 'text-wrapper', 'br', 'root-edge', 'empty-siblings']) {
      const m = await mount('', [skill]);
      const command = mockDeleteCommand();
      try {
        m.el.focus();
        const token = m.el.querySelector('[data-skill-id]');
        m.el.replaceChildren();
        if (shape === 'direct') {
          m.el.append(token);
          selectCaret(m.el, key === 'Backspace' ? 1 : 0);
        } else if (shape === 'root-edge') {
          selectCaret(m.el, 0);
        } else if (shape === 'empty-siblings') {
          m.el.append(token, document.createTextNode(''), document.createTextNode(''));
          if (key === 'Backspace') selectCaret(m.el.lastChild, 0);
          else {
            m.el.prepend(document.createTextNode(''), document.createTextNode(''));
            selectCaret(m.el.firstChild, 0);
          }
        } else {
          const wrapper = document.createElement('span');
          if (shape === 'nested') wrapper.append(document.createTextNode(''), token, document.createTextNode(''));
          if (shape === 'empty-wrapper') wrapper.append(document.createTextNode(''));
          if (shape === 'text-wrapper') wrapper.append(document.createTextNode('text'));
          if (shape === 'br') wrapper.append(document.createElement('br'));
          if (shape === 'empty') {
            const text = document.createTextNode('');
            wrapper.append(text);
            m.el.append(token, wrapper);
            if (key === 'Delete') m.el.replaceChildren(wrapper, token);
            selectCaret(text, 0);
          } else {
            m.el.append(wrapper);
            selectCaret(m.el, key === 'Backspace' ? 1 : 0);
          }
        }
        const removes = ['direct', 'nested', 'empty', 'empty-siblings'].includes(shape);
        assert.equal((await press(m, key)).defaultPrevented, removes, `${key}:${shape}`);
        assert.equal(command.calls.length, removes ? 1 : 0, `${key}:${shape}`);
      } finally {
        command.restore();
        await m.close();
      }
    }
  }
});

test('missing DOM selections leave deletion with the browser', async () => {
  const m = await mount('', [skill]);
  const original = window.getSelection;
  try {
    window.getSelection()!.removeAllRanges();
    await press(m, 'Backspace');
    (window as any).getSelection = () => null;
    assert.equal((await press(m, 'Backspace')).defaultPrevented, false);
    assert.equal(m.changes.length, 0);
  } finally {
    window.getSelection = original;
    await m.close();
  }
});

test('a browser tab token is an atomic chip beside chat tokens, named by its title with its address in the tooltip', async () => {
  const tab = tabToken({ where: 'chrome', title: 'Mail <b>', url: 'https://mail.test/', tabId: '9' });
  const chat = sessionToken('chat', 'Other chat');
  const opened: string[] = [];
  const m = await mount(`Read ${tab} and ${chat}`, [], {
    onSessionOpen: (id: string) => opened.push(id),
    onSessionSend: () => opened.push('send'),
  });
  try {
    const chips = [...m.el.querySelectorAll('[data-session-token]')];
    assert.deepEqual(
      chips.map((c: any) => [c.className, c.textContent, c.title]),
      [
        ['composer-session-token composer-tab-token', 'Mail <b>', 'Mail <b>\nhttps://mail.test/'],
        ['composer-session-token', 'Other chat', 'Other chat'],
      ],
    );
    assert.equal(m.el.querySelector('b') === null, true);
    assert.equal(m.el.value, `Read ${tab} and ${chat}`);
    // a tab chip opens no chat and offers no chat menu
    await act(() => chips[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await act(() => chips[0].dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    assert.deepEqual(opened, []);
    assert.equal(m.host.querySelector('[role="menu"]') === null, true);
  } finally {
    await m.close();
  }
});

test('pasting text that holds a tab token inserts it as a chip', async () => {
  const inserted: unknown[][] = [];
  (document as any).execCommand = (...args: unknown[]) => {
    inserted.push(args);
    return true;
  };
  const tab = tabToken({ where: 'app', title: 'Preview', url: 'http://localhost:5173/', tabId: 't1' });
  const m = await mount('');
  try {
    const data = new window.DataTransfer();
    data.setData('text/plain', `see ${tab}`);
    await act(() => m.el.dispatchEvent(new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })));
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0][0], 'insertHTML');
    assert.match(
      String(inserted[0][2]),
      /^see <span class="composer-session-token composer-tab-token" data-session-token=".*" contenteditable="false" title="Preview\nhttp:\/\/localhost:5173\/">Preview<\/span>$/s,
    );
  } finally {
    await m.close();
  }
});
