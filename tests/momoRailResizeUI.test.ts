// MoMo's rail in the shell (#4926): its width is dragged with the app sidebar's own handle (SidebarResize: strip, limits, keys, snap-to-close) and saved as `momoRailWidth`; its two actions (New channel, New group) are buttons with a plus, not places.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { window } from './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import { reactivePrefs } from './support/reactivePrefs.ts';

const captures = new WeakMap<HTMLElement, number>();
(window.HTMLElement.prototype as any).setPointerCapture = function (id: number) {
  captures.set(this, id);
};
(window.HTMLElement.prototype as any).hasPointerCapture = function (id: number) {
  return captures.get(this) === id;
};
(window.HTMLElement.prototype as any).releasePointerCapture = function () {
  captures.delete(this);
};

// a window wide enough for the app's nav column (288), the rail and the chat's minimum
(window as any).innerWidth = 1600;
mockSource('src/lib/mopilot.ts', { useMoPilot: () => ({ signedIn: false, user: null }) });
installNativeStub({ momoChat: { previousChats: async () => [] } });
const calls: any[] = [];
const store = reactivePrefs(() => ({ route: { name: 'momo' }, momoChats: {} }));
const prefs = store.prefs;
let tasksPanel = false;
stubStore({
  useStore: store.useStore,
  setPrefs: (p: any) => {
    store.setPrefs(p);
    calls.push(['setPrefs', p]);
  },
  navigate: (r: any) => calls.push(['navigate', r]),
});
mockSource('src/session/momoPrefs.ts', { useMomoPrefs: () => ({ paused: false, tasksPanel }) });
mockSource('src/lib/flags.ts', { useFlag: () => false });
mockSource('src/components/momo/tasks/TasksPanel.tsx', { TasksPanel: () => h('div') });
mockSource('src/components/momo/MomoOutputs.tsx', { MomoOutputs: () => h('div') });
mockSource('src/components/momo/sessions/SessionsPane.tsx', { SessionsPane: () => h('div') });
const { MomoShell } = await import('../src/components/momo/shell/MomoShell.tsx');
const { RailNew } = await import('../src/components/momo/shell/RailAction.tsx');
const { MomoRail } = await import('../src/components/momo/shell/MomoRail.tsx');
const { RailAction } = await import('../src/components/momo/shell/RailAction.tsx');
const { RAIL_DEFAULT_WIDTH } = await import('../src/components/momo/shell/useRailWidth.ts');

const reset = () => {
  store.reset();
  calls.length = 0;
  tasksPanel = false;
  window.localStorage.clear();
};
const mount = async () => {
  const r = await render(h(MomoShell, { onNewChannel: () => {}, children: h('div') }));
  await flush();
  return r;
};
const handle = (r: any) => r.host.querySelector('[role=separator]') as HTMLElement;
const rail = (r: any) => r.host.querySelector('nav') as HTMLElement;
const press = (el: HTMLElement, key: string, shiftKey = false) =>
  act(() => el.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey }) as any));
const pointer = async (el: HTMLElement, type: string, x: number) => {
  await act(() => el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x }) as any));
  if (type === 'pointermove') await act(() => new Promise<void>((done) => setTimeout(done, 0)));
};

test('the rail has the sidebar handle at its edge, at the default width, and it is named for the rail', async () => {
  reset();
  const r = await mount();
  assert.equal(handle(r).getAttribute('aria-label'), 'Resize sidebar');
  assert.equal(handle(r).getAttribute('aria-valuenow'), String(RAIL_DEFAULT_WIDTH));
  assert.deepEqual(
    ['aria-valuemin', 'aria-valuemax', 'aria-keyshortcuts', 'aria-orientation'].map((a) => handle(r).getAttribute(a)),
    ['232', '420', 'Meta+b', 'vertical'],
  );
  assert.equal(rail(r).style.width, `${RAIL_DEFAULT_WIDTH}px`);
  assert.ok(handle(r).classList.contains('sidebar-resize'), 'the app sidebar’s own strip and cursor');
  await r.unmount();
});

test('a saved width is read, clamped to the sidebar’s limits', async () => {
  reset();
  prefs.momoRailWidth = 320;
  const wide = await mount();
  assert.equal(rail(wide).style.width, '320px');
  await wide.unmount();
  prefs.momoRailWidth = 40;
  const narrow = await mount();
  assert.equal(rail(narrow).style.width, '232px', 'the design’s minimum');
  await narrow.unmount();
  prefs.momoRailWidth = 900;
  const huge = await mount();
  assert.equal(rail(huge).style.width, '420px', 'the design’s maximum');
  await huge.unmount();
});

