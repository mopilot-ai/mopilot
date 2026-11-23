// A file edited in place in the side pane (src/components/panels/files/FileCode.tsx, FilePreview.tsx, FileFind.tsx): Save,
// ⌘S and Discard, a file changed under an edit, Tab, go to line, find in file and word wrap (setup: tests/support/files-ui-kit.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { one, byText, settle, typeInto } from './support/shell-panels-kit.ts';
import {
  fx,
  act,
  createElement,
  FilePreview,
  calls,
  click,
  disk,
  getState,
  hasDraft,
  inserted,
  key,
  preview,
  setFileDraft,
  type,
  RECOLOR_MS,
} from './support/files-ui-kit.ts';

test('typing edits the file in place; Save (or ⌘S) writes it and the view reads it back', async () => {
  const r = await preview();
  const area = one(r.host, 'textarea') as HTMLTextAreaElement;
  assert.equal(area.getAttribute('aria-label'), 'Edit a.ts');
  await type(area, 'one\nTWO\nthree');
  assert.equal(one(r.host, '[role="status"]').textContent, 'Unsaved changes');
  // until the pause, the edit is drawn plain, aligned with what was typed
  assert.equal(r.host.querySelector('.file-editor-code [data-colored]'), null);
  assert.equal(one(r.host, '.file-editor-code').textContent, 'one\nTWO\nthree');
  await settle(act, RECOLOR_MS + 20);
  assert.ok(r.host.querySelector('.file-editor-code [data-colored]'));
  await key(area, { key: 's', metaKey: true, ctrlKey: true });
  await settle(act);
  assert.deepEqual(
    calls.find((c) => c[0] === 'writeText'),
    ['writeText', '/repo/a.ts', 'one\nTWO\nthree'],
  );
  assert.equal(r.host.querySelector('[role="status"]'), null);
  assert.equal(calls.filter((c) => c[0] === 'readText').length, 3, 'read at open, before writing, and again after');
  await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'again');
  await click(one(r.host, 'button', 'Save'));
  await settle(act);
  assert.equal(disk['/repo/a.ts'], 'again');
  // Ctrl-S saves too (the key off the Mac)
  await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'ctrl');
  await key(one(r.host, 'textarea'), { key: 'S', ctrlKey: true });
  await settle(act);
  assert.equal(disk['/repo/a.ts'], 'ctrl');
  await r.unmount();
});

test('Discard drops the edit once the user agrees; a failed save says why and keeps it', async () => {
  const r = await preview();
  await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'mine');
  fx.writeResult = { ok: false, error: 'EROFS' };
  await click(one(r.host, 'button', 'Save'));
  await settle(act);
  assert.match(getState().toasts.at(-1)!.text, /Couldn't save a.ts: EROFS/);
  assert.equal(hasDraft('/repo/a.ts'), true);
  fx.confirmAnswer = false;
  await click(one(r.host, 'button', 'Discard'));
  assert.equal(hasDraft('/repo/a.ts'), true);
  fx.confirmAnswer = true;
  await click(one(r.host, 'button', 'Discard'));
  assert.equal(hasDraft('/repo/a.ts'), false);
  assert.equal(one(r.host, '.file-editor-code').textContent, 'one\ntwo\nthree');
  await r.unmount();
});

test('a file changed under an edit says so: Reload takes the file’s text, Keep my edits keeps editing', async () => {
  setFileDraft('/repo/a.ts', 'older text', 'my edit');
  const r = await preview();
  assert.match(one(r.host, '.file-stale').textContent!, /changed since you started editing/);
  assert.equal(one(r.host, '.file-editor-code').textContent, 'my edit');
  await click(one(r.host, '.file-stale button', 'Keep my edits'));
  assert.equal(r.host.querySelector('.file-stale'), null);
  assert.equal(hasDraft('/repo/a.ts'), true);
  setFileDraft('/repo/a.ts', 'older text', 'my edit');
  await settle(act);
  fx.confirmAnswer = false;
  await click(one(r.host, '.file-stale button', 'Reload'));
  assert.ok(r.host.querySelector('.file-stale'), 'saying no keeps the edit');
  fx.confirmAnswer = true;
  await click(one(r.host, '.file-stale button', 'Reload'));
  await settle(act);
  assert.equal(one(r.host, '.file-editor-code').textContent, 'one\ntwo\nthree');
  await r.unmount();
});

test('Tab indents as the file does; ⇧Tab and other keys are the browser’s', async () => {
  const r = await preview();
  const area = one(r.host, 'textarea');
  await key(area, { key: 'Tab' });
  await key(area, { key: 'Tab', shiftKey: true });
  await key(area, { key: 'a' });
  await key(area, { key: 's', altKey: true, metaKey: true, ctrlKey: true });
  await key(area, { key: 'Tab', isComposing: true });
  assert.deepEqual(inserted, ['insertText:  ']);
  assert.equal(calls.filter((c) => c[0] === 'writeText').length, 0);
  await r.unmount();
});

