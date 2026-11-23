// A Host chat's desktop in the pane (src/components/panels/browserPanel/HostDesktopSurface.tsx): frames from main, the notes for no desktop and a failure, and the user's input sent only after they took over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click, mount } from './support/composer-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { act } from 'react';

const calls: any[] = [];
let push: ((f: any) => void) | null = null;
installNativeStub({
  computer: {
    desktopWatch: async (...a: any[]) => (calls.push(['watch', ...a]), true),
    desktopView: async (...a: any[]) => (calls.push(['view', ...a]), true),
    desktopStop: async (...a: any[]) => (calls.push(['stop', ...a]), true),
    desktopInput: async (...a: any[]) => (calls.push(['input', ...a]), true),
    onDesktopFrame: (cb: (f: any) => void) => ((push = cb), () => void (push = null)),
  },
});
const { createElement } = await import('react');
const { HostDesktopSurface } = await import('../src/components/panels/browserPanel/HostDesktopSurface.tsx');

const show = (props: Partial<{ shown: boolean; takenOver: boolean; chatId: string; hostId: string }> = {}) =>
  mount(
    createElement(HostDesktopSurface, {
      paneId: 'p1',
      chatId: 'c1',
      hostId: 'h1',
      machine: 'box',
      shown: true,
      takenOver: false,
      ...props,
    }),
  );
const frame = (over: object = {}) =>
  act(async () => push!({ paneId: 'p1', data: 'AAAA', mime: 'image/png', width: 1000, height: 500, ...over }));
const box = () => ({ left: 0, top: 0, width: 500, height: 250, right: 500, bottom: 250, x: 0, y: 0, toJSON: () => ({}) });

test('the pane follows the chat’s desktop, says it is opening, shows a frame, and stops following when it closes', async () => {
  calls.length = 0;
  const m = await show();
  try {
    assert.deepEqual(calls.slice(0, 2), [
      ['watch', 'p1', 'c1', 'h1'],
      ['view', 'p1', { visible: true, takeover: false }],
    ]);
    assert.match($('.remote-view-note').textContent!, /Opening box's desktop/);
    await frame();
    assert.equal($('img.remote-view-frame').getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.equal(document.querySelector('.remote-view-note'), null);
    await frame({ paneId: 'other', data: 'ZZZZ' });
    assert.equal($('img.remote-view-frame').getAttribute('src'), 'data:image/png;base64,AAAA', 'a frame for another pane is not ours');
  } finally {
    await m.unmount();
  }
  assert.deepEqual(calls.at(-1), ['stop', 'p1']);
});

test('no desktop in use says so, a failure says it in words, and the next frame clears both', async () => {
  const m = await show();
  try {
    await act(async () => push!({ paneId: 'p1', idle: true }));
    assert.match($('.remote-view-note').textContent!, /isn't using box's desktop/);
    await act(async () => push!({ paneId: 'p1', error: 'The machine did not answer.' }));
    assert.equal($('.remote-view-note').textContent, 'The machine did not answer.');
    await frame();
    assert.equal(document.querySelector('.remote-view-note'), null);
    await act(async () => push!({ paneId: 'p1', mime: 'image/png' }));
    assert.ok($('img.remote-view-frame'), 'a message with no picture changes nothing');
  } finally {
    await m.unmount();
  }
});

test('the pane says whose desktop it is, and that the user is driving it after a takeover', async () => {
  const watching = await show();
  try {
    assert.equal($('.remote-view-bar').textContent, "This is box's desktop, not this Mac.");
  } finally {
    await watching.unmount();
  }
  const driving = await show({ takenOver: true });
  try {
    assert.equal($('.remote-view-bar').textContent, "You are driving box's desktop, not this Mac.");
  } finally {
    await driving.unmount();
  }
});

test('showing, hiding and taking over are told to main', async () => {
  calls.length = 0;
  const m = await show({ shown: false, takenOver: true });
  try {
    assert.deepEqual(
      calls.find((c) => c[0] === 'view'),
      ['view', 'p1', { visible: false, takeover: true }],
    );
  } finally {
    await m.unmount();
  }
});

test('input reaches the desktop only after the user took over: a click in the frame’s pixels, a scroll, a key, a printable character and a paste', async () => {
  const watching = await show();
  try {
    await frame();
    $('img.remote-view-frame').getBoundingClientRect = box;
    calls.length = 0;
    await click($('.host-desktop'));
    assert.equal(calls.filter((c) => c[0] === 'input').length, 0, 'watching only');
  } finally {
    await watching.unmount();
  }
  const m = await show({ takenOver: true });
  try {
    await frame();
    $('img.remote-view-frame').getBoundingClientRect = box;
    calls.length = 0;
    const root = $('.host-desktop');
    await act(async () => {
      root.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 250, clientY: 125, button: 0, detail: 2 }));
    });
    await act(async () => {
      root.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 7 }));
    });
    await act(async () => {
      root.dispatchEvent(
        Object.assign(new window.MouseEvent('wheel', { bubbles: true, clientX: 100, clientY: 50 }), { deltaX: 0, deltaY: 30 }),
      );
    });
    await act(async () => {
      root.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
      root.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      root.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'c', metaKey: true }));
    });
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { getData: () => 'pasted' } });
    await act(async () => void root.dispatchEvent(paste));
    const empty = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.assign(empty, { clipboardData: { getData: () => '' } });
    await act(async () => void root.dispatchEvent(empty));
    assert.deepEqual(
      calls.filter((c) => c[0] === 'input').map((c) => c[2]),
      [
        { kind: 'click', x: 500, y: 250, button: 'left', count: 2 },
        { kind: 'scroll', x: 200, y: 100, dx: 0, dy: 30 },
        { kind: 'text', text: 'a' },
        { kind: 'key', key: 'Enter' },
        { kind: 'key', key: 'c' },
        { kind: 'text', text: 'pasted' },
      ],
    );
  } finally {
    await m.unmount();
  }
});

