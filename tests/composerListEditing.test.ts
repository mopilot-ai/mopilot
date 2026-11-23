// Composer keyboard list commands retain ownership, native history and send/menu precedence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { editComposerList, startComposerList } from '../src/lib/composerLists.ts';
import { act, mount } from './support/composer-list-editor.ts';
import { insertHTML } from './support/composer-dom.ts';

/** Model only the native mutation boundary; real Chromium splitting, nesting and undo run in the focused E2E. */
function nativeCommands(refuse = '') {
  const original = document.execCommand;
  const calls: string[] = [];
  document.execCommand = ((command: string, _ui: boolean, value: string) => {
    calls.push(command);
    if (command === refuse) return false;
    if (command === 'insertHTML') return insertHTML(command, _ui, value);
    return true;
  }) as any;
  return {
    calls,
    restore() {
      document.execCommand = original;
    },
  };
}

test('typing a list marker converts it and retains the requested starting number or bullet', async () => {
  for (const marker of ['1. ', '9. ', '- ', '* ', '+ ']) {
    const m = await mount();
    const commands = nativeCommands();
    try {
      m.el.textContent = marker;
      m.el.focus();
      m.el.setSelectionRange(marker.length, marker.length);
      await m.input();
      assert.deepEqual(commands.calls, ['insertHTML']);
      assert.equal(m.text, marker);
      assert.equal(m.el.selectionStart, marker.length);
    } finally {
      commands.restore();
      await m.close();
    }
  }
});

test('conversion leaves literal input, code, selections, chips, IME and disabled drafts alone', async () => {
  for (const text of ['plain', '1. body', '  1. ', '```\n1. ', '\\1. ', '01. ', '1.\t']) {
    const m = await mount();
    const commands = nativeCommands();
    try {
      m.el.textContent = text;
      m.el.focus();
      m.el.setSelectionRange(text.length, text.length);
      assert.equal(startComposerList(m.el), false, text);
      assert.deepEqual(commands.calls, []);
    } finally {
      commands.restore();
      await m.close();
    }
  }
  for (const extra of [{ disabled: true }, {}]) {
    const m = await mount('', [], extra);
    const commands = nativeCommands();
    try {
      m.el.textContent = '1. ';
      m.el.focus();
      m.el.setSelectionRange(3, 3);
      if (!extra.disabled) await act(() => m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
      await m.input();
      assert.deepEqual(commands.calls, []);
    } finally {
      commands.restore();
      await m.close();
    }
  }
  const m = await mount();
  const commands = nativeCommands();
  try {
    window.getSelection()!.removeAllRanges();
    assert.equal(startComposerList(m.el), false);
    m.el.textContent = '1. ';
    m.el.focus();
    m.el.setSelectionRange(0, 3);
    assert.equal(startComposerList(m.el), false);
    m.el.innerHTML = '<pre>1. </pre>';
    m.el.setSelectionRange(3, 3);
    assert.equal(startComposerList(m.el), false);
    assert.deepEqual(commands.calls, []);
  } finally {
    commands.restore();
    await m.close();
  }
});

test('a declined native conversion retains the literal marker for retry', async () => {
  const m = await mount();
  const commands = nativeCommands('insertHTML');
  try {
    m.el.textContent = '1. ';
    m.el.focus();
    m.el.setSelectionRange(3, 3);
    assert.equal(startComposerList(m.el), false);
    assert.equal(m.el.value, '1. ');
    assert.equal(m.el.selectionStart, 3);
    assert.equal(window.getSelection()!.isCollapsed, true);
  } finally {
    commands.restore();
    await m.close();
  }
});

test('a native false result after inserting a skill glyph still retains the applied edit and caret', async () => {
  const m = await mount('Existing', [{ kind: 'skill', name: 'Review', path: '/review/SKILL.md', textOffset: 8 }]);
  const commands = nativeCommands();
  const mutate = document.execCommand;
  document.execCommand = ((...args: Parameters<typeof mutate>) => {
    mutate(...args);
    return false;
  }) as typeof mutate;
  try {
    m.el.firstChild.data = '1. Existing';
    window.getSelection()!.collapse(m.el.firstChild, 3);
    assert.equal(startComposerList(m.el), true);
    assert.equal(m.el.value, '1. Existing');
    assert.equal(m.el.selectionStart, 3);
    assert.ok(m.el.querySelector('li .composer-skill svg'));
  } finally {
    commands.restore();
    await m.close();
  }
});

test('prefixing existing text wraps the full line and keeps its skill, glyph, reference and insertion caret', async () => {
  const m = await mount('Existing', [{ kind: 'skill', name: 'Review', path: '/review/SKILL.md', textOffset: 8 }]);
  const commands = nativeCommands();
  try {
    const skillId = m.el.querySelector('[data-skill-id]').dataset.skillId;
    const text = m.el.firstChild;
    text.data = '1. Existing';
    window.getSelection()!.collapse(text, 3);
    assert.equal(startComposerList(m.el), true);
    assert.equal(m.el.value, '1. Existing');
    assert.equal(m.el.selectionStart, 3);
    assert.equal(m.el.querySelector('li [data-skill-id]').dataset.skillId, skillId);
    assert.ok(m.el.querySelector('li .composer-skill svg'), 'the cloned skill retains its rendered glyph');
    await m.input();
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].textOffset, 11);
    m.el.innerHTML = '<div>1. Before <span data-session-token="@chat" contenteditable="false">Chat</span></div><div>After</div>';
    window.getSelection()!.collapse(m.el.firstChild.firstChild, 3);
    assert.equal(startComposerList(m.el), true);
    assert.equal(m.el.value, '1. Before @chat\nAfter');
    assert.equal(m.el.querySelector('li [data-session-token]').dataset.sessionToken, '@chat');
    m.el.textContent = '1. First\nAfter';
    window.getSelection()!.collapse(m.el.firstChild, 3);
    assert.equal(startComposerList(m.el), true);
    assert.equal(m.el.value, '1. First\nAfter', 'a literal newline bounds the replaced suffix');
  } finally {
    commands.restore();
    await m.close();
  }
});

