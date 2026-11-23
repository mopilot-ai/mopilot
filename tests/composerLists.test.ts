// Structured composer lists retain Markdown, reference chips and the caret across editing and draft restoration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import type { Attachment } from '../src/store/types.ts';
import { sessionToken } from '../src/lib/sessionMentions.ts';
import { listItemPrefix } from '../src/lib/composerLists.ts';
import { insertHTML } from './support/composer-dom.ts';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

import { act, mount } from './support/composer-list-editor.ts';

test('restored numbered and bullet drafts render actual lists and retain their prompt text', async () => {
  for (const [text, selector] of [
    ['1. First\n2. Second', 'ol'],
    ['- First\n- Second', 'ul'],
  ]) {
    const m = await mount(text);
    try {
      assert.equal(m.el.querySelectorAll(`${selector} > li`).length, 2);
      assert.equal(m.el.value, text);
      assert.equal(m.el.querySelector('li').textContent, 'First');
    } finally {
      await m.close();
    }
  }
});

test('restoration preserves nesting, starting numbers, discontinuities, spacing and fenced code literally', async () => {
  for (const text of [
    'Intro\n9. Nine\n10. Ten\n\nAfter',
    '- Parent\n   4. Child\n   5. Child two\n- Next',
    '1. One\n   - Child\n2. Two',
    '1. One\n5. Five\n- Bullet\n+ Plus\n* Star',
    '1. \n2. ',
    '0. Zero\n1. One',
    '999999999. Large',
    '01. Literal\n1234567890. Literal\n\\1. Escaped\n    1. Code\n1. List',
    '```md\n1. Code\n```\n1. List',
    '```md\n```not-a-close\n1. Code\n``` \t\n1. List',
    '````md\n```\n1. Code\n~~~~\n````\n- List',
    '~~~\n1. Code\n~~~\n- List',
    '  - Indented\n  - Also indented',
    '- Parent\n\t- Nested\n- Next',
  ]) {
    const m = await mount(text);
    try {
      assert.equal(m.el.value, text, text);
    } finally {
      await m.close();
    }
  }
});

test('list restoration moves reference chips intact and maps generated markers to the caret', async () => {
  const token = sessionToken('chat:quoted/id', 'Review');
  const text = `1. Ask ${token}\n2. Next\n3. `;
  const skill: Attachment = { kind: 'skill', name: 'Review skill', path: '/skills/review/SKILL.md', textOffset: text.indexOf('Next') };
  const m = await mount(text, [skill]);
  try {
    assert.equal(m.el.querySelectorAll('ol > li').length, 3);
    assert.equal(m.el.querySelector('[data-session-token]').textContent, 'Review');
    assert.equal(m.el.querySelector('[data-skill-id]').textContent, 'Review skill');
    assert.ok(m.el.querySelector('.composer-skill svg'), 'the icon portal remains attached to its original host');
    m.el.focus();
    for (const offset of [3, 6, text.indexOf('\n'), text.indexOf('Next'), text.indexOf('Next') + 2, text.length]) {
      m.el.setSelectionRange(offset, offset);
      assert.equal(m.el.selectionStart, offset, `caret at ${offset}`);
    }
    await m.input();
    assert.equal(m.text, text);
    assert.equal(m.attachments[0].textOffset, skill.textOffset);
    m.el.setCaretAfter('1. Other\n2. ', 12);
    await m.update('1. Other\n2. ');
    assert.equal(m.el.selectionStart, 12);
  } finally {
    await m.close();
  }
});

test('copying later list items retains their actual numbers and partial text omits markers', async () => {
  const text = '4. First\n5. Second\n6. Third';
  const m = await mount(text);
  try {
    m.el.focus();
    for (const [start, end] of [
      [0, text.length],
      [text.indexOf('Second') + 2, text.length],
      [text.indexOf('Third'), text.length],
    ]) {
      m.el.setSelectionRange(start, end);
      const data = new window.DataTransfer();
      await act(() => m.el.dispatchEvent(new window.ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })));
      assert.equal(data.getData('text/plain'), text.slice(start, end));
    }
    const outside = document.createTextNode('Outside');
    document.body.append(outside);
    const range = document.createRange();
    range.selectNode(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range as any);
    for (const type of ['copy', 'cut']) {
      const event = new window.ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: new window.DataTransfer() });
      await act(() => m.el.dispatchEvent(event));
      assert.equal(event.defaultPrevented, false);
    }
    outside.remove();
  } finally {
    await m.close();
  }
});

