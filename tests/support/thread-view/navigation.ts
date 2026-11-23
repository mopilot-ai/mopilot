// Conversation-view UI unit cases for navigation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Fragment,
  render,
  settle,
  setStore,
  impl,
  callsTo,
  window,
  defined,
  flush,
  navProps,
  T,
  user,
  turn,
  chat,
  view,
} from './fixture.ts';

export function registerNavigation() {
  test('the chat is history once painted: later items arrive animated', async () => {
    chat([turn('t1', [user('ar-u', 'hi')], { status: 'inProgress' })], { activeTurnId: 't1', loaded: false });
    const v = await render(view());
    await settle(() => chat([turn('t1', [user('ar-u', 'hi')], { status: 'inProgress' })], { activeTurnId: 't1', loaded: true }));
    await flush();
    await settle(() => chat([turn('t1', [user('ar-u', 'hi'), user('ar-u2', 'more')], { status: 'inProgress' })], { activeTurnId: 't1' }));
    assert.equal(v.$$('.item-enter .user-message').length, 1);
    // a just-completed turn still animates what lands with its completion
    await settle(() =>
      chat([turn('t1', [user('ar-u', 'hi'), user('ar-u2', 'more'), user('ar-u3', 'last')], { completedAt: Date.now() / 1000 })]),
    );
    assert.equal(v.$$('.item-enter .user-message').length, 2);
    await v.unmount();
    void Fragment;
  });

  test('switching chats leaves exactly one navigation rail and one selection toolbar', async () => {
    const other = 'other';
    setStore({
      threads: { [T]: { id: T, cwd: '/repo' }, [other]: { id: other, cwd: '/repo' } },
      runtime: {
        [T]: { loaded: true, turns: [turn('t1', [user('u1', 'hi')])] },
        [other]: { loaded: true, turns: [turn('t2', [user('u2', 'yo')])] },
      },
    });
    const v = await render(view());
    for (const id of [other, T, other, T]) {
      await v.rerender(view({ threadId: id }));
      assert.equal(v.$$('[data-stub="TurnNavigation"]').length, 1);
      assert.equal(v.$$('[data-stub="SelectionToolbar"]').length, 1);
    }
  });

  test('the navigation rail jumps to a message, and earlier history returns to the message being read', async () => {
    const older = turn('t0', [user('u0', 'first')]);
    chat([older, turn('t1', [user('u1', 'second')])], { olderCursor: 'c1' });
    const v = await render(view());
    await flush();
    const scroller = v.$('.thread-scroll')!;
    const scrolledTo: any[] = [];
    (scroller as any).scrollTo = (o: any) => scrolledTo.push(o);
    const anchors = v.$$('[data-navigation-id]');
    anchors.forEach((a, i) => {
      a.getBoundingClientRect = () => ({ top: 100 + i * 300 }) as DOMRect;
    });
    scroller.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
    // tall enough for each message to reach the top: a jump goes no further than the transcript can scroll
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 5000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 300 });
    scroller.scrollTop = 400;
    assert.deepEqual(
      navProps.items.map((i: any) => i.id),
      anchors.map((a) => a.dataset.navigationId),
    );
    // an id with no message on screen does nothing
    await settle(() => navProps.onNavigate('missing'));
    assert.deepEqual(scrolledTo, [] as any[]);
    await settle(() => navProps.onNavigate(navProps.items[1].id));
    assert.deepEqual(scrolledTo, [{ top: 400 + 400 - 50 - 16, behavior: 'smooth' }]);
    assert.ok(v.$('.scroll-bottom'), 'leaving the bottom shows the scroll-to-bottom button');
    await settle(() => navProps.onNavigate(navProps.items[0].id, true));
    assert.deepEqual(scrolledTo[1], { top: 400 + 100 - 50 - 16, behavior: 'instant' });

    // older history: one load at a time, then back to the message the rail jumped to
    let release!: () => void;
    impl['store:loadOlderTurns'] = () => new Promise<void>((r) => (release = r));
    const first = navProps.onLoadOlder();
    assert.equal(navProps.onLoadOlder(), first);
    await settle(() => release());
    await flush();
    await settle(() => first);
    assert.deepEqual(scrolledTo[2], { top: 400 + 100 - 50 - 16, behavior: 'instant' });
    assert.equal(callsTo('store:loadOlderTurns').length, 1);

    // a pointer press or a scrolling key on the transcript forgets the jump: the reading position is kept instead
    for (const forget of [
      () => scroller.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }) as any),
      () => scroller.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }) as any),
    ]) {
      await settle(() => navProps.onNavigate(navProps.items[0].id, true));
      await settle(forget);
      const load = navProps.onLoadOlder();
      await settle(() => release());
      await flush();
      await settle(() => load);
    }
    assert.equal(scrolledTo.length, 5);
    // modified keys, other keys, or keys from inside the transcript are not scrolling by the user
    for (const [target, init] of [
      [scroller, { key: 'PageUp', altKey: true }],
      [scroller, { key: 'PageUp', metaKey: true }],
      [scroller, { key: 'PageUp', ctrlKey: true }],
      [scroller, { key: 'a' }],
      [anchors[0], { key: 'PageUp' }],
    ] as const) {
      await settle(() => navProps.onNavigate(navProps.items[0].id, true));
      await settle(() => target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ...init }) as any));
      const load = navProps.onLoadOlder();
      await settle(() => release());
      await flush();
      await settle(() => load);
      assert.equal(defined(scrolledTo.at(-1)).behavior, 'instant');
    }

    // a failed page says why, whatever was thrown
    impl['store:loadOlderTurns'] = () => Promise.reject(new Error('offline'));
    await settle(() => navProps.onLoadOlder());
    await flush();
    impl['store:loadOlderTurns'] = () => Promise.reject('timeout');
    await settle(() => navProps.onLoadOlder());
    await flush();
    assert.deepEqual(callsTo('store:toast'), [
      ["Couldn't load earlier messages: offline", 'error'],
      ["Couldn't load earlier messages: timeout", 'error'],
    ]);
    // nothing older: nothing to load
    await settle(() => chat([older], {}));
    await settle(() => navProps.onLoadOlder());
    assert.equal(callsTo('store:loadOlderTurns').length, 10);
    await v.unmount();
  });

  test('⌘F for the chat opens its find bar over the transcript, which finds its prompts and closes on Escape', async () => {
    chat([turn('t1', [user('f1', 'where is the cache')]), turn('t2', [user('f2', 'cache again')])], { olderCursor: 'c1' });
    const v = await render(view());
    await flush();
    assert.equal(v.$('.chat-find'), null);
    await settle(() => window.dispatchEvent(new window.CustomEvent('find-in-chat', { detail: { threadId: T } }) as any));
    const input = v.$('.chat-find-input') as HTMLInputElement;
    assert.equal(window.document.activeElement, input);
    // earlier history is a page away
    assert.equal(v.$('.chat-find-older')!.textContent, 'Search earlier');
    await settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Cache');
      input.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
    });
    await flush();
    assert.equal(v.$('.chat-find-count')!.textContent, '2 of 2');
    await settle(() => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as any));
    assert.equal(v.$('.chat-find'), null);
    await v.unmount();
  });
}
