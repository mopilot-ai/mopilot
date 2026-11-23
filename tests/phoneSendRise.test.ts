// A sent message is one bubble from the tap to the landing: a ghost bubble rises from the composer's box in 0.45 s while the real bubbles underneath are drawn invisible, and Reduce Motion or an unmeasurable view just shows them.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const originPath = '../mobile/src/sendOrigin';
const ghostPath = '../mobile/src/components/RiseGhost';
const risePath = '../mobile/src/components/RiseIn';
const sentPath = '../mobile/src/components/SentBubble';
const queuedPath = '../mobile/src/components/QueuedMessages';
const composerPath = '../mobile/src/components/Composer';
const momoChatPath = '../mobile/src/screens/MomoChat';
const overlaysPath = '../mobile/src/components/FollowOverlays';
const transcriptPath = '../mobile/src/components/TranscriptBlocks';
const origin = await import(originPath);
const { armRise, launchRise, measureTop, reportSentTop, watchSentTop, watchLaunch, setRiding, RISE_WINDOW_MS } = origin;
const { RiseGhost, RISE_MS } = await import(ghostPath);
const { RiseIn } = await import(risePath);
const { SentBubble } = await import(sentPath);
const { QueuedMessages } = await import(queuedPath);
const { Composer } = await import(composerPath);
const { FollowOverlays } = await import(overlaysPath);
const g = globalThis as any;

const mounted: { root: any; host: HTMLElement }[] = [];
async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return host;
}
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
beforeEach(() => {
  g.__phoneTimings = [];
  g.__phoneWindowTop = 100;
});
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
  setRiding(false);
  delete g.__phoneWindowTop;
  delete g.__phoneReduceMotion;
  delete g.__phoneNoMeasure;
});
const scroller = { current: { measureInWindow: (done: any) => done(0, 140, 1, 1) } };

test('the ghost rises from the composer to the top of the list on an even curve, then goes away', async () => {
  const host = await mount(createElement(RiseGhost, { scroller }));
  armRise(Promise.resolve(800));
  launchRise('hello there');
  await wait(20);
  assert.ok(host.textContent!.includes('hello there'), 'the ghost carries the sent text');
  assert.equal(RISE_MS, 450);
  assert.equal(g.__phoneTimings[0].to, 0);
  assert.equal(g.__phoneTimings[0].config.duration, RISE_MS);
  assert.deepEqual(g.__phoneTimings[0].config.easing, { bezier: [0.4, 0, 0.2, 1] });
  await wait(RISE_MS + 60);
  assert.equal(host.textContent, '', 'the real bubble is there under it when it lands');
});

test('while it rises the bubbles drawn after the send are invisible, so there is one bubble from the tap to the landing', async () => {
  const before = await mount(createElement(RiseIn, { rises: true }, createElement('span', null, 'old')));
  await mount(createElement(RiseGhost, { scroller }));
  armRise(Promise.resolve(800));
  launchRise('x');
  const opacities = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-style]')].map((n) => JSON.parse(n.getAttribute('data-style')!).opacity);
  const sent = await mount(createElement(RiseIn, { rises: true }, createElement('span', null, 'new')));
  const copy = await mount(createElement(RiseIn, { rises: false }, createElement('span', null, 'copy')));
  await wait(5);
  assert.deepEqual(opacities(before), [], 'a message that was already there stays');
  assert.deepEqual(opacities(sent), [0], 'the bubble of the send hides under the ghost');
  assert.deepEqual(opacities(copy), [], 'a copy drawn on another page has no ghost over it');
  await wait(RISE_MS + 60);
  assert.deepEqual(opacities(sent), [], 'and shows when the ghost has landed');
});

test('Reduce Motion, an unmeasurable view, or a late tap shows the bubbles at once and no ghost rises', async () => {
  g.__phoneReduceMotion = true;
  const host = await mount(createElement(RiseGhost, { scroller }));
  armRise(Promise.resolve(800));
  launchRise('quiet');
  await wait(20);
  assert.equal(host.textContent, '');
  assert.deepEqual(g.__phoneTimings, []);
  await act(async () => mounted.pop()!.root.unmount());
  delete g.__phoneReduceMotion;
  // the start cannot be measured
  const other = await mount(createElement(RiseGhost, { scroller }));
  armRise(Promise.resolve(null));
  launchRise('lost');
  await wait(20);
  assert.equal(other.textContent, '');
  // a tap that is too old, or none at all, launches nothing
  const realNow = Date.now;
  armRise(Promise.resolve(800));
  Date.now = () => realNow() + RISE_WINDOW_MS + 1;
  try {
    launchRise('stale');
  } finally {
    Date.now = realNow;
  }
  launchRise('never tapped');
  await wait(20);
  assert.equal(other.textContent, '');
  assert.deepEqual(g.__phoneTimings, []);
});

test('the ghost needs the list too: a list that cannot be measured does not rise', async () => {
  const host = await mount(createElement(RiseGhost, { scroller: { current: null } }));
  armRise(Promise.resolve(800));
  launchRise('nowhere');
  await wait(20);
  assert.equal(host.textContent, '');
});

