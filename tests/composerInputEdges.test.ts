// The composer's inline editor (src/components/composer/ComposerInput.tsx) on the edges: browser-made line
// structures, caret placement in odd DOM shapes, skill deletion across wrappers, cut/copy/paste.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { sessionToken } from '../src/lib/sessionMentions.ts';
import type { Attachment } from '../src/store/types.ts';

mock.module('../src/components/markdown/SkillLink.tsx', { namedExports: { openSkill: () => {} } });
mock.module('../src/session/open.ts', { namedExports: { openPath: () => {} } });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ComposerInput } = await import('../src/components/composer/ComposerInput.tsx');
const skill: Attachment = { kind: 'skill', name: 'ut-pr-merge', path: '/skills/ut/SKILL.md' };

async function mount(value = '', attachments: Attachment[] = [], extra: Record<string, any> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let el: any = null;
  let state = { value, attachments };
  const changes: { value: string; attachments: Attachment[]; caret: number }[] = [];
  const render = () =>
    root.render(
      createElement(ComposerInput, {
        ref: (n: any) => {
          el = n;
        },
        ...state,
        placeholder: 'Do anything',
        disabled: false,
        hidden: false,
        onKeyDown() {},
        onPaste() {},
        onSelect() {},
        ...extra,
        onChange(value: string, attachments: Attachment[], caret: number) {
          changes.push({ value, attachments, caret });
          state = { value, attachments };
          render();
        },
      } as any),
    );
  await act(render);
  return {
    changes,
    get el() {
      return el;
    },
    get state() {
      return state;
    },
    async update(value: string, attachments: Attachment[]) {
      state = { value, attachments };
      await act(render);
    },
    async input() {
      await act(async () => void el.dispatchEvent(new window.InputEvent('input', { bubbles: true })));
    },
    async close() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
function caret(node: Node, offset: number, end = offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range as any);
}
async function press(el: Element, key: string) {
  const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => void el.dispatchEvent(ev as any));
  return ev.defaultPrevented;
}
function mockDelete() {
  const calls: string[] = [];
  const original = document.execCommand;
  (document as any).execCommand = (command: string) => {
    calls.push(command);
    const sel = window.getSelection()!;
    if (sel.rangeCount) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.collapse(true);
    }
    return true;
  };
  return {
    calls,
    restore() {
      document.execCommand = original;
    },
  };
}

test('browser line structures read back as the typed text', async () => {
  const m = await mount('x');
  try {
    m.el.innerHTML = 'a<br>b';
    await m.input();
    assert.equal(m.state.value, 'a\nb');
    m.el.innerHTML = 'a<div><br></div>';
    await m.input();
    assert.equal(m.state.value, 'a\n');
    m.el.innerHTML = 'a<br>';
    await m.input();
    assert.equal(m.state.value, 'a');
    m.el.innerHTML = 'a<p>b</p><div>c</div>';
    await m.input();
    assert.equal(m.state.value, 'a\nb\nc');
  } finally {
    await m.close();
  }
});

test('a skill without a display name shows its name; an unknown skill element is dropped', async () => {
  const m = await mount('hi', [{ ...skill, textOffset: 2 }]);
  try {
    assert.equal(m.el.textContent, 'hi' + skill.name);
    const forged = document.createElement('span');
    forged.dataset.skillId = '999';
    m.el.append(forged);
    await m.input();
    assert.deepEqual(
      m.state.attachments.map((a) => a.textOffset),
      [2],
    );
  } finally {
    await m.close();
  }
});

test('a draft change while focused keeps the caret where it was', async () => {
  const m = await mount('hello');
  try {
    m.el.focus();
    caret(m.el.firstChild, 2);
    await m.update('hello world', []);
    assert.equal(m.el.selectionStart, 2);
    // an empty editor places the caret at its end
    await m.update('', []);
    m.el.replaceChildren();
    m.el.setSelectionRange(0, 0);
    assert.ok(window.getSelection()!.anchorNode === m.el);
    // non-text elements (a browser-made block) are walked through when placing the caret
    m.el.innerHTML = '<div>ab</div>';
    m.el.setSelectionRange(1, 1);
    assert.equal(window.getSelection()!.anchorOffset, 1);
  } finally {
    await m.close();
  }
});

