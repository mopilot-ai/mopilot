// Response following keeps its intent through input without movement and layout changes on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  render,
  settle,
  flush,
  chat,
  view,
  callsTo,
  window,
  setStore,
  T,
  navProps,
  impl,
  user,
  turn,
  realObserveBottom,
} from './support/thread-view/fixture.ts';
import { scrollObserver } from './support/scroll-observer.ts';

async function open(harness = 'codex') {
  chat([]);
  setStore({ segments: { [T]: [{ nativeId: harness === 'acp' ? 'acp:opencode:native' : T, harness, start: 0 }] } });
  const v = await render(view());
  const scroll = v.$('.thread-scroll')!;
  const size = { scrollHeight: 1000, clientHeight: 300 };
  for (const key of ['scrollHeight', 'clientHeight'] as const)
    Object.defineProperty(scroll, key, { configurable: true, get: () => size[key] });
  await flush();
  scroll.scrollTop = 700;
  const scrolled = () => settle(() => scroll.dispatchEvent(new window.Event('scroll') as any));
  await scrolled();
  const follows = callsTo('scroll:observeBottom').at(-1)![2] as () => boolean;
  return { v, scroll, size, scrolled, follows };
}

for (const harness of ['codex', 'claude', 'acp']) {
  test(`${harness}: a downward wheel at the bottom, horizontal wheel and touch without scrolling keep following`, async () => {
    const t = await open(harness);
    const zoom = new window.WheelEvent('wheel', { deltaY: -80, bubbles: true });
    Object.defineProperty(zoom, 'ctrlKey', { value: true });
    for (const event of [
      new window.WheelEvent('wheel', { deltaY: 80, bubbles: true }),
      new window.WheelEvent('wheel', { deltaX: 80, bubbles: true }),
      zoom,
      new window.Event('touchstart', { bubbles: true }),
    ]) {
      await settle(() => t.scroll.dispatchEvent(event as any));
      assert.equal(t.follows(), true, `${event.type} without scrolling cannot leave following stuck off`);
    }
    await t.v.unmount();
  });
}

test('a fresh session viewport yields to upward input before its opening frame and keeps that position on rerender', async (t) => {
  const observer = scrollObserver(t);
  impl['scroll:observeBottom'] = realObserveBottom;
  const other = 'other';
  setStore({
    threads: { [T]: { id: T, cwd: '/repo' }, [other]: { id: other, cwd: '/repo' } },
    runtime: { [T]: { loaded: true, turns: [] }, [other]: { loaded: true, turns: [] } },
  });
  const v = await render(view());
  await v.rerender(view({ threadId: other }));
  const scroll = v.$('.thread-scroll')!;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
  scroll.scrollTop = 300;
  await settle(() => scroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }) as any));
  await settle(() => observer.paint());
  assert.equal(scroll.scrollTop, 300, 'the opening frame yields to the reader');
  await v.rerender(view({ threadId: other, readOnly: true }));
  observer.notify(v.$('.thread-column')!);
  await settle(() => observer.paint());
  assert.equal(v.$('.thread-scroll')!.scrollTop, 300, 'same-session renders preserve the reading position');
  assert.ok(v.$('.scroll-bottom'));
  await v.unmount();
});

test('rapid switches retire the old opening frames and history loading still opens at the end', async (t) => {
  const observer = scrollObserver(t);
  impl['scroll:observeBottom'] = realObserveBottom;
  const other = 'other';
  setStore({
    threads: { [T]: { id: T, cwd: '/repo' }, [other]: { id: other, cwd: '/repo' } },
    runtime: { [T]: { loaded: true, turns: [] }, [other]: { loaded: false, loading: true, turns: [] } },
  });
  const v = await render(view());
  const retired = v.$('.thread-scroll')!;
  await v.rerender(view({ threadId: other }));
  await v.rerender(view());
  await v.rerender(view({ threadId: other }));
  await settle(() => setStore({ runtime: { [T]: { loaded: true, turns: [] }, [other]: { loaded: true, turns: [] } } }));
  const scroll = v.$('.thread-scroll')!;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
  await settle(() => retired.dispatchEvent(new window.Event('scroll') as any));
  await settle(() => observer.paint());
  assert.equal(scroll.scrollTop, 2000);
  assert.equal(v.$('.scroll-bottom'), null);
  await v.unmount();
  assert.equal(observer.watching, 0);
  assert.equal(observer.pending, 0);
});