test('newline and nesting commands only apply to the current list and unconsumed keyboard input', async () => {
  const m = await mount('1. First\n2. Second');
  const commands = nativeCommands();
  const event = (key: string, options = {}) => new window.KeyboardEvent('keydown', { key, ...options }) as unknown as KeyboardEvent;
  try {
    m.el.focus();
    m.el.setSelectionRange(m.el.value.length, m.el.value.length);
    for (const options of [{}, { shiftKey: true }, { altKey: true }])
      assert.equal(editComposerList(m.el, event('Enter', options), false), true);
    assert.equal(editComposerList(m.el, event('Tab'), false), true);
    assert.equal(editComposerList(m.el, event('Tab', { shiftKey: true }), false), true);
    assert.deepEqual(commands.calls, ['insertParagraph', 'insertParagraph', 'insertParagraph', 'insertHTML', 'insertHTML']);
    for (const options of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }])
      assert.equal(editComposerList(m.el, event('Enter', options), false), false);
    assert.equal(editComposerList(m.el, event('Enter'), true), false);
    for (const key of ['Backspace', 'a']) assert.equal(editComposerList(m.el, event(key), false), false);
    assert.equal(editComposerList(m.el, event('Tab', { altKey: true }), false), false);
    await m.update('1. ');
    m.el.setSelectionRange(3, 3);
    const beforeTab = commands.calls.length;
    assert.equal(editComposerList(m.el, event('Tab'), false), true);
    assert.equal(commands.calls.length, beforeTab, 'the first item cannot nest without a parent item');
    assert.equal(editComposerList(m.el, event('Backspace'), false), true);
    assert.equal(commands.calls.at(-1), 'insertHTML');
    await m.update('1. ');
    m.el.setSelectionRange(3, 3);
    assert.equal(editComposerList(m.el, event('Backspace', { shiftKey: true }), false), false);
    assert.equal(editComposerList(m.el, event('Backspace', { altKey: true }), false), false);
    await m.update('plain');
    m.el.setSelectionRange(5, 5);
    assert.equal(editComposerList(m.el, event('Enter'), false), false);
    window.getSelection()!.removeAllRanges();
    assert.equal(editComposerList(m.el, event('Enter'), false), false);
  } finally {
    commands.restore();
    await m.close();
  }
});