test('⌃G (or the menu) opens go to line: a line in range goes there, one out of range says which lines there are', async () => {
  const r = await preview();
  await key(one(r.host, '.file-editor'), { key: 'g', ctrlKey: true });
  const input = one(r.host, '[aria-label="Go to line"]') as HTMLInputElement;
  assert.equal(input.placeholder, 'Go to line (1–3)');
  await act(async () => typeInto(input, '99'));
  await key(input, { key: 'Enter' });
  assert.equal(one(r.host, '.file-find .chat-find-count').textContent, 'Lines 1–3');
  await act(async () => typeInto(input, '2'));
  assert.equal(one(r.host, '.file-find .chat-find-count').textContent, '');
  await key(input, { key: 'Enter', isComposing: true });
  await key(input, { key: 'x' });
  await key(input, { key: 'Enter' });
  assert.equal(r.host.querySelector('[aria-label="Go to line"]'), null);
  assert.equal(one(r.host, '.file-preview-target').textContent, 'two');
  const area = one(r.host, 'textarea') as HTMLTextAreaElement;
  assert.equal(area.selectionStart, 4);
  const menu = () => click(one(r.host, '.file-preview-head [aria-label="File actions"]'));
  await menu();
  await click(one(r.host, '[role="menuitem"]', 'Go to line…'));
  await key(one(r.host, '[aria-label="Go to line"]'), { key: 'Escape' });
  assert.equal(r.host.querySelector('[aria-label="Go to line"]'), null);
  await menu();
  await click(one(r.host, '[role="menuitem"]', 'Go to line…'));
  await click(one(r.host, '[aria-label="Close go to line bar"]'));
  assert.equal(r.host.querySelector('[aria-label="Go to line"]'), null);
  await key(one(r.host, '.file-editor'), { key: 'g', ctrlKey: true, metaKey: true });
  assert.equal(r.host.querySelector('[aria-label="Go to line"]'), null, '⌃⌘G is not go to line');
  await r.unmount();
});

test('find in file counts the matches, steps between them either way and closes with Escape', async () => {
  disk['/repo/a.ts'] = 'apple\nbanana apple\ncherry';
  const painted: unknown[][] = [];
  (globalThis as any).CSS = {
    highlights: {
      set: (n: string, h: any) => painted.push(['set', n, h.ranges.length]),
      delete: (n: string) => painted.push(['delete', n]),
    },
  };
  (globalThis as any).Highlight = class {
    ranges: unknown[];
    constructor(...ranges: unknown[]) {
      this.ranges = ranges;
    }
  };
  try {
    const r = await preview();
    // ⌘F with focus in the file comes as this event (src/session/appShortcuts.ts)
    await act(async () => void one(r.host, '.file-view').dispatchEvent(new (window as any).CustomEvent('find-in-file')));
    const input = one(r.host, 'input[aria-label="Find in file"]') as HTMLInputElement;
    const count = () => one(r.host, '.file-find .chat-find-count').textContent;
    assert.equal(count(), '');
    await act(async () => typeInto(input, 'APPLE'));
    await settle(act);
    assert.equal(count(), '1 of 2');
    assert.ok(painted.some((p) => p[0] === 'set' && p[1] === 'chat-find-current'));
    await key(input, { key: 'Enter' });
    assert.equal(count(), '2 of 2');
    await key(input, { key: 'Enter', shiftKey: true });
    assert.equal(count(), '1 of 2');
    await click(one(r.host, '[aria-label="Previous match"]'));
    assert.equal(count(), '2 of 2');
    await click(one(r.host, '[aria-label="Next match"]'));
    assert.equal(count(), '1 of 2');
    await key(input, { key: 'Enter', isComposing: true });
    await key(input, { key: 'x' });
    assert.equal(count(), '1 of 2');
    await act(async () => typeInto(input, 'kiwi'));
    await settle(act);
    assert.equal(count(), 'No results');
    // an edit drawn plain before it is colored again is found in as typed
    await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'kiwi kiwi kiwi');
    await settle(act);
    assert.equal(count(), '1 of 3');
    await key(input, { key: 'Escape' });
    assert.equal(r.host.querySelector('input[aria-label="Find in file"]'), null);
    await click(one(r.host, 'button[aria-label="Find in file"]'));
    await click(one(r.host, '[aria-label="Close find"]'));
    assert.equal(r.host.querySelector('input[aria-label="Find in file"]'), null);
    await r.unmount();
  } finally {
    delete (globalThis as any).CSS;
    delete (globalThis as any).Highlight;
  }
});

test('Word wrap is remembered for every file view', async () => {
  const r = await preview();
  assert.equal(r.host.querySelector('.file-editor.wrap'), null);
  await click(one(r.host, '[aria-label="Word wrap"]'));
  assert.equal(getState().prefs.filesWrap, true);
  assert.ok(r.host.querySelector('.file-editor.wrap'));
  assert.equal(one(r.host, 'textarea').getAttribute('wrap'), 'soft');
  await r.unmount();
});

