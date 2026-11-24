// A busy composer (src/components/composer/Composer.tsx, #5402) says why and does not stay busy: while a send prepares it is dimmed and refuses edits, and after BUSY_RELEASE_MS it takes edits again and says so in the renderer record, whatever the send is still waiting for.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { window } from './support/dom.ts';
import { all, events, fx, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';
import { deferred } from './support/async-scenarios.ts';
import { focusFixup, keyTarget, pressKey } from './support/focus-fixup.ts';
import { setRendererSink } from '../src/lib/rendererNote.ts';
// after the stand-ins in the setup are in place: a static import would bind the module to the real store
const { BUSY_RELEASE_MS } = await import('../src/components/composer/useBusyRelease.ts');

let uninstall = () => {};
const noted: any[] = [];
beforeEach(() => {
  reset();
  uninstall = focusFixup();
  noted.length = 0;
  setRendererSink((line) => noted.push(line));
});
afterEach(() => {
  uninstall();
  setRendererSink(null);
  mock.timers.reset();
});

const typeInto = async (el: Element, data = 'x') => {
  const ev = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data });
  await act(async () => void el.dispatchEvent(ev as any));
  return ev.defaultPrevented;
};

test('while a send prepares the editor is dimmed and refuses edits; past BUSY_RELEASE_MS it takes them again and the record says why it let go', async () => {
  store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
  const refs = deferred<any[]>();
  fx.refs = () => refs.promise;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('next step');
    m.editor().focus();
    // the release's clock starts when the editor turns busy
    mock.timers.enable({ apis: ['setTimeout'] });
    await pressKey('Enter');
    assert.equal(m.editor().getAttribute('aria-disabled'), 'true', 'busy: it looks busy');
    assert.equal(await typeInto(keyTarget()), true, 'and refuses a key');
    // a state that ends in time is never noted
    await act(async () => void mock.timers.tick(BUSY_RELEASE_MS - 1));
    assert.equal(m.editor().getAttribute('aria-disabled'), 'true');
    assert.deepEqual(
      noted.filter((n) => n.what === 'composerBusyReleased'),
      [],
    );
    await act(async () => void mock.timers.tick(1));
    assert.equal(m.editor().getAttribute('aria-disabled'), 'false', 'released: the editor takes edits again');
    assert.equal(await typeInto(keyTarget()), false);
    assert.deepEqual(
      noted.filter((n) => n.what === 'composerBusyReleased'),
      [{ what: 'composerBusyReleased', why: 'preparing', ms: BUSY_RELEASE_MS }],
    );
    mock.timers.reset();
    await act(async () => refs.resolve([]));
    await settle();
  } finally {
    await m.unmount();
  }
});

test('a send that finishes in time never releases or notes anything', async () => {
  store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
  const refs = deferred<any[]>();
  fx.refs = () => refs.promise;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('next step');
    m.editor().focus();
    await pressKey('Enter');
    await act(async () => refs.resolve([]));
    await settle();
    assert.equal(m.editor().getAttribute('aria-disabled'), 'false');
    mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => void mock.timers.tick(BUSY_RELEASE_MS * 2));
    assert.deepEqual(
      noted.filter((n) => n.what === 'composerBusyReleased'),
      [],
    );
  } finally {
    await m.unmount();
  }
});

test('after another app has run the turn for BUSY_RELEASE_MS the editor takes edits but still says why nothing can be sent, and a send says it too', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    events.length = 0;
    m.editor().focus();
    // the release's clock starts when the editor turns busy
    mock.timers.enable({ apis: ['setTimeout'] });
    setSessionState('t1', { runningElsewhere: true });
    await m.rerender();
    assert.equal(m.editor().getAttribute('aria-disabled'), 'true');
    await act(async () => void mock.timers.tick(BUSY_RELEASE_MS));
    mock.timers.reset();
    assert.equal(m.editor().getAttribute('aria-disabled'), 'false', 'released: edits are taken');
    assert.equal(
      m.editor().dataset.placeholder,
      'This chat is running in another app',
      'the reason stays while the chat cannot be sent to',
    );
    await m.type('after the release');
    await m.key('Enter');
    await settle();
    assert.equal(all('send').length, 0, 'the send still refuses');
    assert.deepEqual(
      all('toast').map((e) => e[1]),
      ['This chat is running in another app'],
      'and says why',
    );
    assert.equal(m.editor().textContent, 'after the release', 'the draft is kept');
  } finally {
    await m.unmount();
  }
});

test('text typed after the release while a send is still preparing is kept: the send gives way to it and says so', async () => {
  store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
  const refs = deferred<any[]>();
  fx.refs = () => refs.promise;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('next step');
    m.editor().focus();
    events.length = 0;
    mock.timers.enable({ apis: ['setTimeout'] });
    await pressKey('Enter');
    await act(async () => void mock.timers.tick(BUSY_RELEASE_MS));
    mock.timers.reset();
    assert.equal(m.editor().getAttribute('aria-disabled'), 'false');
    await m.type('next step and more');
    await act(async () => refs.resolve([]));
    await settle();
    assert.equal(all('send').length, 0, 'what was prepared is not what is in the editor: nothing goes out');
    assert.equal(m.editor().textContent, 'next step and more', 'the draft is not cleared');
    assert.deepEqual(
      all('toast').map((e) => e[1]),
      ['The message changed while it was sending. Send it again.'],
    );
    // sent again as it is now, it goes out
    await m.key('Enter');
    await settle();
    assert.deepEqual(
      all('send').map((e) => e[2]),
      ['next step and more'],
    );
  } finally {
    await m.unmount();
  }
});
