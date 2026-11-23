// The performance log's trace names why a screen drew (#4986): which props or `useState` values differ from the render before, read from React's own bookkeeping in development builds, so one run on a device says what to fix for "tap a chat row", "send" and "back".
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useState } from 'react';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';

const logPath = '../mobile/src/perfLog';
const causePath = '../mobile/src/perfCause';
const pagePath = '../mobile/src/screens/SettingsPages';
const threadPath = '../mobile/src/screens/Thread';
const { perf, usePerfRender } = await import(logPath);
const { causesOf, ownerFiber, shape } = await import(causePath);
const { AboutPage } = await import(pagePath);
const { Thread } = await import(threadPath);

afterEach(() => {
  perf.end();
  document.body.replaceChildren();
});

test('A: shapes name a value by its keys, length, number, boolean or short word, never its text', () => {
  assert.deepEqual(
    [null, undefined, [1, 2], { a: 1, b: 2, c: 3, d: 4, e: 5 }, () => 1, 'short', 'a long string of words', 7, false].map(shape),
    ['null', 'undefined', 'list2', '{a,b,c,d}', 'fn', '"short"', '"a long strin…"', '7', 'false'],
  );
});

test('A: a screen’s renders are named: the first, a state that changed, props that changed, and a render of the parent with nothing new', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let bump: () => void = () => undefined;
  let text: (value: string) => void = () => undefined;
  const Probe = ({ label }: { label: string }) => {
    const [count, setCount] = useState(0);
    const [word, setWord] = useState('a');
    bump = () => setCount((n) => n + 1);
    text = setWord;
    usePerfRender('Probe');
    return createElement('span', null, `${label}${count}${word}`);
  };
  const draw = (label: string) => act(async () => root.render(createElement(Probe, { label })));
  perf.start();
  perf.trace(true);
  await draw('x');
  await act(async () => bump());
  await act(async () => text('b'));
  await draw('y');
  await draw('y');
  const why = perf.report().why.Probe;
  assert.deepEqual(why, {
    'first render': 1,
    'state 0 0→1': 1,
    'state 1 "a"→"b"': 1,
    'props label': 1,
    'no change': 1,
  });
  await act(async () => root.unmount());
});

test('A: with the trace off nothing is recorded, and a fibre React does not give is called unavailable', () => {
  assert.deepEqual(causesOf(null), ['unavailable']);
  perf.start();
  perf.cause('Probe', ['x']);
  assert.deepEqual(perf.report().why, {}, 'not tracing: nothing');
  perf.trace(true);
  assert.equal(perf.tracing, true);
  perf.cause('Probe', ['x']);
  perf.cause('Probe', ['x']);
  assert.deepEqual(perf.report().why, { Probe: { x: 2 } });
  perf.end();
  assert.equal(perf.tracing, false, 'turning the log off turns the trace off');
  perf.trace(true);
  assert.equal(perf.tracing, false, 'the trace needs the log on');
});

test('A: the report keeps the commonest causes of a screen, and About has a switch for the trace and a row per traced screen', async () => {
  perf.start();
  perf.trace(true);
  for (let i = 0; i < 14; i += 1) for (let n = 0; n <= i; n += 1) perf.cause('Many', [`cause ${i}`]);
  const kept = Object.keys(perf.report().why.Many);
  assert.equal(kept.length, 12);
  assert.equal(kept[0], 'cause 13', 'the commonest first');
  perf.end();
  perf.start();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(AboutPage, { version: '1.0.0', back: () => undefined })));
  assert.match(host.textContent!, /Render causesWhy each screen drew\. Development builds only\.Off/);
  await click('Render causes');
  assert.equal(perf.tracing, true);
  perf.cause('Thread', ['state 33 null→{rev,session,items,shape}', 'no change']);
  perf.cause('Thread', ['no change']);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await flush();
  assert.match(host.textContent!, /Thread · whyno change 2 · state 33 null→\{rev,session,items,shape\} 1/);
  await click('Render causes');
  assert.equal(perf.tracing, false);
  await act(async () => root.unmount());
});

test('A: tracing a chat that opens names the thread arriving as the state that changed', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1, outbox: [] }),
    onEvent: () => () => undefined,
    request: async (method: string) =>
      method === 'chat.follow'
        ? {
            rev: 1,
            feedSeq: 0,
            session: { turn: 'idle', turnStatus: 'idle', cards: [] },
            itemsShape: 'items',
            history: [{ role: 'user', text: 'Old' }],
            items: [],
          }
        : {},
  };
  withOutbox(runtime);
  perf.start();
  perf.trace(true);
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => undefined, drafts: fakeDraft('') })));
  await flush();
  await flush();
  const why = Object.keys(perf.report().why.Thread ?? {});
  assert.ok(why.includes('first render'), why.join(' | '));
  assert.ok(
    why.some((cause) => /^state \d+ null→\{rev,session,items,shape\}$/.test(cause)),
    why.join(' | '),
  );
  await act(async () => root.unmount());
});

test('A: the owner fibre is null outside a render and where React gives none; fibres with no props, no earlier render or only bookkeeping say so', async () => {
  const React = await import('react');
  const internals =
    (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ??
    (React as any).default?.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  assert.equal(ownerFiber(), null, 'not inside a render');
  const saved = internals.A;
  try {
    internals.A = null;
    assert.equal(ownerFiber(), null);
    internals.A = {};
    assert.equal(ownerFiber(), null, 'a dispatcher with no owner');
  } finally {
    internals.A = saved;
  }
  const hook = (memoizedState: unknown, queue: unknown, next: any = null) => ({ memoizedState, queue, next });
  assert.deepEqual(causesOf({ memoizedProps: null, memoizedState: null, alternate: null }), ['first render']);
  const bare = { memoizedProps: null, memoizedState: null, alternate: { memoizedProps: null, memoizedState: null, alternate: null } };
  assert.deepEqual(causesOf(bare as any), ['no change'], 'no props on either side');
  const effect = { tag: 1, create: () => 1, deps: [], inst: {} };
  const fiber = {
    memoizedProps: { a: 1 },
    memoizedState: hook(effect, null, hook(2, {}, hook(['x', 'y'], null))),
    alternate: { memoizedProps: { a: 1 }, memoizedState: hook({ ...effect }, null, hook(1, {}, hook(['x', 'z'], null))), alternate: null },
  };
  assert.deepEqual(causesOf(fiber as any), ['state 1 1→2'], 'effects and memos are skipped, a held value that changed is named');
});
