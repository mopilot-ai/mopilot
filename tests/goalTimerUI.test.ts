// The goal's live elapsed time between harness reports, including pause, resume and ownership changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, f, mount, original, resetGoalSessions, setGoalSnapshot } from './support/goal-pills.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useGoalElapsed } from '../src/lib/useGoalElapsed.ts';
import { useSession } from '../src/store/session/useSession.ts';
import type { ChatGoal } from '../src/store/types.ts';
import { window } from './support/dom.ts';

test('an active goal ticks every second without another harness report', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 20 });
  await m.open();
  assert.equal(m.pill().textContent, '20s');
  for (const seconds of [21, 22, 23]) {
    await act(() => t.mock.timers.tick(1000));
    assert.equal(m.pill().textContent, `${seconds}s`);
    assert.equal(m.pill().getAttribute('aria-label'), `Goal, running for ${seconds}s`);
    assert.equal(m.card()!.querySelector('.goal-card-summary')!.textContent, `${seconds}s elapsed`);
  }
  assert.equal(f.goal.timeUsedSeconds, 20, 'display ticks never write estimated usage back');
});

test('switching away and back keeps the active goal timer advancing in the pill and card', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const goal: ChatGoal = { ...original, status: 'active', timeUsedSeconds: 20 };
  const m = await mount(t, goal);
  await act(() => t.mock.timers.tick(3000));
  assert.equal(m.pill().textContent, '23s');

  f.goal = { ...goal, objective: 'Another chat' };
  await m.render('chat-2');
  assert.equal(m.pill().textContent, '20s');
  await act(() => t.mock.timers.tick(2000));

  f.goal = { ...goal };
  await m.render();
  assert.equal(m.pill().textContent, '25s');
  await m.open();
  assert.equal(m.card()!.querySelector('.goal-card-summary')!.textContent, '25s elapsed');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '26s');
});

test('unchanged usage and metadata updates do not postpone the next second', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 20 });
  await act(() => t.mock.timers.tick(600));
  f.goal = { ...f.goal, tokensUsed: 2000, objective: 'Revised', updatedAt: 1001 };
  await m.render();
  await act(() => t.mock.timers.tick(400));
  assert.equal(m.pill().textContent, '21s');
  f.goal = { ...f.goal };
  await m.render();
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '22s');
});

test('zero or missing usage ticks from zero while active and shows only status when paused', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  for (const timeUsedSeconds of [0, undefined]) {
    const m = await mount(t, { ...original, status: 'active', timeUsedSeconds } as ChatGoal);
    assert.equal(m.pill().textContent, '0s');
    await act(() => t.mock.timers.tick(1000));
    assert.equal(m.pill().textContent, '1s');
    f.goal = { ...f.goal, status: 'paused' };
    await m.render();
    await m.open();
    assert.equal(m.card()!.querySelector('.goal-card-summary')!.textContent, 'Paused');
  }
});

test('seconds remain visible as a goal passes one minute and one hour', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 59 });
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '1m');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '1m 1s');
  f.goal = { ...f.goal, timeUsedSeconds: 3599 };
  await m.render();
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '1h 0m 0s');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '1h 0m 1s');
});

test('usage reports reconcile without double counting or rewinding an active timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 20 });
  await act(() => t.mock.timers.tick(2000));
  f.goal = { ...f.goal, timeUsedSeconds: 22 };
  await m.render();
  assert.equal(m.pill().textContent, '22s');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '23s');
  f.goal = { ...f.goal, timeUsedSeconds: 21 };
  await m.render();
  assert.equal(m.pill().textContent, '23s');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '24s');
  f.goal = { ...f.goal, timeUsedSeconds: 30 };
  await m.render();
  assert.equal(m.pill().textContent, '30s');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '31s');
});

test('a subsecond usage report keeps exact second boundaries without floating point skips', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 20 });
  await act(() => t.mock.timers.tick(1577));
  assert.equal(m.pill().textContent, '21s');
  f.goal = { ...f.goal, timeUsedSeconds: 21 };
  await m.render();
  await act(() => t.mock.timers.tick(423));
  assert.equal(m.pill().textContent, '22s');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '23s');
});

