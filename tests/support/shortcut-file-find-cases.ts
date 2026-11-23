// ⌘F with focus in a side-pane file finds in that file (src/components/panels/files/FilePreview.tsx), not in the chat; registered against the real App fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { window as domWindow } from './dom.ts';
const window = domWindow as unknown as Window & typeof globalThis;

export function registerFileFindCases(fx: any) {
  const { reset, mount, unmount } = fx;
  test('⌘F in a file view asks that file to find, and the chat only once focus leaves it', async () => {
    reset({ route: { name: 'thread', id: 'a' } });
    await mount();
    const chat: unknown[] = [];
    const file: unknown[] = [];
    const onChat = (e: Event) => chat.push((e as CustomEvent).detail);
    window.addEventListener('find-in-chat', onChat);
    const view = document.createElement('div');
    view.className = 'files-pane file-view';
    view.addEventListener('find-in-file', () => file.push('file'));
    const code = document.createElement('div');
    code.className = 'file-editor';
    const editor = document.createElement('textarea');
    code.append(editor);
    view.append(code);
    // a file view with no code (an image, rendered Markdown) leaves ⌘F to the chat
    const image = document.createElement('div');
    image.className = 'files-pane file-view';
    const button = document.createElement('button');
    image.append(button);
    document.body.append(view, image);
    const press = () =>
      act(async () => {
        const e = new window.KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, bubbles: true, cancelable: true });
        (document.activeElement ?? window).dispatchEvent(e);
        return e.defaultPrevented;
      });
    editor.focus();
    assert.equal(await press(), true);
    assert.deepEqual([file, chat], [['file'], []]);
    editor.blur();
    await press();
    assert.deepEqual([file, chat], [['file'], [{ threadId: 'a' }]]);
    button.focus();
    await press();
    window.removeEventListener('find-in-chat', onChat);
    view.remove();
    image.remove();
    assert.deepEqual([file, chat], [['file'], [{ threadId: 'a' }, { threadId: 'a' }]]);
    await unmount();
  });
}