test('a pane given another chat or machine follows that one afresh and drops the old picture', async () => {
  calls.length = 0;
  const m = await show();
  try {
    await frame();
    assert.ok($('img.remote-view-frame'));
    await m.render(
      createElement(HostDesktopSurface, { paneId: 'p1', chatId: 'c2', hostId: 'h1', machine: 'box', shown: true, takenOver: false }),
    );
    assert.equal(document.querySelector('img.remote-view-frame'), null, 'the old chat’s picture is gone');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'watch'),
      [
        ['watch', 'p1', 'c1', 'h1'],
        ['watch', 'p1', 'c2', 'h1'],
      ],
    );
    assert.ok(calls.some((c) => c[0] === 'stop'));
  } finally {
    await m.unmount();
  }
});

test('a frame without a type or a size is drawn as a PNG; before any frame a click, scroll or key goes nowhere; a note on the bar does not click through', async () => {
  const m = await show({ takenOver: true });
  try {
    calls.length = 0;
    const root = $('.host-desktop');
    await act(async () => root.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5, button: 0 })));
    await act(async () =>
      root.dispatchEvent(
        Object.assign(new window.MouseEvent('wheel', { bubbles: true, clientX: 5, clientY: 5 }), { deltaX: 0, deltaY: 9 }),
      ),
    );
    assert.equal(calls.filter((c) => c[0] === 'input').length, 0, 'no frame yet: nothing to point at');
    const menu = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => root.dispatchEvent(menu));
    assert.equal(menu.defaultPrevented, true, 'the Mac’s own menu does not open over the other machine’s desktop');
    await act(async () => push!({ paneId: 'p1', data: 'AAAA' }));
    assert.equal($('img.remote-view-frame').getAttribute('src'), 'data:image/png;base64,AAAA');
    $('img.remote-view-frame').getBoundingClientRect = box;
    calls.length = 0;
    await act(async () =>
      $('.remote-view-bar').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 250, clientY: 125, button: 0 })),
    );
    assert.equal(calls.filter((c) => c[0] === 'input').length, 0, 'a press on the bar is not a click on the desktop');
  } finally {
    await m.unmount();
  }
  const watching = await show();
  try {
    await frame();
    $('img.remote-view-frame').getBoundingClientRect = box;
    calls.length = 0;
    const root = $('.host-desktop');
    await act(async () =>
      root.dispatchEvent(
        Object.assign(new window.MouseEvent('wheel', { bubbles: true, clientX: 5, clientY: 5 }), { deltaX: 0, deltaY: 9 }),
      ),
    );
    const menu = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => root.dispatchEvent(menu));
    assert.equal(menu.defaultPrevented, false, 'the user’s own menu, while only watching');
    await act(async () =>
      root.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 250, clientY: 125, button: 0 })),
    );
    await act(async () => root.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'a' })));
    assert.equal(calls.filter((c) => c[0] === 'input').length, 0, 'watching only');
  } finally {
    await watching.unmount();
  }
});