test('a ghost that leaves with the page clears what it hid and stops listening', async () => {
  await mount(createElement(RiseGhost, { scroller }));
  armRise(Promise.resolve(800));
  launchRise('x');
  await act(async () => mounted.pop()!.root.unmount());
  armRise(Promise.resolve(800));
  launchRise('after');
  const probe = await mount(createElement(RiseIn, { rises: true }, createElement('span', null, 'p')));
  assert.equal(probe.querySelector('[data-style]'), null, 'nothing is hidden once the ghost is gone');
});

test('a newer listener replaces an older one, and measuring needs a view that can', async () => {
  const seen: unknown[] = [];
  const stop = watchLaunch((l: unknown) => seen.push(l));
  const other: unknown[] = [];
  const stopOther = watchLaunch((l: unknown) => other.push(l));
  stop();
  armRise(Promise.resolve(1));
  launchRise('a');
  assert.equal(other.length, 1, 'the first listener stopping does not remove the newer one');
  stopOther();
  setRiding(false);
  assert.equal(await measureTop(null), null);
  assert.equal(await measureTop({}), null);
  assert.equal(await measureTop({ measureInWindow: (done: any) => done(0, 33, 1, 1) }), 33);
});

test('the sent bubble reports its place, and a newer watcher replaces an older one', async () => {
  const seen: number[] = [];
  const stop = watchSentTop((y: number) => seen.push(y));
  g.__phoneOnLayout = undefined;
  await mount(createElement(SentBubble, { id: 'a', text: 'hello' }));
  const layout = [...document.querySelectorAll('div')].map((d: any) => d.__onLayout).filter(Boolean);
  layout.at(-1)({ nativeEvent: { layout: { y: 321 } } });
  assert.deepEqual(seen, [321]);
  const other: number[] = [];
  const stopOther = watchSentTop((y: number) => other.push(y));
  stop();
  reportSentTop(5);
  assert.deepEqual(other, [5]);
  stopOther();
  reportSentTop(6);
  assert.deepEqual(other, [5]);
});

test('the outbox bubble reports where the newest message sits in the list', async () => {
  const seen: number[] = [];
  const stop = watchSentTop((y: number) => seen.push(y));
  const item = (id: string) => ({ id, text: id, attachments: [], status: 'sending', attempted: true });
  const host = await mount(createElement(QueuedMessages, { items: [item('one'), item('two')], cancel: () => {}, retry: () => {} }));
  const handlers = [...host.querySelectorAll('div')].map((d: any) => d.__onLayout);
  const root = handlers[0];
  const itemLayouts = handlers.slice(1).filter(Boolean);
  assert.equal(itemLayouts.length, 1, 'only the newest message reports');
  itemLayouts[0]({ nativeEvent: { layout: { y: 50 } } });
  assert.deepEqual(seen, [], 'not before the list itself is placed');
  root({ nativeEvent: { layout: { y: 1000 } } });
  assert.deepEqual(seen, [1050]);
  stop();
  // a copy drawn on another page reports nothing
  const copy = await mount(
    createElement(QueuedMessages, { rises: false, pins: false, items: [item('c')], cancel: () => {}, retry: () => {} }),
  );
  const copyHandlers = [...copy.querySelectorAll('div')].map((d: any) => d.__onLayout);
  const again = watchSentTop((y: number) => (seen as number[]).push(y));
  copyHandlers.forEach((h: any) => h?.({ nativeEvent: { layout: { y: 1 } } }));
  assert.deepEqual(seen, [1050]);
  again();
});

test('tapping Send arms the rise from the box measured at the tap', async () => {
  const props = {
    draft: 'hi',
    setDraft: () => {},
    placeholder: 'x',
    focusKey: 'k',
    autoFocus: false,
    running: false,
    disabled: false,
    stopDisabled: false,
    send: () => {},
  };
  const host = await mount(createElement(Composer, props));
  const launches: { text: string; start: Promise<number | null> }[] = [];
  const stop = watchLaunch((l: any) => launches.push(l));
  g.__phoneWindowTop = 640;
  (host.querySelector('button[aria-label="Send message"]') as HTMLElement).click();
  launchRise('hi');
  assert.equal(await launches[0].start, 640);
  stop();
  setRiding(false);
});

test("MoMo's composer arms it too", async () => {
  const { MomoComposer } = await import(momoChatPath);
  let sent = 0;
  const host = await mount(
    createElement(MomoComposer, { draft: 'hi', setDraft: () => {}, send: () => sent++, stop: () => {}, working: false, disabled: false }),
  );
  const launches: { start: Promise<number | null> }[] = [];
  const stop = watchLaunch((l: any) => launches.push(l));
  g.__phoneWindowTop = 555;
  (host.querySelector('button[aria-label="Send"]') as HTMLElement).click();
  launchRise('hi');
  assert.equal(sent, 1);
  assert.equal(await launches[0].start, 555);
  stop();
  setRiding(false);
});