test('Delete with the caret in the editor itself removes the skill right after it', async () => {
  const m = await mount('', [skill]);
  const cmd = mockDelete();
  try {
    m.el.focus();
    // drop the empty caret hosts so the skill is the editor's direct child
    [...m.el.childNodes].filter((n: Node) => n.nodeType === Node.TEXT_NODE).forEach((n: Node) => (n as any).remove());
    caret(m.el, 0);
    assert.equal(await press(m.el, 'Delete'), true);
    assert.deepEqual(cmd.calls, ['delete']);
    assert.deepEqual(m.state.attachments, []);
  } finally {
    cmd.restore();
    await m.close();
  }
});

test('Backspace skips empty text nodes and looks inside wrappers for the skill before the caret', async () => {
  const m = await mount('', [skill]);
  const cmd = mockDelete();
  try {
    m.el.focus();
    const token = m.el.querySelector('[data-skill-id]');
    const wrap = document.createElement('span');
    const empty = document.createElement('i');
    wrap.append(token, document.createTextNode(''));
    const text = document.createTextNode('x');
    m.el.replaceChildren(empty, wrap, document.createTextNode(''), text);
    caret(text, 0);
    assert.equal(await press(m.el, 'Backspace'), true);
    assert.deepEqual(cmd.calls, ['delete']);
    // an empty wrapper before the caret holds no skill
    m.el.replaceChildren(document.createElement('b'), document.createTextNode('y'));
    caret(m.el.lastChild, 0);
    assert.equal(await press(m.el, 'Backspace'), false);
    // at the very start of the editor there is nothing before the caret
    m.el.replaceChildren(document.createTextNode('z'));
    caret(m.el.firstChild, 0);
    assert.equal(await press(m.el, 'Backspace'), false);
    assert.deepEqual(cmd.calls, ['delete']);
  } finally {
    cmd.restore();
    await m.close();
  }
});

test('keys with no selection are left to the browser', async () => {
  const m = await mount('', [skill]);
  try {
    window.getSelection()!.removeAllRanges();
    assert.equal(await press(m.el, 'Backspace'), false);
  } finally {
    await m.close();
  }
});

test('copy and cut with nothing selected do nothing; cut removes the selection and keeps its reference text', async () => {
  const token = sessionToken('chat', 'Other');
  const m = await mount('a ' + token + ' b');
  const cmd = mockDelete();
  try {
    window.getSelection()!.removeAllRanges();
    for (const type of ['copy', 'cut']) {
      const data = new window.DataTransfer();
      const ev = new window.ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data });
      await act(async () => void m.el.dispatchEvent(ev));
      assert.equal(ev.defaultPrevented, false);
    }
    m.el.focus();
    m.el.setSelectionRange(2, 2 + token.length);
    const data = new window.DataTransfer();
    const ev = new window.ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: data });
    await act(async () => void m.el.dispatchEvent(ev));
    assert.equal(ev.defaultPrevented, true);
    assert.equal(data.getData('text/plain'), token);
    assert.deepEqual(cmd.calls, ['delete']);
    assert.equal(m.state.value, 'a  b');
  } finally {
    cmd.restore();
    await m.close();
  }
});

test('pasting text with a chat reference inserts it as an atomic token', async () => {
  const token = sessionToken('chat', 'Other');
  const m = await mount('');
  const original = document.execCommand;
  const calls: any[] = [];
  (document as any).execCommand = (...a: any[]) => (calls.push(a), true);
  try {
    const data = new window.DataTransfer();
    data.setData('text/plain', 'see ' + token);
    await act(
      async () => void m.el.dispatchEvent(new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })),
    );
    assert.equal(calls[0][0], 'insertHTML');
    assert.match(
      calls[0][2],
      /^see <span class="composer-session-token" data-session-token=".*" contenteditable="false" title="Other">Other<\/span>$/,
    );
  } finally {
    document.execCommand = original;
    await m.close();
  }
});
