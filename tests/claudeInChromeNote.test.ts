// The one-time Claude in Chrome note on what reaches the user's Chrome now (src/components/browser/ClaudeInChromeNote.tsx).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
let shown = true;
/** main's chromeTools: MoPilot's own extension serves Claude without Claude in Chrome */
let chromeTools = false;
let answer: (v: boolean) => void = () => {};
installNativeStub({
  browser: {
    claudeInChromeNote: (id?: string) => (
      calls.push(['ask', id]),
      new Promise<boolean>((resolve) => {
        answer = resolve;
        if (shown !== null) resolve(shown);
      })
    ),
    dismissClaudeInChromeNote: async () => void calls.push(['dismiss']),
    configure: async (c: unknown) => {
      calls.push(['configure', c]);
    },
  },
});
stubStore({
  useStore: (f: any) => f({ prefs: { chromeProfileDir: '/p' }, claude: { status: { state: 'ready' } } }),
  setPrefs: (p: unknown) => calls.push(['prefs', p]),
  toastFailure: (what: string) => () => calls.push(['toast', what]),
  navigate: (r: unknown) => calls.push(['navigate', r]),
});
// main's shared status is known, and Claude Code sessions don't run Claude in Chrome themselves
// (the status's other states are covered in nativeControlUI.test.ts)
mock.module('../src/session/nativeAvailability.ts', {
  namedExports: {
    useNativeAvailability: () => ({ harnesses: [], chromeTools }),
    claudeRunsClaudeInChrome: () => false,
    // the route itself is chromeRouteOf's (controlMatrixChromeRoute.test.ts); here only what the note does with it
    chromeRouteOf: (s: { chromeTools: boolean }, channel: string) => (channel === 'chrome' ? 'yourChrome' : s.chromeTools ? 'own' : 'none'),
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ClaudeInChromeNote, splitAction } = await import('../src/components/browser/ClaudeInChromeNote.tsx');

async function mount(threadId?: string) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(ClaudeInChromeNote, { threadId })));
  return { host, root };
}

test('the copy splits off its bracketed action, else the action is Set up', () => {
  assert.deepEqual(splitAction('Moved. [Open settings] '), ['Moved.', 'Open settings']);
  assert.deepEqual(splitAction('Moved.'), ['Moved.', 'Set up']);
});

test('not shown when main says the note is done', async () => {
  shown = false;
  const { host, root } = await mount('t1');
  assert.equal(host.innerHTML, '');
  assert.deepEqual(calls.splice(0), [['ask', 't1']]);
  await act(() => root.unmount());
});

test('closing dismisses it for good', async () => {
  shown = true;
  const { host, root } = await mount();
  assert.match(host.textContent!, /Claude in Chrome is off, and MoPilot's extension isn't available here\./);
  await act(() => (host.querySelector('[aria-label="Dismiss"]') as HTMLElement).click());
  assert.equal(host.innerHTML, '');
  assert.deepEqual(calls.splice(0), [['ask', undefined], ['dismiss']]);
  await act(() => root.unmount());
});

test('with nothing serving Claude, Use Your Chrome switches the browser once main has, then opens its settings', async () => {
  shown = true;
  const { host, root } = await mount('t2');
  const action = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Use Your Chrome')!;
  await act(async () => action.click());
  assert.deepEqual(calls.splice(0), [
    ['ask', 't2'],
    ['configure', { channel: 'chrome', profileDir: '/p' }],
    ['prefs', { browserChannel: 'chrome' }],
    ['dismiss'],
    ['navigate', { name: 'settings', section: 'browser' }],
  ]);
  await act(() => root.unmount());
});

test("#1631: where MoPilot's extension serves Claude, Set up opens Browser settings and keeps the browser channel", async () => {
  shown = true;
  chromeTools = true;
  try {
    const { host, root } = await mount('t4');
    assert.match(host.textContent!, /Claude uses your Chrome through MoPilot's extension\./);
    const action = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Set up')!;
    await act(async () => action.click());
    assert.deepEqual(calls.splice(0), [['ask', 't4'], ['dismiss'], ['navigate', { name: 'settings', section: 'browser' }]]);
    await act(() => root.unmount());
  } finally {
    chromeTools = false;
  }
});

test('an answer that lands after unmount is ignored', async () => {
  shown = null as any;
  const { host, root } = await mount('t3');
  await act(() => root.unmount());
  answer(true);
  await Promise.resolve();
  assert.equal(host.innerHTML, '');
});