test('a rendered Markdown file shows the edit typed in its source', async () => {
  disk['/repo/n.md'] = '# Title';
  setFileDraft('/repo/n.md', '# Title', '# Edited');
  const r = await preview('/repo/n.md');
  assert.equal(one(r.host, '[data-markdown]').textContent, '# Edited');
  await click(one(r.host, '.file-preview-head [aria-label="File actions"]'));
  assert.equal(byText(r.host, '[role="menuitem"]', 'Go to line').length, 0, 'no lines to go to in a rendered view');
  await r.unmount();
});

test('typing while the file-changed notice shows keeps the edit’s own base, so Save still asks before replacing', async () => {
  setFileDraft('/repo/a.ts', 'older text', 'my edit');
  const r = await preview();
  await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'my edit!');
  assert.ok(r.host.querySelector('.file-stale'), 'still says the file changed');
  fx.confirmAnswer = false;
  await click(one(r.host, 'button', 'Save'));
  await settle(act);
  assert.equal(disk['/repo/a.ts'], 'one\ntwo\nthree', 'the agent’s text stays');
  assert.equal(hasDraft('/repo/a.ts'), true);
  await r.unmount();
});

test('saving keeps the same editor (focus, caret and undo) and the view where it was', async () => {
  const r = await preview();
  const area = one(r.host, 'textarea') as HTMLTextAreaElement;
  area.focus();
  await type(area, 'one\ntwo\nthree!');
  await key(area, { key: 's', metaKey: true });
  await settle(act);
  assert.equal(one(r.host, 'textarea'), area, 'not drawn again');
  assert.equal(document.activeElement, area);
  assert.equal(r.host.querySelector('.center-pad'), null, 'no spinner in between');
  await r.unmount();
});

test('a shown file follows changes on disk; with an edit open, the notice says it changed', async () => {
  const r = await preview();
  disk['/repo/a.ts'] = 'agent wrote';
  await act(async () => void window.dispatchEvent(new (window as any).Event('focus')));
  await settle(act);
  assert.equal(one(r.host, '.file-editor-code').textContent, 'agent wrote');
  await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'mine');
  disk['/repo/a.ts'] = 'agent again';
  await act(async () => void window.dispatchEvent(new (window as any).Event('blur')));
  await act(async () => void window.dispatchEvent(new (window as any).Event('focus')));
  await settle(act);
  assert.ok(r.host.querySelector('.file-stale'));
  assert.equal(one(r.host, '.file-editor-code').textContent, 'mine');
  await r.unmount();
});

test('a Windows file shows, edits and saves with its own line endings', async () => {
  disk['/repo/a.ts'] = 'one\r\ntwo';
  const r = await preview();
  assert.equal(one(r.host, '.file-editor-code').textContent, 'one\ntwo');
  await type(one(r.host, 'textarea') as HTMLTextAreaElement, 'one\nTWO');
  await click(one(r.host, 'button', 'Save'));
  await settle(act);
  assert.equal(disk['/repo/a.ts'], 'one\r\nTWO');
  await r.unmount();
});

test('a newly cited line takes the place of an earlier go-to-line jump', async () => {
  const r = await preview('/repo/a.ts', { line: 1 });
  await key(one(r.host, '.file-editor'), { key: 'g', ctrlKey: true });
  await act(async () => typeInto(one(r.host, '[aria-label="Go to line"]') as HTMLInputElement, '2'));
  await key(one(r.host, '[aria-label="Go to line"]'), { key: 'Enter' });
  assert.equal(one(r.host, '.file-preview-target').textContent, 'two');
  await r.rerender(createElement(FilePreview, { path: '/repo/a.ts', cwd: '/repo', line: 3 }));
  await settle(act);
  assert.equal(one(r.host, '.file-preview-target').textContent, 'three');
  await r.unmount();
});

test('a re-read that finds the file gone, binary, too large or unreadable keeps what the view shows', async () => {
  const r = await preview();
  const focus = async () => {
    await act(async () => void window.dispatchEvent(new (window as any).Event('blur')));
    await act(async () => void window.dispatchEvent(new (window as any).Event('focus')));
    await settle(act);
  };
  await focus();
  for (const text of [undefined, 'a\0b', 'x'.repeat(400_001), 'throw']) {
    if (text === undefined) delete disk['/repo/a.ts'];
    else disk['/repo/a.ts'] = text;
    await focus();
    assert.equal(one(r.host, '.file-editor-code').textContent, 'one\ntwo\nthree');
  }
  // a read still under way when the view goes changes nothing
  disk['/repo/a.ts'] = 'after the view went';
  let release!: () => void;
  fx.readGate = new Promise((resolve) => (release = resolve));
  await focus();
  await r.unmount();
  release();
  await settle(act);
});