test('the overlays are the ghost, and the arrow only while the reply is past the fold', async () => {
  let jumped = 0;
  const host = await mount(createElement(FollowOverlays, { scroller, away: false, jump: () => jumped++ }));
  assert.equal(host.querySelector('button[aria-label="Jump to the latest message"]'), null);
  const shown = await mount(createElement(FollowOverlays, { scroller, away: true, jump: () => jumped++ }));
  (shown.querySelector('button[aria-label="Jump to the latest message"]') as HTMLElement).click();
  assert.equal(jumped, 1);
});

test('a second send while the first is still rising replaces its ghost', async () => {
  const host = await mount(createElement(RiseGhost, { scroller }));
  armRise(Promise.resolve(800));
  launchRise('first');
  await wait(20);
  armRise(Promise.resolve(800));
  launchRise('second');
  await wait(20);
  assert.ok(host.textContent!.includes('second'));
  await wait(RISE_MS + 60);
  assert.equal(host.textContent, '');
});

test('the list melts into the composer: bands from clear to the page colour, and none that take a touch', async () => {
  const { FADE_ALPHAS, FADE_BANDS } = await import(overlaysPath);
  const host = await mount(createElement(FollowOverlays, { scroller, away: false, jump: () => {} }));
  assert.equal(FADE_ALPHAS.length, FADE_BANDS);
  assert.ok(
    FADE_ALPHAS.every((a: number, i: number) => a > 0 && a <= 1 && (i === 0 || a > FADE_ALPHAS[i - 1])),
    'each band is more opaque than the one above',
  );
  assert.equal(FADE_ALPHAS.at(-1), 1, 'the last band is the page colour');
  const bands = [...host.querySelectorAll('[data-style]')].filter((n) => /backgroundColor/.test(n.getAttribute('data-style')!));
  assert.equal(bands.length, FADE_BANDS);
});

test('a list that went empty and has a new message again reports from its new place, never from where it was before', async () => {
  const seen: number[] = [];
  const stop = watchSentTop((y: number) => (seen as number[]).push(y));
  const item = { id: 'a', text: 'a', attachments: [], status: 'queued', attempted: false };
  const props = { cancel: () => {}, retry: () => {} };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const layouts = () => [...host.querySelectorAll('div')].map((d: any) => d.__onLayout);
  await act(async () => root.render(createElement(QueuedMessages, { items: [item], ...props })));
  let [list, row] = layouts().filter(Boolean);
  row({ nativeEvent: { layout: { y: 50 } } });
  list({ nativeEvent: { layout: { y: 1000 } } });
  assert.deepEqual(seen, [1050]);
  // the message goes (the computer took it), the list is not drawn; then another message comes
  await act(async () => root.render(createElement(QueuedMessages, { items: [], ...props })));
  await act(async () => root.render(createElement(QueuedMessages, { items: [{ ...item, id: 'b' }], ...props })));
  [list, row] = layouts().filter(Boolean);
  row({ nativeEvent: { layout: { y: 60 } } });
  assert.deepEqual(seen, [1050], 'the old place of the list is not used for the new message');
  list({ nativeEvent: { layout: { y: 2000 } } });
  assert.deepEqual(seen, [1050, 2060]);
  stop();
});

test('only the newest message of yours that the computer holds reports its place, as a correction', async () => {
  const { TranscriptBlocks } = await import(transcriptPath);
  const seen: [number, boolean | undefined][] = [];
  const stop = watchSentTop((y: number, refine?: boolean) => (seen as [number, boolean | undefined][]).push([y, refine]));
  const row = (key: string, role: string, text: string) => ({ type: 'row', row: { key, role, text } });
  g.__phoneOnLayout = undefined;
  const host = await mount(
    createElement(TranscriptBlocks, {
      blocks: [row('a', 'user', 'first'), row('b', 'assistant', 'reply'), row('c', 'user', 'second'), row('d', 'assistant', 'reply two')],
      streamingKey: null,
      request: async () => ({}),
      chatId: 'c',
    }),
  );
  // (the stand-in keeps the latest layout handler an animated view was given: only the newest row of yours is given one)
  g.__phoneOnLayout({ nativeEvent: { layout: { y: 777 } } });
  assert.deepEqual(seen, [[777, true]]);
  assert.equal(host.querySelectorAll('[data-layout]').length, 4);
  stop();
});

test('while the queued bubble is drawn, a record of an older message of yours does not report: only the bubble says where the new one is', async () => {
  const { TranscriptBlocks } = await import(transcriptPath);
  const seen: unknown[] = [];
  const stop = watchSentTop((y: number) => seen.push(y));
  const row = (key: string, role: string, text: string, optimistic = false) => ({ type: 'row', row: { key, role, text, optimistic } });
  g.__phoneOnLayout = undefined;
  await mount(
    createElement(TranscriptBlocks, {
      blocks: [row('a', 'user', 'first'), row('b', 'assistant', 'reply'), row('q', 'user', 'second', true)],
      streamingKey: null,
      request: async () => ({}),
      chatId: 'c',
    }),
  );
  assert.equal(g.__phoneOnLayout, undefined, 'no row of the computer reports while the bubble stands for the newest message');
  assert.deepEqual(seen, []);
  stop();
});
