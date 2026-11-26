// A footer under the list (the Changes chip after a turn, the composer growing) shortens the view; the end then comes back over a moment, not in one frame, so the thread does not seem to jump by the height of what appeared (#5686). The keyboard's own slide, a reply growing and a reader who left the end are as they were.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
import { fakeDraft } from './support/phone/drafts';

const threadPath = '../mobile/src/screens/Thread';
const { Thread } = await import(threadPath);

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
  (globalThis as any).__phoneReduceMotion = false;
});
const g = globalThis as any;

async function open() {
  g.__scrolledToEnd = [];
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
  return {
    calls: () => g.__scrolledToEnd as { animated?: boolean }[],
    layout: (height: number) => act(async () => g.__scrollEvents.onLayout({ nativeEvent: { layout: { height } } })),
    report: async (y: number, content = 2000, view = 600) => {
      const event = new Event('scroll');
      Object.assign(event, { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } });
      await act(async () => void list().dispatchEvent(event));
    },
    keyboard: (name: string) => act(async () => g.__keyboardListeners[name]?.()),
    grow: (height: number) => act(async () => g.__scrollEvents.onContentSizeChange(0, height)),
  };
}

test('a footer that shortens the view brings the end back over a moment, once, and the first layout does not', async () => {
  const t = await open();
  await t.layout(600);
  assert.deepEqual(t.calls().at(-1), { animated: false }, 'the first layout of the list is not a footer');
  const before = t.calls().length;
  await t.layout(552); // the Changes chip appears
  assert.equal(t.calls().length, before + 1);
  assert.deepEqual(t.calls().at(-1), { animated: true }, 'the thread glides by the chip’s height');
  await t.layout(580); // the composer grows by a line less than before... any footer change
  assert.deepEqual(t.calls().at(-1), { animated: true });
  await t.layout(580); // the same height again says nothing new
  assert.deepEqual(t.calls().at(-1), { animated: false }, 'a layout with the same height is an ordinary one');
});

test('the keyboard coming up, changing height (a candidate bar) and going down brings the end back over a moment too, once per frame of the view', async () => {
  const t = await open();
  await t.layout(600);
  await t.keyboard('keyboardWillShow');
  await t.layout(300);
  assert.deepEqual(t.calls().at(-1), { animated: true }, 'the keyboard resized the view: no one-frame jump');
  await t.keyboard('keyboardDidShow');
  await t.layout(270); // the composer grows with the keyboard up
  assert.deepEqual(t.calls().at(-1), { animated: true });
  await t.layout(255); // the candidate bar of a Chinese keyboard changes the keyboard's height
  assert.deepEqual(t.calls().at(-1), { animated: true });
  await t.layout(300); // and back
  assert.deepEqual(t.calls().at(-1), { animated: true });
});

test('a reader who left the end, a finger on the list, and Reduce Motion each get no glide', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.report(1000);
  const before = t.calls().length;
  await t.layout(552);
  assert.equal(t.calls().length, before, 'a reader who left the end is not moved');
  // a finger resting on the list holds the view too
  const t3 = await open();
  await t3.layout(600);
  await act(async () => g.__scrollEvents.onTouchStart({ nativeEvent: { touches: [{}] } }));
  const held = t3.calls().length;
  await t3.layout(552);
  assert.equal(t3.calls().length, held, 'a finger on the list holds the view');
  g.__phoneReduceMotion = true;
  const t2 = await open();
  await t2.layout(600);
  await t2.layout(552);
  assert.deepEqual(t2.calls().at(-1), { animated: false }, 'Reduce Motion: no animation');
});

test('typing for a reader who scrolled up moves nothing: not the composer growing, not the keyboard or its candidate bar changing height', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(1400);
  await t.report(900);
  const before = t.calls().length;
  await t.keyboard('keyboardWillShow');
  for (const h of [300, 280, 255, 300, 270, 600, 300]) await t.layout(h);
  await t.keyboard('keyboardDidShow');
  await t.keyboard('keyboardDidChangeFrame');
  await t.grow(2100);
  await t.keyboard('keyboardDidHide');
  assert.equal(t.calls().length, before, 'the reader’s place is theirs');
});

test('the keyboard’s settled events take a reader who is short of the end back to it over a moment, never in one frame, and close a residual of a few points at once', async () => {
  const t = await open();
  await t.layout(600);
  await t.report(1000); // 400 short of the end
  for (const name of ['keyboardDidShow', 'keyboardDidChangeFrame', 'keyboardDidHide']) {
    const before = t.calls().length;
    await t.keyboard(name);
    assert.equal(t.calls().length, before + 1);
    assert.deepEqual(t.calls().at(-1), { animated: true }, name);
  }
  await t.report(1396); // 4 short: the lift's own residual
  await t.keyboard('keyboardDidShow');
  assert.deepEqual(t.calls().at(-1), { animated: false }, 'a few points are not worth a glide');
});