test('the agent’s cursor is drawn over the frame from main’s plan on its own clock, only on a frame of the version it was placed by, and goes when the plan has played', async () => {
  const { planApproach } = await import('../shared/cursorApproach.mjs');
  let now = 0;
  const queue: (() => void)[] = [];
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  const realNow = performance.now.bind(performance);
  globalThis.requestAnimationFrame = ((fn: () => void) => (queue.push(fn), queue.length)) as any;
  globalThis.cancelAnimationFrame = (() => undefined) as any;
  performance.now = () => now;
  const m = await show();
  try {
    const geometry = { pixelsPerPoint: 2, display: { x: 0, y: 0 }, version: 3 };
    await frame({ width: 2000, height: 1000, ...geometry });
    const img = $('img.remote-view-frame');
    img.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as any;
    $('.host-desktop').getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as any;
    const p = planApproach({ from: { x: 600, y: 400 }, to: { x: 400, y: 200 } });
    const plan = { samples: p.samples, to: p.to, pressAtMs: p.pressAtMs, totalMs: p.totalMs, hideAfterClickMs: p.hideAfterClickMs };
    const run = async (at: number) => {
      now = at;
      await act(async () => {
        const todo = queue.splice(0);
        for (const f of todo) f();
      });
    };
    const cursor = () => $('.host-desktop-cursor') as HTMLElement;
    await act(async () => push!({ paneId: 'p1', cursor: { kind: 'approach', id: 1, version: 3, press: true, plan } }));
    await run(0);
    assert.equal(cursor().hidden, false);
    assert.equal(cursor().dataset.shape, 'arrow');
    await run(p.pressAtMs + 1);
    assert.equal(cursor().dataset.shape, 'disc');
    // 2 pixels per point on a 2000-px frame drawn 1000 px wide: the point (400, 200) is at (400, 200) on screen
    assert.equal(cursor().style.transform, 'translate(400px, 200px)');
    // a frame of another layout: no cursor on it
    await frame({ width: 2000, height: 1000, ...geometry, version: 4 });
    await run(p.pressAtMs + 2);
    assert.equal(cursor().hidden, true);
    await frame({ width: 2000, height: 1000, ...geometry });
    await run(p.pressAtMs + 3);
    assert.equal(cursor().hidden, false);
    // the Host answered: the press ends a few ms later; a hide ends the rest
    await act(async () => push!({ paneId: 'p1', cursor: { kind: 'dispatched', id: 1 } }));
    await run(p.pressAtMs + 3 + p.hideAfterClickMs + 1);
    assert.equal(cursor().hidden, true);
    await act(async () => push!({ paneId: 'p1', cursor: { kind: 'approach', id: 2, version: 3, press: false, plan } }));
    await run(p.pressAtMs + 4);
    await act(async () => push!({ paneId: 'p1', cursor: { kind: 'hide', id: 0 } }));
    await run(p.pressAtMs + 5);
    assert.equal(cursor().hidden, true);
  } finally {
    await m.unmount();
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
    performance.now = realNow;
  }
});
