// Arrival animations in a thread (arrival.tsx): which rows and replies fade in, history shown whole, and saved reveal positions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ArrivalContext,
  Enter,
  Reveal,
  act,
  clock,
  createElement,
  createRoot,
  media,
  mount,
  run,
  tick,
  timers,
  useArrived,
  useSmoothText,
  window,
} from './support/smoothText.ts';

test('a remount resumes its prefix without replaying fades', async () => {
  clock.now = 0;
  const first = await mount('remount', 'a long streamed reply that goes on and on '.repeat(4));
  await run(200);
  const shown = first.host.textContent!;
  assert.ok(shown.length > 0);
  await first.close();
  const next = await mount('remount', 'a long streamed reply that goes on and on '.repeat(4));
  try {
    assert.equal(next.host.textContent, shown);
    assert.equal(next.host.firstElementChild!.getAttribute('data-animate'), 'false');
    assert.equal(next.host.firstElementChild!.getAttribute('data-steps'), '', 'a resumed reply fades nothing');
    await next.update('a long streamed reply that goes on and on '.repeat(4), false);
    await run(clock.now + 1000);
    assert.equal(next.host.textContent, 'a long streamed reply that goes on and on '.repeat(4));
  } finally {
    await next.close();
  }
});

test('reduced motion renders received text immediately and disables fades', async () => {
  media.matches = true;
  const m = await mount('reduced', '你好👩🏽‍💻');
  try {
    assert.equal(m.host.textContent, '你好👩🏽‍💻');
    assert.equal(m.host.firstElementChild!.getAttribute('data-animate'), 'false');
    assert.equal(timers.size, 0);
  } finally {
    await m.close();
    media.matches = false;
  }
});
test('turning reduced motion on mid-reply shows the rest at once', async () => {
  clock.now = 0;
  const m = await mount('switch', 'a reply that keeps going');
  try {
    assert.equal(m.host.firstElementChild!.getAttribute('data-animate'), 'true');
    media.matches = true;
    await act(() => {
      media.dispatchEvent(new window.Event('change'));
    });
    assert.equal(m.host.textContent, 'a reply that keeps going');
    assert.equal(m.host.firstElementChild!.getAttribute('data-animate'), 'false');
  } finally {
    await m.close();
    media.matches = false;
  }
});

