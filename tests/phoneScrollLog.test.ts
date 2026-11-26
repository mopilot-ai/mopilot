// The scroll log (#5686): while the performance log is on, every scroll the chat asks of the list is counted by its reason, and so is a move of the view that no call and no finger made. Counts only, and nothing when the log is off.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const perfPath = '../mobile/src/perfLog';
const { Thread } = await import(threadPath);
const { perf } = await import(perfPath);

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  perf.end();
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});
const g = globalThis as any;

async function open() {
  g.__scrolledToEnd = [];
  g.__scrolledTo = [];
  const rig = scripted((m) =>
    m === 'chat.follow'
      ? {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'running', cards: [] },
          itemsShape: 'rows',
          items: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i}` })),
        }
      : undefined,
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(Thread, { runtime: rig.runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') })));
  await flush();
  const list = () => document.querySelector('[scrolleventthrottle]')!;
  const ev = () => g.__scrollEvents;
  return {
    events: () => perf.report().events as Record<string, number>,
    report: async (y: number, content = 2000, view = 600) => {
      const event = new Event('scroll');
      Object.assign(event, { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } });
      await act(async () => void list().dispatchEvent(event));
    },
    grow: (h: number) => act(async () => ev().onContentSizeChange(0, h)),
    layout: (h: number) => act(async () => ev().onLayout({ nativeEvent: { layout: { height: h } } })),
    keyboard: (name: string) => act(async () => g.__keyboardListeners[name]?.()),
    touch: () => act(async () => ev().onTouchStart({ nativeEvent: { touches: [{}] } })),
    release: () => act(async () => ev().onTouchEnd({ nativeEvent: { touches: [] } })),
  };
}

test('each scroll the chat asks for is counted by its reason; a footer’s glide counts as a layout scroll; the log being off counts nothing', async () => {
  const t = await open();
  await t.report(1400);
  await t.grow(2100);
  assert.equal(t.events()['scroll-growth'], undefined, 'the log is off until Settings turns it on');
  perf.start();
  await t.grow(2200);
  await t.layout(600);
  await t.layout(552);
  await t.keyboard('keyboardDidShow');
  await t.touch();
  await t.grow(2300);
  await t.release();
  const seen = t.events();
  assert.equal(seen['scroll-growth'], 1);
  assert.equal(seen['scroll-layout'], 2, 'the first layout and the footer one');
  assert.equal(seen['scroll-keyboard'], 1);
  assert.equal(seen['scroll-rest'], 1, 'the catch-up after the finger left');
  assert.equal(seen['scroll-native-shift'], undefined, 'nothing moved the view by itself');
});

test('a move of the view that no call and no finger made is counted, and not one a call of ours just made; a clamp is counted', async () => {
  const t = await open();
  perf.start();
  await t.report(1400);
  // a shift with no finger and no call behind it
  await t.report(1330);
  await t.report(1400);
  assert.equal(t.events()['scroll-native-shift'], 2, 'the view moved by itself twice');
  // a scroll of ours, then the view reports its own motion: not a shift
  await t.grow(2300);
  await t.report(1500, 2300);
  await t.report(1700, 2300);
  assert.equal(t.events()['scroll-native-shift'], 2, 'the report that follows our own scroll is not a shift');
  // content shorter under a view that stands past its end: the chat clamps it
  await t.report(2300, 2000);
  assert.equal(t.events()['scroll-clamp'], 1);
});

test('under a finger the reader moves the view: nothing is counted as a shift', async () => {
  const t = await open();
  perf.start();
  await t.report(1400);
  await t.touch();
  await t.report(1100);
  await t.report(900);
  assert.equal(t.events()['scroll-native-shift'], undefined);
});
