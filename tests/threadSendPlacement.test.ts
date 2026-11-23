// A sent message goes near the top of the view with room for its reply, which grows there without pulling the view,
// as in Claude and ChatGPT desktop (#1779), on every harness; only added turns are placed.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, chat, view, callsTo, window, setStore, T, user, reply, turn } from './support/thread-view/fixture.ts';
import { scrollObserver } from './support/scroll-observer.ts';
import { addedTurn, latestMessage, responseSpace } from '../src/components/thread/view/responseSpace.ts';
import { viewHeight } from '../src/components/thread/view/turnWindow.tsx';

test('the room lets a turn reach the top of the view, and is never negative', () => {
  assert.equal(responseSpace(300, 60), 224);
  assert.equal(responseSpace(300, 60, 0), 240);
  assert.equal(responseSpace(300, 400), 0);
  assert.equal(responseSpace(300.9, 60), 224, 'whole pixels, so a fraction cannot grow the transcript');
});

test('the view is the scroller, or the window before it lays out, and never taller than the window (#2277)', () => {
  const scroller = (clientHeight: number) => ({ clientHeight }) as HTMLElement;
  assert.equal(viewHeight(scroller(300)), 300);
  assert.equal(viewHeight(scroller(0)), window.innerHeight, 'not laid out yet');
  assert.equal(viewHeight(null), window.innerHeight);
  assert.equal(viewHeight(scroller(window.innerHeight * 50)), window.innerHeight, 'a scroller its host does not bound');
});

test('only a turn added at the end is a send', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  assert.equal(addedTurn([a], [a, b]), true);
  assert.equal(addedTurn([], []), false, 'no turns');
  assert.equal(addedTurn([b], [a, b]), false, 'older history went in above');
  assert.equal(addedTurn([a, b], [a, { id: 'c' }]), false, 'the pending turn was renamed');
  assert.equal(addedTurn([a, b], [a]), false, 'a turn went away');
});

test('an empty transcript has no message to place', () => {
  assert.equal(latestMessage(window.document.createElement('div') as any), null);
});

/**
 * Layout the fake DOM cannot do: the view's top is 0, the last turn starts `slot` below it (1100px into the transcript
 * once a turn is sent), its message `note` px further down, with `content` px of turn and footer under the turn's top,
 * and the transcript ends with the room.
 */
async function open(t: TestContext, harness: string) {
  const observer = scrollObserver(t);
  const layout = { slot: 400, content: 60, note: 0 };
  chat([turn('t1', [user('u1', 'First'), reply('r1', 'Answer')])]);
  setStore({ segments: { [T]: [{ nativeId: harness === 'acp' ? 'acp:opencode:native' : T, harness, start: 0 }] } });
  const v = await render(view());
  const scroll = v.$('.thread-scroll')!;
  const room = () => v.$('.thread-response-space') as HTMLElement;
  const height = () => Number.parseInt(room().style.height || '0', 10);
  const proto = window.HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  t.after(() => {
    proto.getBoundingClientRect = original;
  });
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const slots = [...scroll.querySelectorAll(':scope > .thread-column > [data-turn-slot]')];
    const top =
      this === room()
        ? layout.slot + layout.content
        : this.closest('[data-turn-slot]') === slots.at(-1)
          ? layout.slot + (this.matches('[data-navigation-id]') ? layout.note : 0)
          : 0;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect;
  } as any;
  let top = 700;
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 1100 + layout.content + height() });
  Object.defineProperty(scroll, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value) => (top = value),
  });
  const scrolls: any[] = [];
  scroll.scrollTo = ((options: any) => {
    scrolls.push(options);
    top = options.top;
  }) as any;
  // the chat has painted: what arrives from here on is new
  await settle(() => observer.paint());
  const follows = () => (callsTo('scroll:observeBottom').at(-1)![2] as () => boolean)();
  const scrolled = () => settle(() => scroll.dispatchEvent(new window.Event('scroll') as any));
  const send = () =>
    settle(() =>
      chat([turn('t1', [user('u1', 'First'), reply('r1', 'Answer')]), turn('t2', [user('u2', 'Next')], { status: 'inProgress' })]),
    );
  return { v, scroll, layout, room, height, scrolls, follows, scrolled, send, observer, top: () => top };
}