test('dragging sets the width live and saves it once, when the drag ends', async () => {
  reset();
  const r = await mount();
  const el = handle(r);
  await pointer(el, 'pointerdown', 288);
  await pointer(el, 'pointermove', 300);
  assert.equal(rail(r).style.width, '300px');
  assert.deepEqual(calls, []);
  await pointer(el, 'pointerup', 300);
  assert.deepEqual(calls, [['setPrefs', { momoRailWidth: 300 }]]);
  assert.equal(rail(r).style.width, '300px');
  await r.unmount();
});

test('keys resize, and dragging the rail narrow hides it as the sidebar hides; its toggle brings it back', async () => {
  reset();
  const r = await mount();
  await press(handle(r), 'ArrowRight');
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoRailWidth: 296 }], 'an arrow is 8 px');
  await press(handle(r), 'ArrowLeft', true);
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoRailWidth: 264 }], 'Shift and an arrow is 32 px');
  await press(handle(r), 'End');
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoRailWidth: 420 }]);
  await press(handle(r), 'Home');
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoRailWidth: 232 }], 'Home is the minimum, not hidden');
  await press(handle(r), 'ArrowLeft');
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoRailWidth: 232 }], 'never under it by key');
  await press(handle(r), 'x');
  const el = handle(r);
  await pointer(el, 'pointerdown', 232);
  await pointer(el, 'pointermove', 20);
  await pointer(el, 'pointerup', 40);
  assert.equal(rail(r), null, 'no icon rail is left');
  assert.equal(prefs.momoRailHidden, true);
  assert.equal(handle(r).getAttribute('aria-label'), 'Drag to open sidebar');
  await click(r.host.querySelector('[aria-label="Show sidebar"]'));
  assert.ok(rail(r));
  await r.unmount();
});

test('an open panel leaves the chat its room: the rail’s limit narrows beside it', async () => {
  reset();
  tasksPanel = true;
  prefs.momoRailWidth = 420;
  const r = await mount();
  const before = Number(handle(r).getAttribute('aria-valuemax'));
  await click(r.host.querySelector('button[aria-label="Tasks"]'));
  assert.ok(Number(handle(r).getAttribute('aria-valuemax')) <= before);
  await r.unmount();
});

test('New channel and New group are actions: a button with a plus and its name, not a place', async () => {
  reset();
  let ran = 0;
  const r = await render(h(RailAction, { label: 'New group', onClick: () => ran++ }));
  const b = r.host.querySelector('button')!;
  assert.equal(b.getAttribute('type'), 'button');
  assert.equal(b.getAttribute('aria-label'), 'New group');
  assert.ok(b.querySelector('svg'));
  assert.equal(b.querySelector('svg')!.getAttribute('aria-hidden'), 'true');
  assert.equal(b.getAttribute('aria-current'), null);
  await click(b);
  assert.equal(ran, 1);
  await r.unmount();
});

const key = (k: string) =>
  act(async () => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
const mousedown = (el: Element) => act(async () => void el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any));

test('"New channel or group" is one row that opens the two; Escape and a click elsewhere close it (design 5.1)', async () => {
  reset();
  const made: string[] = [];
  const r = await render(h(RailNew, { onNewChannel: () => made.push('channel'), onNewGroup: () => made.push('group') }));
  const row = () => r.host.querySelector('[aria-label="New channel or group"]')!;
  assert.equal(row().getAttribute('aria-haspopup'), 'menu');
  assert.equal(r.host.querySelector('[role=menu]'), null);
  await click(row());
  assert.deepEqual(
    [...r.host.querySelectorAll('[role=menuitem]')].map((b) => b.textContent),
    ['New channel', 'New group'],
  );
  await key('Escape');
  assert.equal(r.host.querySelector('[role=menu]'), null);
  await click(row());
  await mousedown(r.host.querySelector('[role=menu]')!);
  assert.ok(r.host.querySelector('[role=menu]'), 'a press inside the menu keeps it');
  await mousedown(document.body);
  assert.equal(r.host.querySelector('[role=menu]'), null);
  await click(row());
  await click(r.host.querySelectorAll('[role=menuitem]')[1]);
  await click(row());
  await click(r.host.querySelectorAll('[role=menuitem]')[0]);
  assert.deepEqual(made, ['group', 'channel']);
  assert.equal(r.host.querySelector('[role=menu]'), null);
  await r.unmount();
  const alone = await render(h(RailNew, { onNewChannel: () => made.push('only') }));
  await click(alone.host.querySelector('[aria-label="New channel"]'));
  assert.equal(made.at(-1), 'only');
  await alone.unmount();
});