test('only rows that mount after the chat painted, while their turn runs, fade in; the decision sticks', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const Probe = ({ id, running }: any) => createElement('i', null, String(useArrived(id, running)));
  const view = (ready: boolean, running: boolean) =>
    createElement(
      ArrivalContext.Provider,
      { value: { ready } },
      createElement(Enter, { id: 'row-history', running } as any, createElement('b', null, 'old')),
      createElement(
        Enter,
        { key: ready ? 'row-live' : 'row-early', id: ready ? 'row-live' : 'row-early', running } as any,
        createElement('b', null, 'new'),
      ),
      createElement(Probe, { id: 'row-history', running }),
    );
  try {
    await act(() => root.render(view(false, true)));
    assert.equal(host.querySelectorAll('.item-enter').length, 0);
    await act(() => root.render(view(true, true)));
    assert.equal(host.querySelectorAll('.item-enter').length, 1);
    assert.equal(host.querySelector('.item-enter')!.textContent, 'new');
    assert.equal(host.querySelector('i')!.textContent, 'false'); // decided when it first mounted
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

test('a block rises into place only when it appears live after the chat painted (#1511 error card)', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const card = (id: string, live: boolean) => createElement(Reveal, { key: id, id, live, className: 'turn-error' } as any, id);
  const view = (ready: boolean, cards: [string, boolean][]) =>
    createElement(ArrivalContext.Provider, { value: { ready } }, ...cards.map(([id, live]) => card(id, live)));
  const classOf = (id: string) => [...host.querySelectorAll('.turn-error')].find((e) => e.textContent === id)!.className;
  try {
    // already there when the chat opens: still
    await act(() => root.render(view(false, [['open-error', true]])));
    assert.equal(classOf('open-error'), 'turn-error');
    // the latest turn's error appearing live rises in; an earlier turn's does not
    await act(() =>
      root.render(
        view(true, [
          ['open-error', true],
          ['live-error', true],
          ['history-error', false],
        ]),
      ),
    );
    assert.equal(classOf('live-error'), 'turn-error reveal-in');
    assert.equal(classOf('history-error'), 'turn-error');
    assert.equal(classOf('open-error'), 'turn-error', 'decided when it first mounted');
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

test('text that is already there when the chat opens is shown whole', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const Finished = ({ id, text }: any) =>
    createElement('div', { 'data-animate': String(useSmoothText(id, text, false).animate) }, useSmoothText(id, text, false).text);
  try {
    await act(() =>
      root.render(
        createElement(ArrivalContext.Provider, { value: { ready: true } }, createElement(Finished, { id: 'done', text: 'finished reply' })),
      ),
    );
    assert.equal(host.textContent, 'finished reply');
    assert.equal(host.firstElementChild!.getAttribute('data-animate'), 'false');
    assert.equal(timers.size, 0);
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

test('a reply that first arrives completed is fully visible without a frame', async () => {
  clock.now = 0;
  const m = await mount('arrived-completed', '');
  try {
    await m.update('A completed response arriving with its turn completion.', false);
    await run(600);
    assert.equal(m.host.textContent, 'A completed response arriving with its turn completion.');
    assert.equal(timers.size, 0);
  } finally {
    await m.close();
  }
});

test('completion survives remounting without replaying fades or hiding the tail', async () => {
  clock.now = 0;
  const text = 'Reply that moves from work to the final answer.';
  const first = await mount('completed-remount', text);
  await first.update(text, false);
  await run(clock.now + 600);
  assert.equal(first.host.textContent, text);
  await first.close();
  const next = await mount('completed-remount', text);
  try {
    assert.equal(next.host.textContent, text);
    assert.equal(next.host.firstElementChild!.getAttribute('data-animate'), 'false');
    await tick(clock.now);
    assert.equal(timers.size, 0, 'a whole reply has nothing to step');
  } finally {
    await next.close();
  }
});

test('history renders immediately when a chat has not painted or a turn is already finished', async () => {
  for (const [id, options] of [
    ['history-before-paint', { ready: false }],
    ['history-finished', { arriving: false }],
  ] as const) {
    const m = await mount(id, 'Historical response.', options);
    try {
      assert.equal(m.host.textContent, 'Historical response.');
      assert.equal(m.host.firstElementChild!.getAttribute('data-animate'), 'false');
      await m.update('Historical response with authoritative correction.', false);
      assert.equal(m.host.textContent, 'Historical response with authoritative correction.');
      assert.equal(timers.size, 0);
    } finally {
      await m.close();
    }
  }
});

test('turn status remains the default streaming signal', async () => {
  clock.now = 0;
  const m = await mount('default-streaming', 'A response.', { defaultStreaming: true });
  try {
    assert.equal(m.host.textContent, '');
    await m.update('A response.', false);
    await run(600);
    assert.equal(m.host.textContent, 'A response.');
    assert.equal(timers.size, 0);
  } finally {
    await m.close();
  }
});

test('entrance fades apply only to new live items and remain decided across updates', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const render = async (id: string, ready: boolean, running: boolean) =>
    act(() =>
      root.render(
        createElement(ArrivalContext.Provider, { value: { ready } }, createElement(Enter, { key: id, id, running, children: 'An item.' })),
      ),
    );
  try {
    await render('entrance-live', true, true);
    assert.equal(host.querySelector('.item-enter')?.textContent, 'An item.');
    await render('entrance-live', true, false);
    assert.ok(host.querySelector('.item-enter'));
    await render('entrance-finished', true, false);
    assert.equal(host.textContent, 'An item.');
    assert.equal(host.querySelector('.item-enter'), null);
    await render('entrance-before-paint', false, true);
    assert.equal(host.querySelector('.item-enter'), null);
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
test('arrival decisions and saved prefixes are isolated between chats with identical item ids', async () => {
  const history = await mount('shared-history-id', 'history', { ready: false, scope: 'chat-a' });
  await history.close();
  const live = await mount('shared-history-id', 'new reply', { scope: 'chat-b' });
  try {
    assert.equal(live.host.textContent, '');
    assert.equal(live.host.firstElementChild!.getAttribute('data-animate'), 'true');
  } finally {
    await live.close();
  }
  const first = await mount('shared-prefix-id', 'revealed reply', { scope: 'chat-a' });
  await first.update('revealed reply', false);
  await first.close();
  const other = await mount('shared-prefix-id', 'another reply', { scope: 'chat-b' });
  try {
    assert.equal(other.host.textContent, '');
    assert.equal(other.host.firstElementChild!.getAttribute('data-animate'), 'true');
  } finally {
    await other.close();
  }
  const resumed = await mount('shared-prefix-id', 'revealed reply', { scope: 'chat-a' });
  try {
    assert.equal(resumed.host.textContent, 'revealed reply');
    assert.equal(resumed.host.firstElementChild!.getAttribute('data-animate'), 'false');
  } finally {
    await resumed.close();
  }
});

test('turns in the same chat can reuse item ids without sharing reveal positions', async () => {
  const first = await mount('turn-local-id', 'first reply', { scope: 'one-chat', turn: 'turn-a' });
  await first.update('first reply', false);
  await first.close();
  const next = await mount('turn-local-id', 'second reply', { scope: 'one-chat', turn: 'turn-b' });
  try {
    assert.equal(next.host.textContent, '');
    assert.equal(next.host.firstElementChild!.getAttribute('data-animate'), 'true');
  } finally {
    await next.close();
  }
  const resumed = await mount('turn-local-id', 'first reply', { scope: 'one-chat', turn: 'turn-a' });
  try {
    assert.equal(resumed.host.textContent, 'first reply');
    assert.equal(resumed.host.firstElementChild!.getAttribute('data-animate'), 'false');
  } finally {
    await resumed.close();
  }
});