test('splitting before an atomic chip removes only the newly inserted native placeholder, including after redo', async () => {
  for (const chip of [
    '<span data-skill-id="1" contenteditable="false"><svg></svg>Skill</span>',
    '<span data-session-token="@chat" contenteditable="false">Chat</span>',
  ]) {
    const m = await mount('1. First');
    const original = document.execCommand;
    let placeholder: HTMLElement;
    try {
      m.el.innerHTML = '<ol><li>First<br>Intentional</li></ol>';
      const intentional = m.el.querySelector('br');
      m.el.focus();
      m.el.setSelectionRange(8, 8);
      document.execCommand = () => {
        m.el
          .querySelector('ol')
          .insertAdjacentHTML('beforeend', `<li><br>${chip}Tail</li><li>Before<br>${chip}</li><li><br></li><li><br><b>Bold</b></li>`);
        placeholder = m.el.querySelectorAll('li')[1].firstChild;
        return true;
      };
      assert.equal(editComposerList(m.el, new window.KeyboardEvent('keydown', { key: 'Enter' }) as any, false), true);
      const item = m.el.querySelectorAll('li')[1];
      assert.equal(item.firstChild.nodeName, 'SPAN');
      assert.equal(intentional.isConnected, true);
      assert.equal(m.el.querySelectorAll('br').length, 4, 'intentional and non-chip line breaks survive');
      // Native redo restores the removed node with its transient marker, before emitting input.
      item.prepend(placeholder!);
      await m.input();
      assert.equal(item.firstChild.nodeName, 'SPAN');
      assert.equal(m.el.querySelector('[data-composer-placeholder]'), null);
      assert.ok(m.el.value.includes(chip.includes('session-token') ? '2. @chatTail' : '2. Tail'));
    } finally {
      document.execCommand = original;
      await m.close();
    }
  }
});

test('marker deletion selects only typed characters and retains a leading zero-width skill', async () => {
  const m = await mount('', [{ kind: 'skill', name: 'Review', path: '/review/SKILL.md', textOffset: 0 }]);
  const commands = nativeCommands();
  try {
    const skill = m.el.querySelector('[data-skill-id]');
    const text = document.createTextNode('1. ');
    m.el.append(text);
    window.getSelection()!.collapse(text as any, 3);
    assert.equal(startComposerList(m.el), true);
    assert.equal(m.el.querySelector('[data-skill-id]'), skill);
    assert.equal(m.el.querySelectorAll('ol').length, 1);
  } finally {
    commands.restore();
    await m.close();
  }
});

test('a marker split across native caret hosts stays literal without risking unrelated content', async () => {
  const m = await mount();
  const commands = nativeCommands();
  try {
    m.el.innerHTML = '<span>1.</span> ';
    window.getSelection()!.collapse(m.el.lastChild, 1);
    assert.equal(startComposerList(m.el), false);
    window.getSelection()!.collapse(m.el, 2);
    assert.equal(startComposerList(m.el), false);
    assert.equal(m.el.value, '1. ');
    assert.deepEqual(commands.calls, []);
  } finally {
    commands.restore();
    await m.close();
  }
});

test('the real input routes list keys after its parent, prevents native duplication and publishes the updated draft', async () => {
  const m = await mount('1. First');
  const original = document.execCommand;
  const calls: string[] = [];
  document.execCommand = ((command: string) => {
    calls.push(command);
    m.el.querySelector('ol').insertAdjacentHTML('beforeend', '<li><br></li>');
    m.el.setSelectionRange(m.el.value.length, m.el.value.length);
    return true;
  }) as any;
  try {
    m.el.focus();
    m.el.setSelectionRange(m.el.value.length, m.el.value.length);
    const event = new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    await act(() => m.el.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(calls, ['insertParagraph']);
    assert.equal(m.text, '1. First\n2. ');
  } finally {
    document.execCommand = original;
    await m.close();
  }
});

test('a restarted ordered list retains its explicitly typed start after an earlier list', async () => {
  const m = await mount();
  const commands = nativeCommands();
  try {
    m.el.innerHTML = '<ol><li>First</li></ol><div>9. </div>';
    m.el.focus();
    window.getSelection()!.collapse(m.el.lastChild.firstChild, 3);
    assert.equal(startComposerList(m.el), true);
    assert.equal(m.el.value, '1. First\n9. ');
    assert.equal(m.el.querySelectorAll('ol').length, 2);
  } finally {
    commands.restore();
    await m.close();
  }
});
