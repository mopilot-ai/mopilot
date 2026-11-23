// List nesting moves selected sibling subtrees atomically while retaining prompt text, chips and caret ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { mount } from './support/composer-list-editor.ts';
import { insertHTML } from './support/composer-dom.ts';
import { nestComposerList } from '../src/lib/composerListNesting.ts';

async function withEditor(text: string, run: (el: any) => void) {
  const m = await mount(text);
  const original = document.execCommand;
  document.execCommand = insertHTML;
  try {
    m.el.focus();
    run(m.el);
  } finally {
    document.execCommand = original;
    await m.close();
  }
}

test('indenting and outdenting a parent moves its complete mixed-list subtree and caret', async () => {
  const text = '1. Parent\n2. Child\n   - Grandchild';
  await withEditor(text, (el) => {
    const caret = text.indexOf('Child') + 5;
    el.setSelectionRange(caret, caret);
    assert.equal(nestComposerList(el, false), true);
    assert.equal(el.value, '1. Parent\n   1. Child\n      - Grandchild');
    assert.equal(el.selectionStart, el.value.indexOf('Child') + 5);
    nestComposerList(el, true);
    assert.equal(el.value, text);
    assert.equal(el.selectionStart, caret);
    assert.equal(el.querySelector('[data-composer-list-selection], [data-composer-list-end]'), null);
  });
});

test('a sibling joins an existing child list without losing its own descendants', async () => {
  await withEditor('10. Parent\n    1. Existing\n11. Child\n    - Grandchild', (el) => {
    el.setSelectionRange(el.value.indexOf('Child') + 5, el.value.indexOf('Child') + 5);
    nestComposerList(el, false);
    assert.equal(el.value, '10. Parent\n    1. Existing\n    2. Child\n       - Grandchild');
  });
  await withEditor('1. Parent\n   1. Ordered\n   - Bullet\n2. Child\n   - Grandchild', (el) => {
    el.setSelectionRange(el.value.indexOf('Child') + 5, el.value.indexOf('Child') + 5);
    nestComposerList(el, false);
    assert.equal(el.value, '1. Parent\n   1. Ordered\n   - Bullet\n   1. Child\n      - Grandchild');
  });
});

test('lifting a middle child keeps its following siblings under that lifted item', async () => {
  await withEditor('1. Parent\n   1. A\n   2. B\n   3. C\n2. Next', (el) => {
    const caret = el.value.indexOf('B') + 1;
    el.setSelectionRange(caret, caret);
    nestComposerList(el, true);
    assert.equal(el.value, '1. Parent\n   1. A\n2. B\n   1. C\n3. Next');
    assert.equal(el.selectionStart, el.value.indexOf('B') + 1);
  });
});

test('lifting root siblings preserves following numbering and promotes descendant lists', async () => {
  await withEditor('4. A\n5. B\n   - Child\n6. C\n7. D', (el) => {
    el.setSelectionRange(el.value.indexOf('B'), el.value.lastIndexOf('C') + 1);
    nestComposerList(el, true);
    assert.equal(el.value, '4. A\nB\n- Child\nC\n7. D');
  });
  await withEditor('- A\n- B', (el) => {
    el.setSelectionRange(el.value.indexOf('A'), el.value.length);
    nestComposerList(el, true);
    assert.equal(el.value, 'A\nB');
    assert.equal(el.querySelector('ul'), null);
  });
  await withEditor('1. ', (el) => {
    el.setSelectionRange(3, 3);
    nestComposerList(el, true);
    assert.equal(el.value, '');
    assert.equal(el.selectionStart, 0);
  });
  await withEditor('1. A\n2. B\n3. C', (el) => {
    el.querySelector('ol').removeAttribute('start');
    el.setSelectionRange(el.value.indexOf('B'), el.value.indexOf('B'));
    nestComposerList(el, true);
    assert.equal(el.value, '1. A\nB\n3. C');
    assert.equal(el.querySelector('ol div'), null);
  });
});

test('a selected sibling range nests together and a first item stays at its current level', async () => {
  await withEditor('1. A\n2. B\n3. C', (el) => {
    el.setSelectionRange(el.value.indexOf('B'), el.value.length);
    nestComposerList(el, false);
    assert.equal(el.value, '1. A\n   1. B\n   2. C');
    assert.equal(window.getSelection()!.isCollapsed, false);
    nestComposerList(el, true);
    assert.equal(el.value, '1. A\n2. B\n3. C');
    el.setSelectionRange(3, 3);
    nestComposerList(el, false);
    assert.equal(el.value, '1. A\n2. B\n3. C');
  });
});

test('selections spanning unrelated lists or levels retain their input and selection', async () => {
  for (const text of ['1. A\n   - B', '1. A\nAfter\n- B']) {
    await withEditor(text, (el) => {
      el.setSelectionRange(text.indexOf('A'), text.length);
      nestComposerList(el, false);
      assert.equal(el.value, text);
      assert.equal(el.selectionStart, text.indexOf('A'));
    });
  }
  await withEditor('Before\n1. A\nAfter', (el) => {
    for (const [start, end] of [
      [0, 10],
      [10, el.value.length],
    ]) {
      el.setSelectionRange(start, end);
      nestComposerList(el, false);
      assert.equal(el.value, 'Before\n1. A\nAfter');
    }
  });
});

test('normalization accepts conventional LI-owned children and multiple native child lists', async () => {
  await withEditor('', (el) => {
    el.innerHTML = '<ol><li>A<ul><li>Child</li></ul></li><li>B</li><ol><li>Ordered</li></ol><ul><li>Bullet</li></ul></ol>';
    const at = el.value.indexOf('B') + 1;
    el.setSelectionRange(at, at);
    nestComposerList(el, false);
    assert.equal(el.value, '1. A\n   - Child\n   1. B\n      1. Ordered\n      - Bullet');
  });
});

test('native refusal preserves input and caret while false-after-mutation retains a chip and its glyph', async () => {
  await withEditor('1. A\n2. B', (el) => {
    el.setSelectionRange(el.value.length, el.value.length);
    document.execCommand = () => false;
    nestComposerList(el, false);
    assert.equal(el.value, '1. A\n2. B');
    assert.equal(el.selectionStart, el.value.length);
    assert.equal(window.getSelection()!.isCollapsed, true);
    el.querySelectorAll('li')[1].insertAdjacentHTML('beforeend', '<span data-skill-id="1" contenteditable="false"><svg></svg>Skill</span>');
    document.execCommand = (...args) => {
      insertHTML(args[0], args[1] ?? false, args[2] ?? '');
      return false;
    };
    nestComposerList(el, false);
    assert.equal(el.value, '1. A\n   1. B');
    assert.ok(el.querySelector('ol ol li [data-skill-id="1"] svg'));
    assert.equal(el.selectionStart, el.value.length);
  });
});
