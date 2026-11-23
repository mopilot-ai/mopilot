// The composer keeps the keyboard through a send (#1658): Esc right after Enter stops the running turn, and the next
// message is typed into the editor. Keys go to whatever has the focus, with Chromium's focus fixup emulated.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { window } from './support/dom.ts';
import { $, click } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, settle, store } from './support/composer-setup.ts';
import { deferred } from './support/async-scenarios.ts';
import { focusFixup, keyTarget, pressKey } from './support/focus-fixup.ts';

let uninstall = () => {};
beforeEach(() => {
  reset();
  uninstall = focusFixup();
});
afterEach(() => uninstall());

/** A beforeinput the way typing sends it; true when the editor refused the edit. */
const typeInto = async (el: Element, data = 'x') => {
  const ev = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data });
  await act(async () => void el.dispatchEvent(ev as any));
  return ev.defaultPrevented;
};

test('Esc pressed right after Enter stops the running turn while the send prepares, and typing goes to the editor', async () => {
  store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
  const refs = deferred<any[]>();
  fx.refs = () => refs.promise;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('next step');
    m.editor().focus();
    await pressKey('Enter');
    // the send is preparing: the editor takes no edits but keeps the keyboard
    assert.equal(m.editor().getAttribute('aria-disabled'), 'true');
    assert.equal(keyTarget(), m.editor());
    assert.equal(m.editor().isContentEditable, true);
    assert.equal(await typeInto(keyTarget()), true);
    assert.equal(await pressKey('Escape'), true);
    assert.deepEqual(last('interrupt'), ['interrupt', 't1']);
    await act(async () => refs.resolve([]));
    await settle();
    assert.equal(all('send').length, 1);
    assert.equal(last('send')![2], 'next step');
    // after the send the next keys still reach the editor, which takes them again
    assert.equal(keyTarget(), m.editor());
    assert.equal(m.editor().getAttribute('aria-disabled'), 'false');
    assert.equal(await typeInto(keyTarget()), false);
    assert.equal(await pressKey('Escape'), true);
    assert.equal(all('interrupt').length, 2);
  } finally {
    await m.unmount();
  }
});

test('while a send prepares, paste adds nothing and cut copies without removing; both work again afterwards', async () => {
  const refs = deferred<any[]>();
  fx.refs = () => refs.promise;
  const calls: string[] = [];
  const original = document.execCommand;
  (document as any).execCommand = (command: string) => (calls.push(command), true);
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('keep this');
    m.editor().focus();
    await pressKey('Enter');
    const clip = async (type: string) => {
      const data = new window.DataTransfer();
      data.setData('text/plain', 'pasted');
      window.getSelection()!.selectAllChildren(m.editor());
      const ev = new window.ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data });
      await act(async () => void m.editor().dispatchEvent(ev as any));
      return { prevented: ev.defaultPrevented, copied: data.getData('text/plain') };
    };
    assert.equal((await clip('paste')).prevented, true);
    const cut = await clip('cut');
    assert.equal(cut.prevented, true);
    assert.equal(cut.copied, 'keep this');
    assert.deepEqual(calls, []);
    assert.equal(m.text, 'keep this');
    await act(async () => refs.resolve([]));
    await settle();
    await m.type('again');
    await clip('paste');
    await clip('cut');
    assert.deepEqual(calls, ['insertText', 'delete']);
  } finally {
    (document as any).execCommand = original;
    await m.unmount();
  }
});

test('a new chat that is starting keeps the editor focused, and Enter again does not send twice', async () => {
  const started = deferred<void>();
  fx.sendAnswer = () => started.promise;
  const m = await mountComposer({ threadId: null });
  try {
    await m.type('start here');
    m.editor().focus();
    await pressKey('Enter');
    await settle();
    assert.ok($('[aria-label="Starting chat"]'));
    assert.equal(keyTarget(), m.editor());
    assert.equal(await typeInto(keyTarget()), true);
    await pressKey('Enter');
    await settle();
    assert.equal(all('send').length, 1);
    await act(async () => started.resolve());
    await settle();
    assert.equal(keyTarget(), m.editor());
    assert.equal(await typeInto(keyTarget()), false);
  } finally {
    await m.unmount();
  }
});

test('clicking Send or Stop hands the keyboard to the editor, so Esc and the next message reach it', async () => {
  store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('queued');
    const sendBtn = $('[aria-label="Send"]');
    sendBtn.focus();
    await click(sendBtn);
    await settle();
    assert.equal(last('send')![2], 'queued');
    assert.equal(keyTarget(), m.editor());
    const stop = $('[aria-label="Stop"]');
    stop.focus();
    await click(stop);
    assert.deepEqual(last('interrupt'), ['interrupt', 't1']);
    assert.equal(keyTarget(), m.editor());
  } finally {
    await m.unmount();
  }
});

test('a Stop that fails says so', async () => {
  store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    fx.stopFails = new Error('no session');
    await click($('[aria-label="Stop"]'));
    await settle();
    assert.deepEqual(last('toast')!.slice(1), ["Couldn't stop: no session", 'error']);
  } finally {
    await m.unmount();
  }
});
