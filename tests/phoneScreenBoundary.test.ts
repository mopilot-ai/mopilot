// A chat that cannot be drawn or is still loading is never a white screen: the page says it is loading, or says what failed and offers Back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { fakeDraft } from './support/phone/drafts';

// through variables, so the desktop typecheck does not follow into React Native's global types
const boundaryPath = '../mobile/src/components/ScreenBoundary';
const threadPath = '../mobile/src/screens/Thread';
const { ScreenBoundary, boundaryMessage } = await import(boundaryPath);
const { Thread } = await import(threadPath);
const { withOutbox } = await import('./support/phone/outbox-kit');

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const Boom = ({ what }: { what: unknown }) => {
  throw what;
};

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('a screen that draws is shown as it is', async () => {
  const v = await mount(createElement(ScreenBoundary, null, createElement('p', null, 'fine')));
  assert.equal(v.host.textContent, 'fine');
  await v.done();
});

test('a screen that throws while drawing says why and Back leaves it; the exception is reported', async () => {
  await quiet(async () => {
    const reported: unknown[] = [];
    let backs = 0;
    const v = await mount(
      createElement(ScreenBoundary, {
        back: () => void backs++,
        report: (e: unknown) => void reported.push(e),
        children: createElement(Boom, { what: new Error('rows.map is not a function') }),
      }),
    );
    assert.match(v.host.textContent!, /This screen could not be shown: rows\.map is not a function/);
    assert.equal(reported.length, 1);
    const back = [...v.host.querySelectorAll('[role="button"], button, div')].find((n) => n.textContent === 'Back') as HTMLElement;
    await act(async () => back.click());
    assert.equal(backs, 1);
    await v.done();
  });
});

test('a thrown string, with no way back, still shows a line and no button; the default report is a warning', async () => {
  await quiet(async () => {
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a);
    try {
      const v = await mount(createElement(ScreenBoundary, null, createElement(Boom, { what: 'plain text' })));
      assert.equal(v.host.textContent, 'This screen could not be shown: plain text');
      assert.equal(warned.length, 1);
      await v.done();
    } finally {
      console.warn = warn;
    }
  });
  assert.equal(boundaryMessage(new Error('x')), 'This screen could not be shown: x');
});

function thread(request: (m: string) => Promise<unknown>) {
  const runtime: any = { snapshot: () => ({ selectedPair: 'p', generation: 1 }), onEvent: () => () => undefined, request };
  withOutbox(runtime);
  return createElement(Thread, {
    runtime,
    chatId: 'c',
    back: () => undefined,
    drafts: fakeDraft(''),
  });
}

test('a chat whose Mac has not answered shows a spinner, not a blank page and not loading text, then its rows in its place', async () => {
  let answer: (v: unknown) => void = () => undefined;
  const v = await mount(thread((m) => (m === 'chat.follow' ? new Promise((r) => (answer = r)) : Promise.resolve({}))));
  assert.ok(v.host.querySelector('[role="progressbar"][aria-label="Loading chat"]'));
  assert.doesNotMatch(v.host.textContent!, /Loading chat/);
  await act(async () =>
    answer({
      rev: 1,
      feedSeq: 0,
      session: { turn: 'idle', cards: [] },
      itemsShape: 'rows',
      items: [{ role: 'assistant', text: 'Hi back' }],
    }),
  );
  await flush();
  assert.equal(v.host.querySelector('[role="progressbar"]'), null);
  assert.match(v.host.textContent!, /Hi back/);
  await v.done();
});

test('a refused chat says it could not load, not that it is loading', async () => {
  const v = await mount(thread((m) => (m === 'chat.follow' ? Promise.reject(new Error('Computer is away')) : Promise.resolve({}))));
  await flush();
  assert.match(v.host.textContent!, /Could not load this chat/);
  assert.equal(v.host.querySelector('[role="progressbar"]'), null);
  await v.done();
});

test('a chat of an away computer with nothing kept says it is waiting, not nothing', async () => {
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => undefined,
    request: () => Promise.resolve({}),
  };
  withOutbox(runtime);
  const v = await mount(
    createElement(Thread, {
      runtime,
      chatId: 'c',
      offline: true,
      back: () => undefined,
      drafts: fakeDraft(''),
    }),
  );
  assert.match(v.host.textContent!, /Waiting for your computer…/);
  await v.done();
});

test('on Android the hardware back leaves a screen that could not be drawn, as the Back button does', async () => {
  const g = globalThis as any;
  g.__phonePlatform = 'android';
  g.__phoneBackListeners = [];
  try {
    await quiet(async () => {
      let backs = 0;
      const v = await mount(
        createElement(ScreenBoundary, {
          back: () => void backs++,
          report: () => undefined,
          children: createElement(Boom, { what: new Error('x') }),
        }),
      );
      await act(async () => void (g.__phoneBackListeners as Array<() => boolean>).at(-1)!());
      assert.equal(backs, 1);
      await v.done();
    });
  } finally {
    delete g.__phonePlatform;
    g.__phoneBackListeners = [];
  }
});