for (const harness of ['codex', 'claude', 'acp']) {
  test(`${harness}: a send scrolls its message near the top with room below, and the reply does not pull the view`, async (t) => {
    const s = await open(t, harness);
    await s.send();
    assert.equal(s.height(), 224, 'room for the turn to reach 16px from the top of a 300px view');
    assert.deepEqual(s.scrolls, [{ top: 700 + 400 - 16, behavior: 'smooth' }]);
    await s.scrolled();
    assert.equal(s.follows(), false, 'the reply grows below the message instead of moving the view');
    assert.equal(s.v.$('.scroll-bottom'), null, 'only room lies below: nothing to scroll down to');

    // the reply grows into the room: the transcript keeps its height, so the view stays
    s.layout.content = 200;
    s.observer.notify(s.room().parentElement!);
    await settle(() => {});
    assert.equal(s.height(), 84);
    assert.equal(s.scroll.scrollHeight, 1384);
    // and past it: the view still stays, and offers the way down
    s.layout.content = 500;
    await settle(() => s.observer.notify(s.scroll));
    assert.equal(s.height(), 0);
    assert.equal(s.top(), 1084);
    assert.ok(s.v.$('.scroll-bottom'), 'the reply below the view offers the scroll-to-bottom button');

    await settle(() => s.v.$('.scroll-bottom')!.click());
    assert.equal(s.height(), 0, 'the button leaves no room to scroll into');
    assert.deepEqual(s.scrolls.at(-1), { top: 1600, behavior: 'smooth' });
    await settle(() => s.scroll.dispatchEvent(new window.Event('scrollend') as any));
    assert.equal(s.follows(), true, 'once there, the rest of the reply is followed');
    await s.v.unmount();
  });
}

test('a send far up the chat goes to its message at once', async (t) => {
  const s = await open(t, 'codex');
  s.layout.slot = 2000;
  await s.send();
  assert.equal(s.scrolls.at(-1).behavior, 'instant', 'no smooth scroll through the whole chat');
  await s.v.unmount();
});

test('a host that does not bound the scroller (#2277): the room fills the window once and never grows from its own height', async (t) => {
  const s = await open(t, 'acp');
  // the scroller is as tall as everything in it, the room included, as on a page that scrolls itself
  Object.defineProperty(s.scroll, 'clientHeight', { configurable: true, get: () => 1100 + s.layout.content + s.height() });
  await s.send();
  const once = s.height();
  assert.equal(once, window.innerHeight - 16 - 60, 'sized from the window, not from a scroller taller than it');
  for (let pass = 0; pass < 5; pass++) await settle(() => s.observer.notify(pass % 2 ? s.scroll : s.room().parentElement!));
  assert.equal(s.height(), once, 'layout passes leave the room as it was');
  await s.v.unmount();
});

test('a note above the message (a model change) is not room: the message itself reaches the top', async (t) => {
  const s = await open(t, 'claude');
  s.layout.note = 30;
  await s.send();
  assert.equal(s.height(), 300 - 16 - 30, 'measured from the message, which sits 30px into its turn');
  assert.deepEqual(s.scrolls, [{ top: 700 + 400 + 30 - 16, behavior: 'smooth' }]);
  await s.v.unmount();
});

test('a rewind or a turn with nothing to place ends the room', async (t) => {
  const s = await open(t, 'acp');
  await s.send();
  assert.equal(s.height(), 224);
  await settle(() => chat([turn('t1', [user('u1', 'First'), reply('r1', 'Answer')])]));
  assert.equal(s.height(), 0, 'the placed turn was rewound: no room under the turn before it');
  await s.send();
  assert.equal(s.height(), 224);
  await settle(() =>
    chat([
      turn('t1', [user('u1', 'First'), reply('r1', 'Answer')]),
      turn('t2', [user('u2', 'Next')]),
      turn('t3', [reply('r3', 'Unprompted')]),
    ]),
  );
  assert.equal(s.height(), 0);
  assert.equal(s.scrolls.length, 2, 'nothing to scroll to');
  await s.v.unmount();
});

test('the room is kept only for a placed turn: history, a renamed turn and the first load place nothing', async (t) => {
  const s = await open(t, 'claude');
  // older history going in above, and the pending turn renamed by the harness
  await settle(() => chat([turn('t0', [user('u0', 'Older')]), turn('t1', [user('u1', 'First'), reply('r1', 'Answer')])]));
  await settle(() => chat([turn('t0', [user('u0', 'Older')]), turn('t1b', [user('u1', 'First'), reply('r1', 'Answer')])]));
  // a turn with no message to place (nothing the reader sent)
  await settle(() =>
    chat([turn('t0', [user('u0', 'Older')]), turn('t1b', [user('u1', 'First')]), turn('t2', [reply('r2', 'Unprompted')])]),
  );
  assert.deepEqual(s.scrolls, []);
  assert.equal(s.height(), 0);
  await s.v.unmount();
});

test('a placed room goes when its chat changes, and with its turns', async (t) => {
  const s = await open(t, 'codex');
  await s.send();
  assert.equal(s.height(), 224);
  // every turn removed (a rewind to the start): no turn to keep room for
  await settle(() => chat([]));
  await settle(() => s.observer.notify(s.scroll));
  assert.equal(s.height(), 0);
  await s.send();
  assert.equal(s.height(), 224);
  // another chat, then one not known yet (the view shows only "Loading…")
  setStore({
    threads: { [T]: { id: T, cwd: '/repo' }, other: { id: 'other', cwd: '/repo' } },
    runtime: { other: { loaded: true, turns: [] } },
  });
  await s.v.rerender(view({ threadId: 'other' }));
  assert.equal(s.height(), 0, 'a new chat opens at its bottom, with no room');
  await s.v.rerender(view({ threadId: 'unknown' }));
  assert.equal(s.v.$('.thread-response-space'), null);
  await s.v.unmount();
});
