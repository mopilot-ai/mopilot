// The composer: a + menu for photo, camera and voice, and one round button that sends, or stops a running turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted, fakeMedia } from './support/phone/m3';

import { fakeDraft } from './support/phone/drafts';
const composerPath = '../mobile/src/components/Composer';
const threadPath = '../mobile/src/screens/Thread';
const { Composer } = await import(composerPath);
const { Thread } = await import(threadPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const button = (host: HTMLElement, label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
/** Whether the menu is shown: the view that holds a menu control carries `display`. */
const menuShown = (host: HTMLElement, label: string) => {
  for (let el = button(host, label)?.parentElement; el; el = el.parentElement) {
    const style = el.dataset.style && JSON.parse(el.dataset.style);
    if (style?.display) return style.display === 'flex';
  }
  throw new Error(`no menu around ${label}`);
};
const props = (over: Record<string, unknown> = {}) => ({
  draft: '',
  setDraft: () => {},
  placeholder: 'Message this chat',
  focusKey: 'message',
  autoFocus: false,
  running: false,
  disabled: false,
  stopDisabled: false,
  send: () => {},
  stop: () => {},
  ...over,
});

test('one round button sends, or stops a running turn while nothing is typed', async () => {
  const calls: string[] = [];
  const idle = await mount(createElement(Composer, props({ draft: 'hi', send: () => calls.push('send'), stop: () => calls.push('stop') })));
  assert.equal(button(idle.host, 'Stop this chat’s turn'), null);
  await click('Send message');
  assert.deepEqual(calls, ['send']);
  await idle.done();

  const running = await mount(
    createElement(Composer, props({ running: true, send: () => calls.push('send'), stop: () => calls.push('stop') })),
  );
  assert.equal(button(running.host, 'Send message'), null);
  await click('Stop this chat’s turn');
  assert.deepEqual(calls, ['send', 'stop']);
  await running.done();

  // text typed while a turn runs is a follow-up: the round button sends it, and a Stop link stays above the field
  const typing = await mount(createElement(Composer, props({ running: true, draft: 'also do this', stop: () => calls.push('stop 2') })));
  assert.ok(button(typing.host, 'Send message'));
  await click('Stop this chat’s turn');
  assert.equal(calls.at(-1), 'stop 2');
  await typing.done();
  const held2 = await mount(createElement(Composer, props({ running: true, draft: 'x', stopDisabled: true })));
  assert.equal(button(held2.host, 'Stop this chat’s turn')!.disabled, true);
  await held2.done();

  const off = await mount(createElement(Composer, props({ disabled: true })));
  assert.equal(button(off.host, 'Send message')!.disabled, true);
  await off.done();
  const held = await mount(createElement(Composer, props({ running: true, stopDisabled: true })));
  assert.equal(button(held.host, 'Stop this chat’s turn')!.disabled, true);
  await held.done();
});

test('the + button opens Add to session, the mic opens and closes the voice menu, and the thumbnails sit inside the box', async () => {
  const none = await mount(createElement(Composer, props()));
  assert.equal(button(none.host, 'Add to session'), null, 'without media there is no +');
  assert.equal(button(none.host, 'Dictate'), null, 'and no mic');
  await none.done();

  let added = 0;
  const v = await mount(
    createElement(
      Composer,
      props({
        menu: createElement('button', { 'aria-label': 'Menu item' }, 'Voice'),
        onAttach: () => added++,
        tray: createElement('span', { 'aria-label': 'Tray' }, 'tray'),
        placeholder: 'What should change in the plan?',
        autoFocus: true,
      }),
    ),
  );
  assert.ok(v.host.querySelector('input[placeholder="What should change in the plan?"]'));
  assert.ok(v.host.querySelector('[aria-label="Tray"]'));
  await click('Add to session');
  assert.equal(added, 1);
  assert.equal(menuShown(v.host, 'Menu item'), false);
  await click('Dictate');
  assert.equal(menuShown(v.host, 'Menu item'), true);
  assert.ok(button(v.host, 'Send message'), 'the mic sits beside send; it does not replace it');
  await click('Close dictation');
  assert.equal(menuShown(v.host, 'Menu item'), false);
  await v.done();

  // something going on in the menu holds it open, and its close button then does nothing
  const held = await mount(
    createElement(Composer, props({ menu: createElement('button', { 'aria-label': 'Menu item' }, 'Voice'), menuOpen: true })),
  );
  assert.equal(menuShown(held.host, 'Menu item'), true);
  assert.equal(button(held.host, 'Close dictation')!.disabled, true, 'it cannot be closed while a recording is going on');
  await held.done();
});

test('in a chat the mic holds the voice note and + opens the sheet; a recording keeps the voice menu open until it is cancelled', async () => {
  const { runtime } = scripted((m) =>
    m === 'chat.follow' ? { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] } : undefined,
  );
  const v = await mount(
    createElement(Thread, {
      runtime,
      chatId: 'c',
      back: () => {},
      drafts: fakeDraft(''),
      media: fakeMedia().media,
    }),
  );
  assert.equal(menuShown(v.host, 'Record voice note'), false);
  await click('Dictate');
  assert.equal(menuShown(v.host, 'Record voice note'), true);
  await click('Close dictation');
  await click('Dictate');
  await click('Record voice note');
  assert.equal(menuShown(v.host, 'Cancel recording'), true, 'a recording is not hidden by closing the menu');
  await click('Cancel recording');
  assert.equal(menuShown(v.host, 'Record voice note'), true);
  await v.done();
});

test('a chat that is running offers Stop when nothing is typed, and stopping asks the computer', async () => {
  const { runtime, calls } = scripted((m) =>
    m === 'chat.follow' ? { rev: 1, feedSeq: 0, session: { turn: 'running', cards: [] }, itemsShape: 'rows', items: [] } : undefined,
  );
  const v = await mount(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') }));
  await click('Stop this chat’s turn');
  assert.ok(calls.some(([m]) => m === 'chat.stop'));
  await v.done();
});

test('a turn that waits for you can be stopped too, not only one that is working', async () => {
  const { runtime, calls } = scripted((m) =>
    m === 'chat.follow' ? { rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards: [] }, itemsShape: 'rows', items: [] } : undefined,
  );
  const v = await mount(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') }));
  await click('Stop this chat’s turn');
  assert.ok(calls.some(([m]) => m === 'chat.stop'));
  await v.done();
});
