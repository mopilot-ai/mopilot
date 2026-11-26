// Whole-draft paste and native list history must not retain old list context or temporary block boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { mount } from './support/composer-list-editor.ts';
import { insertHTML } from './support/composer-dom.ts';
import { pasteComposerBlocks, replaceComposerBlocks } from '../src/lib/composerBlockEdit.ts';

test('whole-draft structured paste replaces the old start and list type through an owned block boundary', async () => {
  for (const text of ['9. Old\n10. Second', '9. Old\n10. ']) {
    const m = await mount(text);
    const original = document.execCommand;
    try {
      m.el.focus();
      if (text.endsWith(' ')) {
        const range = window.document.createRange();
        const [first, last] = m.el.querySelectorAll('li');
        range.setStart(first.firstChild, 0);
        range.setEndBefore(last.querySelector('br'));
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
      } else m.el.setSelectionRange(3, m.el.value.length);
      document.execCommand = (...args) => {
        assert.ok(m.el.querySelector('[data-composer-boundary]'));
        return insertHTML(args[0], args[1] ?? false, args[2] ?? '');
      };
      pasteComposerBlocks(m.el, '<ul><li>New</li><li>Second</li></ul>');
      assert.equal(m.el.value, '- New\n- Second');
      assert.equal(m.el.querySelector('ol, [data-composer-boundary]'), null);
    } finally {
      document.execCommand = original;
      await m.close();
    }
  }
});

test('partial and missing paste selections preserve their native context without claiming adjacent chips or lines', async () => {
  const m = await mount('1. Before\n2. After');
  const original = document.execCommand;
  const getSelection = window.getSelection;
  document.execCommand = () => {
    assert.equal(m.el.querySelector('[data-composer-boundary]'), null);
    return false;
  };
  try {
    m.el.focus();
    for (const [start, end] of [
      [3, 3],
      [3, 9],
      [4, m.el.value.length],
    ]) {
      m.el.setSelectionRange(start, end);
      assert.equal(pasteComposerBlocks(m.el, '<ul><li>Paste</li></ul>'), false);
    }
    m.el.innerHTML = '<span data-skill-id="1"></span><ol><li>Text</li></ol><br>';
    const text = m.el.querySelector('li').firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range as any);
    pasteComposerBlocks(m.el, '<ul><li>Paste</li></ul>');
    m.el.querySelector('[data-skill-id]').remove();
    pasteComposerBlocks(m.el, '<ul><li>Paste</li></ul>');
    range.selectNodeContents(document.body);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range as any);
    pasteComposerBlocks(m.el, 'Outside');
    range.setStart(text, 0);
    range.setEndAfter(m.el.parentElement);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range as any);
    pasteComposerBlocks(m.el, 'Crossing');
    window.getSelection()!.removeAllRanges();
    pasteComposerBlocks(m.el, 'Missing');
    window.getSelection = (() => null) as any;
    pasteComposerBlocks(m.el, 'Unavailable');
  } finally {
    window.getSelection = getSelection;
    document.execCommand = original;
    await m.close();
  }
});

test('a refused or throwing block command removes its boundary and retains the original selection', async () => {
  const m = await mount('1. Original');
  const original = document.execCommand;
  try {
    m.el.focus();
    m.el.setSelectionRange(7, 7);
    for (const throws of [false, true]) {
      document.execCommand = () => {
        if (throws) throw new Error('native edit unavailable');
        return false;
      };
      const edit = () => replaceComposerBlocks(m.el, m.el.firstChild, m.el.lastChild, '<div>Replacement</div>');
      if (throws) assert.throws(edit, /native edit unavailable/);
      else assert.equal(edit(), false);
      assert.equal(m.el.value, '1. Original');
      assert.equal(m.el.selectionStart, 7);
      assert.equal(m.el.querySelector('[data-composer-boundary]'), null);
    }
    // A native history input can resurrect the empty boundary along with the previous list.
    m.el.insertAdjacentHTML('afterbegin', '<span contenteditable="false" data-composer-boundary></span>');
    await m.input();
    assert.equal(m.text, '1. Original');
    assert.equal(m.el.querySelector('[data-composer-boundary]'), null);
  } finally {
    document.execCommand = original;
    await m.close();
  }
});