test('the rail is the one column: the way back, Memory, Settings and (while the panel is off) Tasks sit in it', async () => {
  reset();
  const r = await render(h(MomoRail, { paused: false, hide: () => {}, tab: 'memory', tasksPage: true }));
  const go = async (label: string) =>
    click(r.host.querySelector(`[aria-label="${label}"]`) ?? [...r.host.querySelectorAll('button')].find((b) => b.textContent === label));
  await go('Back to chats');
  await go('Tasks');
  await go('Memory');
  await go('Settings');
  await go('Everything');
  assert.deepEqual(
    calls.map((c) => c[1]),
    [
      { name: 'home' },
      { name: 'momo', tab: 'tasks' },
      { name: 'momo', tab: 'memory' },
      { name: 'settings', section: 'momo' },
      { name: 'momo', tab: 'chat' },
    ],
  );
  assert.equal(r.host.querySelector('[aria-current=page]')!.textContent, 'Memory');
  await r.unmount();
});

test('the side pane has its own separator: 420 default, 420 to 732, grows to the left, same keys, width and open state kept', async () => {
  reset();
  tasksPanel = true;
  const r = await mount();
  assert.equal(r.host.querySelectorAll('[role=separator]').length, 1, 'no pane, one handle');
  await click(r.host.querySelector('button[aria-label="Tasks"]'));
  assert.equal(prefs.momoPane, 'tasks', 'the open pane is remembered');
  const pane = () => r.host.querySelector('aside [role=separator]') as HTMLElement;
  assert.equal(pane().getAttribute('aria-label'), 'Resize side pane');
  assert.deepEqual(
    ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map((a) => pane().getAttribute(a)),
    ['420', '420', '732'],
  );
  assert.ok(pane().classList.contains('edge-right'));
  assert.equal((r.host.querySelector('aside') as HTMLElement).style.width, '420px');
  await press(pane(), 'ArrowLeft');
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoPaneWidth: 428 }], 'the pane grows by the arrow that moves its edge left');
  await press(pane(), 'ArrowRight', true);
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoPaneWidth: 420 }], 'never under 420');
  await press(pane(), 'End');
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoPaneWidth: 732 }]);
  const el = pane();
  await pointer(el, 'pointerdown', 800);
  await pointer(el, 'pointermove', 840);
  assert.equal((r.host.querySelector('aside') as HTMLElement).style.width, '692px', 'dragging left grows it');
  await pointer(el, 'pointerup', 840);
  assert.deepEqual(calls.at(-1), ['setPrefs', { momoPaneWidth: 692 }]);
  await r.unmount();
  // a restart: the pane is open again at its width
  const again = await mount();
  assert.equal((again.host.querySelector('aside') as HTMLElement).style.width, '692px');
  await pointer(again.host.querySelector('aside [role=separator]') as HTMLElement, 'pointerdown', 800);
  await pointer(again.host.querySelector('aside [role=separator]') as HTMLElement, 'pointermove', 1500);
  await pointer(again.host.querySelector('aside [role=separator]') as HTMLElement, 'pointerup', 1500);
  assert.equal(prefs.momoPane, null, 'dragged under half its minimum, it closes');
  await again.unmount();
});

test('the centre eases into the room a closed rail or pane leaves, and not when they open or on first load', async () => {
  reset();
  tasksPanel = true;
  const r = await mount();
  const centre = () => r.host.querySelector('[data-rail]') as HTMLElement;
  assert.equal(centre().getAttribute('data-tween'), null);
  await click(r.host.querySelector('[aria-label="Hide sidebar"]'));
  assert.equal(centre().getAttribute('data-tween'), 'rail');
  assert.equal(centre().getAttribute('data-rail'), 'hidden');
  await click(r.host.querySelector('[aria-label="Show sidebar"]'));
  assert.equal(centre().getAttribute('data-tween'), null, 'opening: nothing to ease');
  await click(r.host.querySelector('button[aria-label="Tasks"]'));
  await click(r.host.querySelector('button[aria-label="Tasks"]'));
  assert.equal(centre().getAttribute('data-tween'), 'pane');
  await r.unmount();
});

test('the pane opens with the rail hidden: it leaves the chat the whole lane besides its own width', async () => {
  reset();
  tasksPanel = true;
  const r = await mount();
  await click(r.host.querySelector('[aria-label="Hide sidebar"]'));
  await click(r.host.querySelector('button[aria-label="Tasks"]'));
  const pane = r.host.querySelector('aside [role=separator]') as HTMLElement;
  assert.equal(pane.getAttribute('aria-valuemax'), '732', 'no rail beside it: the widest it can be');
  await r.unmount();
});