test('growth or a smaller viewport before the next follow frame does not count as the reader leaving the bottom', async () => {
  const t = await open();
  t.size.scrollHeight = 1200;
  await t.scrolled();
  assert.equal(t.follows(), true, 'growth changed the bottom, not the reader intent');
  t.size.clientHeight = 200;
  await t.scrolled();
  assert.equal(t.follows(), true, 'a composer or window resize preserves following');
  await t.v.unmount();
});

for (const harness of ['codex', 'claude', 'acp']) {
  test(`${harness}: switching cached chats opens at the end despite a clamped scroll event before the opening frame`, async (t) => {
    const observer = scrollObserver(t);
    impl['scroll:observeBottom'] = realObserveBottom;
    const other = 'other';
    setStore({
      threads: { [T]: { id: T, cwd: '/repo' }, [other]: { id: other, cwd: '/repo' } },
      runtime: { [T]: { loaded: true, turns: [] }, [other]: { loaded: true, turns: [] } },
      segments: Object.fromEntries([T, other].map((id) => [id, [{ nativeId: id, harness, start: 0 }]])),
    });
    const v = await render(view());
    const size = (scroll: HTMLElement) => {
      Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
    };
    size(v.$('.thread-scroll')!);
    await settle(() => observer.paint());
    for (const id of [other, T, other, T]) {
      const before = v.$('.thread-scroll')!;
      before.scrollTop = 700;
      await settle(() => before.dispatchEvent(new window.Event('scroll') as any));
      await v.rerender(view({ threadId: id }));
      const scroll = v.$('.thread-scroll')!;
      size(scroll);
      // Layout first clamps the old offset; the new transcript grows before that scroll event is delivered.
      scroll.scrollTop = 300;
      await settle(() => scroll.dispatchEvent(new window.Event('scroll') as any));
      await settle(() => observer.paint());
      assert.equal(scroll.scrollTop, 1000, 'the previous viewport cannot cancel the new chat opening at its end');
      assert.equal(v.$('.scroll-bottom'), null);
    }
    await v.unmount();
    assert.equal(observer.watching, 0);
  });
}

test('a pending initial-position frame yields to upward input', async () => {
  chat([]);
  const v = await render(view());
  const scroll = v.$('.thread-scroll')!;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
  scroll.scrollTop = 500;
  await settle(() => scroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }) as any));
  await flush();
  assert.equal(scroll.scrollTop, 500);
  await v.unmount();
});

test('following yields to a smooth bottom jump, then follows the current bottom when it finishes', async () => {
  const t = await open();
  t.scroll.scrollTop = 300;
  await t.scrolled();
  const calls: any[] = [];
  t.scroll.scrollTo = (options: any) => calls.push(options);
  await settle(() => t.v.$('.scroll-bottom')!.click());
  assert.equal(t.follows(), false, 'resize following cannot cancel the smooth jump');
  t.scroll.scrollTop = 500;
  await t.scrolled();
  assert.equal(t.follows(), false, 'an intermediate smooth-scroll event does not give the observer ownership');
  t.size.scrollHeight = 1400;
  await settle(() => t.scroll.dispatchEvent(new window.Event('scrollend') as any));
  assert.equal(t.scroll.scrollTop, 1400);
  assert.equal(t.follows(), true);
  assert.deepEqual(calls, [{ top: 1000, behavior: 'smooth' }]);
  await t.v.unmount();
});

test('a bottom jump that cannot move resumes without waiting for a scrollend that will never arrive', async () => {
  const t = await open();
  t.scroll.scrollTo = () => {};
  await settle(() => t.scroll.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -10, bubbles: true }) as any));
  await settle(() => t.v.$('.scroll-bottom')!.click());
  assert.equal(t.follows(), true);
  assert.equal(t.v.$('.scroll-bottom'), null, 'a nonmoving recovery must also dismiss the control');
  await t.v.unmount();
});