test('pasted list text becomes safe structured nodes through the native undo boundary', async () => {
  const m = await mount();
  const original = document.execCommand;
  document.execCommand = insertHTML as any;
  try {
    m.el.focus();
    m.el.setSelectionRange(0, 0);
    const data = new window.DataTransfer();
    data.setData('text/plain', '1. <script>literal</script>\n2. Second');
    data.setData('text/html', '<script>unsafe()</script>');
    await act(() => m.el.dispatchEvent(new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })));
    await m.input();
    assert.equal(m.el.querySelectorAll('ol > li').length, 2);
    assert.equal(m.el.querySelector('script'), null);
    assert.equal(m.text, data.getData('text/plain'));
  } finally {
    document.execCommand = original;
    await m.close();
  }
});

test('invalid browser start attributes fall back to valid generated numbers', () => {
  const list = document.createElement('ol');
  list.setAttribute('start', 'invalid');
  const item = document.createElement('li');
  list.append(item);
  assert.equal(listItemPrefix(item), '1. ');
});

test('native empty list items and a reference without a leading text host accept caret placement', async () => {
  const m = await mount(sessionToken('chat', 'Review'));
  try {
    m.el.focus();
    m.el.querySelector('[data-session-token]').previousSibling.remove();
    m.el.setSelectionRange(0, 0);
    assert.equal(m.el.selectionStart, 0);
    m.el.innerHTML = '<ol><li>First</li><li><br></li></ol>';
    m.el.setSelectionRange(m.el.value.length, m.el.value.length);
    assert.equal(m.el.selectionStart, m.el.value.length);
    assert.equal(window.getSelection()!.anchorNode!.nodeName, 'LI');
  } finally {
    await m.close();
  }
});

test('copying complete later items includes their first generated number', async () => {
  const m = await mount('4. First\n5. Second\n6. Third');
  try {
    m.el.focus();
    m.el.setSelectionRange(m.el.value.indexOf('Second'), m.el.value.length);
    const data = new window.DataTransfer();
    await act(() => m.el.dispatchEvent(new window.ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })));
    assert.equal(data.getData('text/plain'), '5. Second\n6. Third');
  } finally {
    await m.close();
  }
});

test('native list edits serialize generated numbers into the prompt', async () => {
  const m = await mount();
  try {
    m.el.innerHTML = '<ol><li>First</li><li>Second</li><li>Third</li></ol>';
    await m.input();
    assert.equal(m.text, '1. First\n2. Second\n3. Third');
  } finally {
    await m.close();
  }
});

test('Chromium list nesting serializes indentation and restored drafts use the native outdent structure', async () => {
  const m = await mount();
  try {
    // Captured from native Chromium indent, which nests OL directly beneath OL.
    m.el.innerHTML = '<ol><li>First</li><li>Second</li><ol><li>Third</li></ol></ol>';
    await m.input();
    assert.equal(m.text, '1. First\n2. Second\n   1. Third');
    await m.update('1. First\n   1. Child\n2. Next');
    assert.equal(m.el.querySelector('ol ol').parentElement.nodeName, 'OL');
    assert.equal(m.el.querySelectorAll(':scope > ol').length, 1, 'nested lists do not change sibling numbering');
    assert.equal(m.el.value, '1. First\n   1. Child\n2. Next');
  } finally {
    await m.close();
  }
});

test('generated nesting remains nested Markdown under multi-digit ordered parents and bullets', async () => {
  const m = await mount();
  try {
    for (const [html, expected] of [
      ['<ol start="10"><li>Parent</li><ol><li>Child</li></ol></ol>', '10. Parent\n    1. Child'],
      ['<ol start="100"><li>Parent<ol><li>Child</li></ol></li></ol>', '100. Parent\n     1. Child'],
      ['<ul><li>Parent</li><ol><li>Child</li></ol></ul>', '- Parent\n  1. Child'],
      [
        '<ol start="10"><li>Parent</li><ul data-composer-indent="    "><li>Child</li></ul><ol><li>Next</li></ol></ol>',
        '10. Parent\n    - Child\n    1. Next',
      ],
    ]) {
      m.el.innerHTML = html;
      assert.equal(m.el.value, expected);
      const tree = unified().use(remarkParse).parse(m.el.value);
      assert.equal(tree.children[0].type, 'list');
      const list = tree.children[0] as any;
      assert.equal(list.children.length, 1);
      assert.equal(list.children[0].children[1].type, 'list');
      assert.equal(list.children[0].children[1].children[0].children[0].children[0].value, 'Child');
      assert.equal(listItemPrefix(m.el.querySelector('ol ol li, ul ol li')), expected.split('\n').at(-1)!.replace(/\S+$/, ''));
    }
  } finally {
    await m.close();
  }
});