test('a forward usage correction between ticks preserves the next second boundary', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 20 });
  await act(() => t.mock.timers.tick(500));
  f.goal = { ...f.goal, timeUsedSeconds: 21 };
  await m.render();
  assert.equal(m.pill().textContent, '21s');
  await act(() => t.mock.timers.tick(500));
  assert.equal(m.pill().textContent, '22s');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '23s');
});

test('a hidden window parks the timer and catches up when shown', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  t.after(() => {
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
  });
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 20 });
  const show = (visibilityState: string) =>
    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibilityState });
      document.dispatchEvent(new window.Event('visibilitychange') as any);
    });
  await show('hidden');
  await act(() => t.mock.timers.tick(5000));
  assert.equal(m.pill().textContent, '20s');
  await show('visible');
  assert.equal(m.pill().textContent, '25s');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '26s');
});

test('pause, blocked, limited and complete goals stop ticking; resume excludes stopped time', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 20 });
  await m.open();
  await act(() => t.mock.timers.tick(1000));
  for (const status of ['paused', 'blocked', 'usageLimited', 'budgetLimited', 'stopped'] as const) {
    f.goal = { ...f.goal, status, timeUsedSeconds: 21 };
    await m.render();
    const stoppedSummary = m.card()!.querySelector('.goal-card-summary')!.textContent;
    await act(() => t.mock.timers.tick(60_000));
    assert.equal(m.card()!.querySelector('.goal-card-summary')!.textContent, stoppedSummary);
    assert.match(stoppedSummary!, /21s elapsed/);
  }
  f.goal = { ...f.goal, status: 'active' };
  await m.render();
  assert.equal(m.pill().textContent, '21s');
  await act(() => t.mock.timers.tick(1000));
  assert.equal(m.pill().textContent, '22s');
  f.goal = { ...f.goal, status: 'complete' };
  await m.render();
  await act(() => t.mock.timers.tick(60_000));
  assert.equal(m.pill(), null);
});

test('goal clocks follow their owners and Strict Mode releases every poll while the pill is away', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const interval = t.mock.method(globalThis, 'setInterval');
  const clear = t.mock.method(globalThis, 'clearInterval');
  const host = document.createElement('div');
  const root = createRoot(host);
  let chatId = 'chat-1';
  let goal: ChatGoal = { ...original, status: 'active', timeUsedSeconds: 20 };
  let last: number;
  const Probe = () => {
    const session = useSession(chatId);
    last = useGoalElapsed(chatId, session.goal!, session.goalClock);
    return createElement('span', null, last);
  };
  const render = () =>
    act(async () => {
      await setGoalSnapshot(chatId, goal);
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
  resetGoalSessions();
  await render();
  await act(() => t.mock.timers.tick(2500));
  assert.equal(last!, 22);
  chatId = 'chat-2';
  await render();
  assert.equal(last!, 20);
  await act(() => t.mock.timers.tick(999));
  assert.equal(last!, 20);
  await act(() => t.mock.timers.tick(1));
  assert.equal(last!, 21, 'replacement ticks one second after taking ownership, independent of the old phase');
  goal = { ...goal, threadId: 'native-2' };
  await render();
  assert.equal(last!, 20);
  await act(() => t.mock.timers.tick(1000));
  goal = { ...goal, createdAt: 2 };
  await render();
  assert.equal(last!, 20);
  await act(() => t.mock.timers.tick(1000));
  goal = { ...goal, claude: { iterations: 3, lastReason: null, limit: 30 } };
  await render();
  const rendered = last!;
  await act(() => t.mock.timers.tick(10_000));
  assert.equal(last!, rendered);
  goal = { ...goal, claude: undefined };
  await render();
  assert.equal(last!, 20);
  await act(() => t.mock.timers.tick(1000));
  assert.equal(last!, 21);
  await act(() => root.render(null));
  assert.equal(clear.mock.callCount(), interval.mock.callCount(), 'every clock subscription is released');
  await act(() => t.mock.timers.tick(30_000));
  await render();
  assert.equal(last!, 51, 'a remount reads elapsed time from the session clock');
  await act(() => root.unmount());
  assert.equal(clear.mock.callCount(), interval.mock.callCount());
});

test('round-based progress remains rounds while time passes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const m = await mount(t, { ...original, status: 'active', claude: { iterations: 3, lastReason: null, limit: 30 } });
  await act(() => t.mock.timers.tick(10_000));
  assert.equal(m.pill().textContent, '3 turns');
});
