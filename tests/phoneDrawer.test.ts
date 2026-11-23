// The drawer behind Chats: its destinations, pinned and recent chats, initials and New chat; the page sliding aside; and the Chats header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const drawerPath = '../mobile/src/components/Drawer';
const homeDrawerPath = '../mobile/src/screens/HomeDrawer';
const homePath = '../mobile/src/screens/Home';
const statePath = '../mobile/src/presentation/sessionState';
const themePath = '../mobile/src/theme';
const { DrawerPanel, DrawerFrame, DRAWER_WIDTH, PAGE_CORNER, SETTLE_AT, SETTLE_VELOCITY, EDGE_WIDTH, OFFSET, DIM, dragTo, settlesOpen } =
  await import(drawerPath);
const motionPath = '../mobile/src/motion';
const { spring } = await import(motionPath);
const { HomeDrawerPanel, DRAWER_RECENTS } = await import(homeDrawerPath);
const { Home } = await import(homePath);
const { sessionState, initialsOf } = await import(statePath);
const { light } = await import(themePath);

async function render(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    rerender: async (next: any) => act(async () => root.render(next)),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const button = (host: HTMLElement, label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const press = async (el: Element | null) => {
  assert.ok(el, 'button present');
  await act(async () => (el as HTMLButtonElement).click());
};
const styleOf = (el: Element) => JSON.parse((el as HTMLElement).dataset.style ?? '{}');

test('chat states map onto Claude’s glyphs: a finished turn nobody opened is a blue dot', () => {
  assert.equal(sessionState('needsYou'), 'waiting');
  assert.equal(sessionState('running'), 'working');
  assert.equal(sessionState('failed'), 'stopped');
  assert.equal(sessionState('done'), 'new');
  for (const chip of ['quiet', 'idle', 'offline']) assert.equal(sessionState(chip), 'idle');
});

test('initials come from the name’s first two words, else the email, else a dot', () => {
  assert.equal(initialsOf({ name: 'du  zhang lee' }), 'DZ');
  assert.equal(initialsOf({ name: 'Cher' }), 'C');
  assert.equal(initialsOf({ name: '  ', email: 'meggie@example.com' }), 'M');
  assert.equal(initialsOf({}), '·');
  assert.equal(initialsOf(null), '·');
});

test('the panel: destinations with the current one selected, Pinned and Recents only when there are any, initials and New chat', async () => {
  const seen: string[] = [];
  const panel = (extra: Record<string, unknown>) =>
    createElement(DrawerPanel, {
      destinations: [
        { key: 'chats', title: 'Chats', icon: createElement('span', null, 'c'), onPress: () => seen.push('chats') },
        { key: 'scheduled', title: 'Scheduled', icon: createElement('span', null, 's'), onPress: () => seen.push('scheduled') },
      ],
      current: 'chats',
      pinned: [{ id: 'p', title: 'Release checklist', state: 'idle' }],
      recents: [{ id: 'r', title: 'Fix login', state: 'waiting' }],
      openChat: (id: string) => seen.push(`open:${id}`),
      initials: 'DZ',
      settings: () => seen.push('settings'),
      ...extra,
    });
  const r = await render(panel({ newChat: () => seen.push('new'), search: () => seen.push('search') }));
  assert.equal(button(r.host, 'Chats')!.getAttribute('aria-selected'), 'true');
  assert.equal(button(r.host, 'Scheduled')!.getAttribute('aria-selected'), 'false');
  const headers = [...r.host.querySelectorAll('[role="header"]')].map((n) => n.textContent);
  assert.deepEqual(headers, ['Pinned', 'Recents']);
  for (const label of ['Chats', 'Scheduled', 'Release checklist', 'Fix login', 'Settings', 'New chat', 'Search chats'])
    await press(button(r.host, label));
  assert.deepEqual(seen, ['chats', 'scheduled', 'open:p', 'open:r', 'settings', 'new', 'search']);
  assert.ok(r.host.textContent!.includes('DZ'));
  assert.ok(r.host.querySelector('[data-symbol="hand.raised"]'), 'a waiting chat shows the hand');
  await r.rerender(panel({ pinned: [], recents: [] }));
  assert.equal(r.host.querySelectorAll('[role="header"]').length, 0, 'empty sections are not drawn');
  assert.equal(button(r.host, 'New chat'), null);
  assert.equal(button(r.host, 'Search chats'), null);
  await r.done();
});

const frame = (open: boolean, extra: Record<string, unknown> = {}) =>
  createElement(
    DrawerFrame,
    { open, close: () => {}, drawer: createElement('span', null, 'drawer'), ...extra },
    createElement('span', null, 'page'),
  );
const timings = () => (globalThis as any).__phoneTimings as { to: number; config: any; spring?: boolean }[];
const SPAN = 390 * DRAWER_WIDTH;

test('the frame slides the page 75.4 % right with a 44 pt corner on the measured spring, and the visible strip closes it', async () => {
  let closed = 0;
  (globalThis as any).__phoneTimings = [];
  const r = await render(frame(false, { close: () => closed++ }));
  const page = () => [...r.host.querySelectorAll('[data-style]')].find((n) => 'boxShadow' in styleOf(n))!;
  assert.equal(DRAWER_WIDTH, 0.754, 'Claude’s sidebar is 75.4 % of the width');
  assert.equal(styleOf(page()).transform[0].translateX, 0);
  assert.equal(button(r.host, 'Close menu'), null);
  await r.rerender(frame(true, { close: () => closed++ }));
  assert.deepEqual(timings().at(-1), { to: 1, config: { ...spring.drawer, velocity: 0 }, spring: true });
  assert.equal(spring.drawer.stiffness, 880, 'ω = 29.7 rad/s as measured, critically damped');
  assert.ok(Math.abs(spring.drawer.damping - 2 * Math.sqrt(880)) < 1e-9);
  await r.rerender(frame(true, { close: () => closed++ }));
  assert.equal(styleOf(page()).transform[0].translateX, SPAN);
  assert.equal(styleOf(page()).borderRadius, PAGE_CORNER);
  await press(button(r.host, 'Close menu'));
  assert.equal(closed, 1);
  await r.done();
});

test('the drawer’s own layer is dim while the page covers it and clears as the page moves away', async () => {
  const dimmer = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-style]')].map(styleOf).find((x) => x.backgroundColor === '#000000')!;
  const r = await render(frame(false));
  assert.equal(DIM, 0.38, 'Claude iOS’s measured back-layer dim');
  assert.equal(dimmer(r.host).opacity, DIM);
  await r.rerender(frame(true));
  await r.rerender(frame(true));
  assert.equal(dimmer(r.host).opacity, 0);
  await r.done();
});

test('closing the drawer keeps its content until the spring has finished, and a move cut short keeps it', async () => {
  const r = await render(frame(true));
  (globalThis as any).__phoneTimings = [];
  (globalThis as any).__phoneHoldTimings = true;
  try {
    await r.rerender(frame(false));
    assert.match(r.host.textContent!, /drawer/, 'still there while the page slides back');
    await act(async () => (globalThis as any).__phoneFinishTiming(true));
    assert.doesNotMatch(r.host.textContent!, /drawer/, 'gone once the spring has finished');
    await r.rerender(frame(true));
    await r.rerender(frame(false));
    const cut = (globalThis as any).__phoneFinishTiming;
    await r.rerender(frame(true));
    await act(async () => cut(false));
    assert.match(r.host.textContent!, /drawer/, 'reopened before it left: a cut-short close does not hide it');
  } finally {
    delete (globalThis as any).__phoneHoldTimings;
  }
  await r.done();
});

test('Reduce Motion cuts the drawer: no timing is started, and a released drag lands without one', async () => {
  (globalThis as any).__phoneReduceMotion = true;
  (globalThis as any).__phoneTimings = [];
  const r = await render(frame(false));
  await r.rerender(frame(true));
  assert.equal(timings().length, 0);
  const pan = (globalThis as any).__phonePan;
  await act(async () => pan.onActivate());
  await act(async () => pan.onDeactivate({ velocityX: 0, canceled: false }));
  assert.equal(timings().length, 0);
  await r.rerender(frame(false));
  assert.equal(timings().length, 0);
  assert.doesNotMatch(r.host.textContent!, /drawer/, 'closing under Reduce Motion takes the content away at once');
  await r.done();
  (globalThis as any).__phoneReduceMotion = false;
});

test('a drag: position follows the finger, and a release settles by position or by speed', () => {
  assert.equal(dragTo(0, 160, 320), 0.5);
  assert.equal(dragTo(1, -400, 320), 0, 'never past closed');
  assert.equal(dragTo(0, 900, 320), 1, 'never past open');
  assert.equal(settlesOpen(SETTLE_AT + 0.01, 0), true);
  assert.equal(settlesOpen(SETTLE_AT - 0.01, 0), false);
  assert.equal(settlesOpen(0.1, SETTLE_VELOCITY + 0.1), true, 'a quick flick right opens from a short pull');
  assert.equal(settlesOpen(0.9, -(SETTLE_VELOCITY + 0.1)), false, 'a quick flick left closes from a long pull');
});

test('the pan is recognised from the left edge while closed and anywhere while open, and never takes a vertical drag', async () => {
  const pan = () => (globalThis as any).__phonePan;
  const r = await render(frame(false, { show: () => {} }));
  assert.equal(pan().enabled, true);
  assert.deepEqual(pan().hitSlop, { left: 0, width: EDGE_WIDTH }, 'closed: only the strip at the edge');
  assert.ok(pan().activeOffsetX[1] === OFFSET && pan().activeOffsetX[0] < -1000, 'closed: to the right only');
  assert.ok(pan().failOffsetX[0] === -OFFSET, 'a drag left while closed is not ours');
  assert.deepEqual(pan().failOffsetY, [-OFFSET, OFFSET], 'a vertical drag stays with the list');
  await r.rerender(frame(true, { show: () => {} }));
  assert.equal(pan().hitSlop, undefined, 'open: anywhere on the page');
  assert.ok(pan().activeOffsetX[0] === -OFFSET && pan().activeOffsetX[1] > 1000, 'open: to the left only');
  await r.rerender(frame(false));
  assert.equal(pan().enabled, false, 'no way to open by hand without `show`');
  await r.done();
});

test('a drag from the edge opens the drawer and a drag of the open page closes it, settling on the spring with the finger’s velocity', async () => {
  const pan = () => (globalThis as any).__phonePan;
  let opened = 0;
  let closed = 0;
  const props = { show: () => opened++, close: () => closed++ };
  (globalThis as any).__phoneTimings = [];
  const r = await render(frame(false, props));
  await act(async () => pan().onActivate());
  await act(async () => pan().onUpdate({ translationX: 200 }));
  await act(async () => pan().onDeactivate({ velocityX: 0, canceled: false }));
  assert.equal(opened, 1);
  assert.deepEqual(timings().at(-1), { to: 1, config: { ...spring.drawer, velocity: 0 }, spring: true });
  const settled = timings().length;
  await r.rerender(frame(true, props));
  assert.equal(timings().length, settled, 'the prop that follows a settled drag does not restart the spring and lose its velocity');
  await act(async () => pan().onActivate());
  await act(async () => pan().onUpdate({ translationX: -300 }));
  await act(async () => pan().onDeactivate({ velocityX: 0, canceled: false }));
  assert.equal(closed, 1);
  assert.equal(timings().at(-1)!.to, 0);
  await act(async () => pan().onActivate());
  await act(async () => pan().onDeactivate({ velocityX: 600, canceled: false }));
  assert.equal(closed, 1, 'a flick right on an open drawer keeps it open and does not close it');
  assert.equal(timings().at(-1)!.config.velocity, 600 / SPAN, 'the release velocity, in drawers per second, goes into the spring');
  await act(async () => pan().onActivate());
  await act(async () => pan().onDeactivate({ velocityX: 0, canceled: true }));
  assert.equal(closed, 1);
  assert.equal(timings().at(-1)!.to, 1, 'an interrupted drag settles back open');
  await r.rerender(frame(false, props));
  await act(async () => pan().onActivate());
  await act(async () => pan().onDeactivate({ velocityX: 0, canceled: true }));
  assert.equal(timings().at(-1)!.to, 0, 'and back closed when it began closed');
  await r.done();
});

const NOW = Date.now();
const chats = [
  { id: 'w', title: 'Fix login', state: 'waiting', at: NOW },
  { id: 'pin', title: 'Pinned one', pinned: true, at: NOW },
  { id: 'kid', title: 'A sub-session', parentId: 'w', at: NOW },
  { id: 'blank', at: NOW },
  ...Array.from({ length: DRAWER_RECENTS + 3 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}`, at: NOW })),
];

test('Home’s drawer lists the chats you started (not sub-sessions), caps Recents, and every action closes the drawer first', async () => {
  const seen: string[] = [];
  const props = {
    user: { name: 'Dax Hill' },
    chats,
    offline: false,
    leave: () => seen.push('close'),
    openChat: (id: string) => seen.push(`open:${id}`),
    momo: () => seen.push('momo'),
    scheduled: () => seen.push('scheduled'),
    settings: () => seen.push('settings'),
    newChat: () => seen.push('new'),
  };
  const r = await render(createElement(HomeDrawerPanel, props));
  assert.equal(button(r.host, 'A sub-session'), null, 'sub-sessions stay under their parent on Chats');
  assert.ok(button(r.host, 'Untitled chat'));
  assert.ok(button(r.host, `Chat ${DRAWER_RECENTS - 3}`));
  assert.equal(button(r.host, `Chat ${DRAWER_RECENTS - 2}`), null, 'recents stop at the cap');
  for (const label of ['MoMo', 'Scheduled', 'Settings', 'New chat', 'Fix login', 'Pinned one', 'Chats']) await press(button(r.host, label));
  assert.deepEqual(seen, [
    'close',
    'momo',
    'close',
    'scheduled',
    'close',
    'settings',
    'close',
    'new',
    'close',
    'open:w',
    'close',
    'open:pin',
    'close',
  ]);
  await r.done();
  // an account without MoMo, a computer away: no MoMo, Scheduled or New chat; a chat that cannot open only closes the drawer
  seen.length = 0;
  const away = await render(
    createElement(HomeDrawerPanel, {
      ...props,
      chats: null,
      offline: true,
      momo: undefined,
      scheduled: undefined,
      newChat: undefined,
      openChat: undefined,
    }),
  );
  for (const label of ['MoMo', 'Scheduled', 'New chat']) assert.equal(button(away.host, label), null, label);
  await away.done();
  const stale = await render(createElement(HomeDrawerPanel, { ...props, offline: true, openChat: undefined }));
  assert.equal(
    stale.host.querySelector('[data-symbol="hand.raised"]'),
    null,
    'no state is claimed for a list read before the computer went away',
  );
  await press(button(stale.host, 'Fix login'));
  assert.deepEqual(seen, ['close']);
  await stale.done();
});

test('Home: the Chats header opens the drawer and its close shuts it; no floating New chat (New session is the list’s first row, as Claude’s); no drawer, no header', async () => {
  let closeIt: () => void = () => {};
  const home = (drawer: unknown) =>
    createElement(Home, { drawer, refresh: { pulling: false, run: () => {} } }, createElement('span', null, 'list'));
  const panel = (close: () => void) => {
    closeIt = close;
    return createElement('span', null, 'panel');
  };
  const r = await render(home(panel));
  const shifted = () => [...r.host.querySelectorAll('[data-style]')].some((n) => styleOf(n).borderRadius === PAGE_CORNER);
  assert.equal(r.host.querySelector('[role="header"]')!.textContent, 'Chats');
  assert.equal(shifted(), false);
  const edge = (globalThis as any).__phonePan;
  await act(async () => edge.onActivate());
  await act(async () => edge.onUpdate({ translationX: 300 }));
  await act(async () => edge.onDeactivate({ velocityX: 0, canceled: false }));
  assert.equal(shifted(), true, 'a drag from the edge opens it through Home’s own state');
  await act(async () => closeIt());
  assert.equal(shifted(), false);
  await press(button(r.host, 'Open menu'));
  assert.equal(shifted(), true, 'the page slides aside');
  assert.ok(r.host.textContent!.includes('panel'));
  await act(async () => closeIt());
  assert.equal(shifted(), false, 'the panel’s close puts it back');
  assert.equal(button(r.host, 'New chat'), null, 'the page floats no New chat of its own');
  await r.rerender(home(undefined));
  assert.equal(button(r.host, 'Open menu'), null);
  assert.equal(r.host.querySelector('[role="header"]'), null);
  await r.done();
});

test('the page keeps the baseline page colour behind it', async () => {
  const r = await render(createElement(Home, null, createElement('span', null, 'x')));
  assert.ok([...r.host.querySelectorAll('[data-style]')].some((n) => styleOf(n).backgroundColor === light.bg));
  await r.done();
});

test('outside its provider the search is closed and asking it to open or close does nothing', async () => {
  const searchPath = '../mobile/src/components/ChatSearch';
  const { useChatSearch } = await import(searchPath);
  let seen: any;
  const Probe = () => {
    seen = useChatSearch();
    return null;
  };
  const r = await render(createElement(Probe));
  seen.show();
  seen.hide();
  assert.equal(seen.open, false);
  await r.done();
});

test('an open drawer that goes away (sign-out) is closed for whoever comes next', async () => {
  const panel = () => createElement('span', null, 'panel');
  const r = await render(createElement(Home, { drawer: panel }, createElement('span', null, 'list')));
  await press(button(r.host, 'Open menu'));
  assert.ok(button(r.host, 'Close menu'));
  await r.rerender(createElement(Home, null, createElement('span', null, 'list')));
  await r.rerender(createElement(Home, { drawer: panel }, createElement('span', null, 'list')));
  assert.equal(button(r.host, 'Close menu'), null, 'the next account starts with the drawer closed');
  await r.done();
});

test('the search circle shows only while a chat list is on the page, in the footer and in the drawer header; the drawer’s opens the list’s search', async () => {
  const searchPath = '../mobile/src/components/ChatSearch';
  const { useSearchableList } = await import(searchPath);
  const List = () => {
    const search = useSearchableList();
    return createElement('span', null, search.open ? 'searching' : 'list');
  };
  const panel = (leave: () => void) =>
    createElement(HomeDrawerPanel, { user: { name: 'Du' }, chats: [], offline: false, leave, settings: () => {} });
  const r = await render(createElement(Home, { drawer: panel }, createElement('span', null, 'no list')));
  assert.equal(button(r.host, 'Search chats'), null, 'nothing to search: no circle');
  await press(button(r.host, 'Open menu'));
  assert.equal(button(r.host, 'Search chats'), null, 'nor in the drawer');
  await r.rerender(createElement(Home, { drawer: panel }, createElement(List)));
  const circles = [...r.host.querySelectorAll('button[aria-label="Search chats"]')];
  assert.equal(circles.length, 2, 'the footer’s and the drawer header’s');
  // the drawer's is first in the page: it closes the drawer and opens the list's search
  await press(circles[0]);
  assert.equal(button(r.host, 'Close menu'), null, 'the drawer closed');
  assert.ok(r.host.textContent!.includes('searching'));
  await r.done();
});

test('the pushed page carries the baseline shadow on its edge (off screen while the page is home, so one style serves the whole drag)', async () => {
  const frame = (open: boolean) =>
    createElement(DrawerFrame, { open, close: () => {}, drawer: createElement('span', null, 'd') }, createElement('span', null, 'p'));
  const r = await render(frame(true));
  const page = () => [...r.host.querySelectorAll('[data-style]')].map(styleOf).find((s) => 'boxShadow' in s)!;
  assert.equal(page().boxShadow, '-8px 0px 24px rgba(0, 0, 0, 0.18)');
  await r.rerender(frame(false));
  assert.equal(page().boxShadow, '-8px 0px 24px rgba(0, 0, 0, 0.18)');
  await r.done();
});

test('the drawer and the pushed page run under the status bar and the home indicator, with their content kept clear', async () => {
  (globalThis as any).__safeAreaInsets = { top: 47, bottom: 34, left: 0, right: 0 };
  const r = await render(
    createElement(
      DrawerFrame,
      { open: true, close: () => {}, drawer: createElement('span', { id: 'drawer' }, 'd') },
      createElement('span', { id: 'page' }, 'p'),
    ),
  );
  const backOf = (id: string) => styleOf(r.host.querySelector(`#${id}`)!.closest('[data-style]')!);
  assert.deepEqual([backOf('drawer').paddingTop, backOf('drawer').paddingBottom], [47, 34], 'the drawer’s content stays clear');
  assert.deepEqual([backOf('page').paddingTop, backOf('page').paddingBottom], [47, 34], 'so does the page’s');
  assert.equal(
    backOf('page').transitionDuration,
    undefined,
    'the page is kept clear on a view inside the slide, which its footer is placed from',
  );
  // without a drawer (signing in, loading) Chats keeps its page clear itself
  await r.rerender(createElement(Home, null, createElement('span', { id: 'bare' }, 'b')));
  delete (globalThis as any).__safeAreaInsets;
  assert.deepEqual([backOf('bare').paddingTop, backOf('bare').paddingBottom], [undefined, undefined], 'not by the page itself');
  const clear = [...r.host.querySelectorAll('[data-style]')].map(styleOf).find((s) => s.paddingTop === 47)!;
  assert.equal(clear.paddingBottom, 34);
  await r.done();
});

test('a search left open when the list goes away is closed with it', async () => {
  const searchPath = '../mobile/src/components/ChatSearch';
  const { useSearchableList } = await import(searchPath);
  const List = () => {
    const search = useSearchableList();
    return createElement('span', null, search.open ? 'searching' : 'list');
  };
  const home = (child: any) => createElement(Home, { drawer: () => createElement('span', null, 'p') }, child);
  const r = await render(home(createElement(List)));
  await press(button(r.host, 'Search chats'));
  assert.ok(r.host.textContent!.includes('searching'));
  await r.rerender(home(createElement('span', null, 'away')));
  assert.equal(button(r.host, 'Close search'), null);
  await r.rerender(home(createElement(List)));
  assert.ok(r.host.textContent!.includes('list') && !r.host.textContent!.includes('searching'), 'it comes back closed');
  await r.done();
});