test('native renumbering across a digit boundary keeps restored descendants nested in Markdown', async () => {
  for (const [start, indent] of [
    [9, '   '],
    [99, '    '],
  ] as const) {
    const m = await mount(`${start}. Parent\n${indent}- Child`);
    try {
      m.el.querySelector('ol').insertAdjacentHTML('afterbegin', '<li><br></li>');
      assert.equal(m.el.value, `${start}. \n${start + 1}. Parent\n${indent} - Child`);
      const list = unified().use(remarkParse).parse(m.el.value).children[0] as any;
      assert.equal(list.children[1].children[1].type, 'list');
      assert.equal(list.children[1].children[1].children[0].children[0].children[0].value, 'Child');
    } finally {
      await m.close();
    }
  }
});

test('native outdent preserves the line break before following text, references and empty caret hosts', async () => {
  const m = await mount();
  try {
    for (const [html, text] of [
      ['<ol start="9"><li>Follow-up</li></ol>Outside again', '9. Follow-up\nOutside again'],
      ['<ol><li>One</li></ol><br>', '1. One\n'],
      ['<ul><li>One</li></ul><span data-session-token="@chat">Chat</span>', '- One\n@chat'],
      ['<ol><li>First</li></ol><div><ol start="9"><li>Next</li></ol><br></div>', '1. First\n9. Next\n'],
      ['After\n<ul><li>Bullet one</li></ul>', 'After\n- Bullet one'],
      ['After<br><ul><li>Bullet one</li></ul>', 'After\n- Bullet one'],
    ]) {
      m.el.innerHTML = html;
      await m.input();
      assert.equal(m.text, text);
    }
    m.el.innerHTML = '<ol start="9"><li>Follow-up</li></ol><br>';
    m.el.focus();
    window.getSelection()!.collapse(m.el, 1);
    assert.equal(m.el.selectionStart, 13, 'the outside caret includes the new line');
    m.el.setSelectionRange(13, 13);
    assert.equal(m.el.selectionStart, 13, 'restoring the outside caret must not return to the preceding item');
    m.el.innerHTML = '<br>';
    window.getSelection()!.collapse(m.el, 0);
    assert.equal(m.el.selectionStart, 0);
    m.el.innerHTML = '<ol><li>One</li></ol>After';
    window.getSelection()!.collapse(m.el.lastChild, 0);
    assert.equal(m.el.selectionStart, 7, 'a caret at the beginning of outside text includes the list separator');
    m.el.innerHTML = '<ol><li>One</li></ol>';
    m.el.append(document.createTextNode(''), document.createTextNode(''));
    assert.equal(m.el.value, '1. One', 'empty native insertion hosts must not add phantom lines');
  } finally {
    await m.close();
  }
});

test('a skill before a converted list keeps its zero-width position without a phantom leading line', async () => {
  const m = await mount('', [{ kind: 'skill', name: 'Review', path: '/review/SKILL.md', textOffset: 0 }]);
  try {
    m.el.insertAdjacentHTML('beforeend', '<ol start="1"><li><br></li></ol>');
    await m.input();
    assert.equal(m.text, '1. ');
    assert.equal(m.attachments[0].textOffset, 0);
  } finally {
    await m.close();
  }
});

test('a leading skill remains in a restored list rather than blocking its formatting', async () => {
  const m = await mount('1. First\n2. Second', [{ kind: 'skill', name: 'Review', path: '/review/SKILL.md', textOffset: 0 }]);
  try {
    assert.equal(m.el.querySelectorAll('li').length, 2);
    assert.equal(m.el.querySelector('li [data-skill-id]').textContent, 'Review');
    await m.input();
    assert.equal(m.text, '1. First\n2. Second');
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].textOffset, 3, 'the skill is now inside the first list item');
  } finally {
    await m.close();
  }
});

test('caret placement handles long lists without cloning a document prefix for every item', async () => {
  const text = Array.from({ length: 500 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
  const m = await mount(text);
  const original = document.createRange;
  let ranges = 0;
  document.createRange = () => {
    ranges++;
    return original.call(document);
  };
  try {
    m.el.focus();
    for (const index of [1, 250, 500]) {
      ranges = 0;
      const offset = text.indexOf(`Item ${index}`) + 5;
      m.el.setSelectionRange(offset, offset);
      assert.ok(ranges <= 10, 'caret placement and resulting selection notifications must not create a range for each list item');
      assert.equal(m.el.selectionStart, offset);
    }
    assert.equal(m.el.value, text);
  } finally {
    document.createRange = original;
    await m.close();
  }
});