test('a reader moving before the programmatic scroll event still pauses relative to the last follow write', async (t) => {
  const observer = scrollObserver(t);
  impl['scroll:observeBottom'] = realObserveBottom;
  chat([]);
  const v = await render(view());
  const scroll = v.$('.thread-scroll')!;
  const column = v.$('.thread-column')!;
  let height = 1000;
  let top = 0;
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value) => {
      top = Math.max(0, Math.min(height - 300, value));
    },
  });
  await settle(() => observer.paint());
  assert.equal(top, 700);
  height = 1200;
  observer.notify(column);
  observer.paint();
  assert.equal(top, 900);
  // A touch/scrollbar movement coalesces with the programmatic scroll event; no preceding scroll event is delivered.
  top = 800;
  await settle(() => scroll.dispatchEvent(new window.Event('scroll') as any));
  assert.ok(v.$('.scroll-bottom'));
  height = 1400;
  observer.notify(column);
  observer.paint();
  assert.equal(top, 800, 'the resize follower cannot take over the reader after an undelivered programmatic event');
  await v.unmount();
});

test('navigation and a pending history load own the viewport until released', async () => {
  const t = await open();
  await settle(() => chat([turn('t1', [user('u1', 'Earlier prompt')])], { olderCursor: 'page' }));
  t.scroll.scrollTo = () => {};
  await settle(() => navProps.onNavigate(navProps.items[0].id, true));
  t.size.scrollHeight = 1500;
  await t.scrolled();
  assert.equal(t.follows(), false, 'growth cannot cancel a message navigation lock');
  let release!: () => void;
  impl['store:loadOlderTurns'] = () => new Promise<void>((resolve) => (release = resolve));
  const load = navProps.onLoadOlder();
  assert.equal(t.follows(), false);
  await settle(() => release());
  await flush();
  await settle(() => load);
  assert.equal(t.follows(), false, 'history restoration retains the navigation target');
  await t.v.unmount();
});

test('a real upward scroll pauses; downward scrolling back to the bottom resumes', async () => {
  const t = await open();
  t.scroll.scrollTop = 400;
  await t.scrolled();
  assert.equal(t.follows(), false);
  assert.ok(t.v.$('.scroll-bottom'));
  t.size.scrollHeight = 1200;
  await t.scrolled();
  assert.equal(t.follows(), false, 'streamed output does not take over a paused reader');
  t.scroll.scrollTop = 900;
  await t.scrolled();
  assert.equal(t.follows(), true);
  await t.v.unmount();
});

test('downward scroll keys at the bottom preserve following; an upward key yields before a follow frame', async () => {
  const t = await open();
  for (const key of ['ArrowDown', 'PageDown', 'End', ' ']) {
    await settle(() => t.scroll.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }) as any));
    assert.equal(t.follows(), true, `${key} cannot pause a viewport that has nowhere further down to scroll`);
  }
  await settle(() => t.scroll.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true }) as any));
  assert.equal(t.follows(), false, 'Shift+Space scrolls upward');
  await t.v.unmount();
});

test('scrolling a nested output preserves the transcript follow state', async () => {
  const t = await open();
  const output = window.document.createElement('pre');
  output.style.overflowY = 'auto';
  Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 500 });
  Object.defineProperty(output, 'clientHeight', { configurable: true, value: 100 });
  output.scrollTop = 100;
  t.v.$('.thread-column')!.append(output as any);
  await settle(() => output.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -50, bubbles: true })));
  assert.equal(t.follows(), true, 'the nested output, rather than the transcript, consumes the wheel');
  await t.v.unmount();
});

test('a gentle upward wheel stays paused within the old bottom tolerance and keeps a recovery control', async () => {
  const t = await open();
  await settle(() => t.scroll.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -10, bubbles: true }) as any));
  assert.equal(t.follows(), false);
  assert.ok(t.v.$('.scroll-bottom'), 'pausing must expose the way to resume even before a scroll event');
  t.scroll.scrollTop = 690;
  await t.scrolled();
  assert.equal(t.follows(), false, 'a gentle upward gesture does not immediately rejoin within 40px of the bottom');
  await t.v.unmount();
});
