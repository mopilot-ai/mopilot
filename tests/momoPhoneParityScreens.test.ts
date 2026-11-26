// What the classic MoMo screen does that the home screens must not lose: voice notes, the chat read from its end, a push tap that finds its card, channels; and what is said aloud and moved gently.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkReply, fakeMedia } from './support/phone/m3';
import { momoRuntime } from './support/phone/momo-kit';
import { act, flush, fixtureView, mount, ref, tap, type Any } from './support/phone/momo-screens';

const g = globalThis as Any;
const MOMO_VOICE_METHOD = 'momo.chat.transcribe';
const voiceRuntime = () =>
  momoRuntime({ 'chat.attach': chunkReply, [MOMO_VOICE_METHOD]: () => ({ text: 'call the bank on Friday' }) }).runtime;
const micOf = () =>
  [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Record a voice note') as
    | HTMLButtonElement
    | undefined;

test('a voice note lands in the composer for the person to read, and is sent only by Send', async () => {
  const runtime = voiceRuntime();
  const { media, log } = fakeMedia();
  const m = await mount(undefined, {}, { voice: { runtime, media, listed: true, online: true } });
  assert.ok(micOf());
  await tap('Record a voice note');
  assert.deepEqual(log, ['start']);
  await tap('Stop and transcribe');
  await flush();
  assert.equal(m.drafts.get(), 'call the bank on Friday');
  assert.deepEqual(
    m.sent.filter((i: Any) => i.kind === 'send'),
    [],
  );
});

test('no microphone where the computer does not list the method, and a held one while the computer is away', async () => {
  const { media } = fakeMedia();
  await mount(undefined, {}, { voice: { runtime: voiceRuntime(), media, listed: false, online: true } });
  assert.equal(micOf(), undefined);
  await mount(undefined, {}, { voice: { runtime: voiceRuntime(), media, listed: true, online: false } });
  assert.equal(micOf()?.disabled, true);
  await mount();
  assert.equal(micOf(), undefined, 'no media: no microphone');
});

const events = () => g.__scrollEvents;
const cleared = () => {
  g.__scrolledToEnd = [];
  g.__scrolledTo = [];
};

test('the chat is read from its end on open and after a send, until the person scrolls away', async () => {
  cleared();
  const m = await mount();
  await act(async () => events().onContentSizeChange(0, 0));
  assert.equal(g.__scrolledToEnd.length, 1, 'on open');
  await act(async () => events().onScrollBeginDrag());
  await act(async () => events().onContentSizeChange(0, 0));
  assert.equal(g.__scrolledToEnd.length, 1, 'the person scrolled away: the page stays');
  await act(async () => m.drafts.set('hello'));
  const send = [...document.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Send').at(-1) as HTMLElement;
  await act(async () => send.click());
  await act(async () => events().onContentSizeChange(0, 0));
  assert.equal(g.__scrolledToEnd.length, 2, 'after a send');
  // a page that is not the chat is not scrolled
  await tap('Tasks');
  await act(async () => events().onContentSizeChange(0, 0));
  assert.equal(g.__scrolledToEnd.length, 2);
});

test('a push tap with no card shows the end of the chat; with reduced motion the scroll does not animate', async () => {
  g.__phoneReduceMotion = true;
  try {
    cleared();
    const m = await mount();
    await flush();
    await act(async () => events().onScrollBeginDrag());
    await m.rerender({ focus: { card: null, tap: 1 } });
    await act(async () => events().onContentSizeChange(0, 0));
    assert.deepEqual(g.__scrolledToEnd.at(-1), { animated: false });
  } finally {
    g.__phoneReduceMotion = false;
  }
});

test('a push tap on a card older than the rows drawn draws from it on, and the page scrolls to it', async () => {
  const { chatRef } = await import('../mobile/src/push/chatRef' as string);
  const rows = Array.from({ length: 80 }, (_, i) => ({ kind: 'user', id: `r${i}`, at: i, text: `line ${i}`, delivery: 'completed' }));
  const card = (fixtureView().view.chat as Any[]).find((r) => r.kind === 'approval');
  cleared();
  const m = await mount((v) => v.chat.splice(0, v.chat.length, card, ...rows), {}, { pairId: 'p1' });
  assert.doesNotMatch(m.text(), /Send this email\?/, 'the card is above the last page');
  await m.rerender({ focus: { card: chatRef('p1', 'c1'), tap: 1 } });
  assert.match(m.text(), /Send this email\?/);
  const outlined = [...document.querySelectorAll('div')].find((e) => /"borderWidth":2/.test(e.getAttribute('data-style') ?? '')) as Any;
  assert.ok(outlined);
  await act(async () => outlined.__onLayout({ nativeEvent: { layout: { y: 400 } } }));
  assert.deepEqual(g.__scrolledTo.at(-1), { y: 384, animated: true });
  // a card the chat does not hold changes nothing
  await m.rerender({ focus: { card: 'nothing', tap: 2 } });
  // reduced motion is read when the screen opens: with it on, the scroll to the card does not animate
  g.__phoneReduceMotion = true;
  try {
    const calm = await mount((v) => v.chat.splice(0, v.chat.length, card, ...rows), {}, { pairId: 'p1' });
    await flush();
    await calm.rerender({ focus: { card: chatRef('p1', 'c1'), tap: 1 } });
    const again = [...document.querySelectorAll('div')].find((e) => /"borderWidth":2/.test(e.getAttribute('data-style') ?? '')) as Any;
    await act(async () => again.__onLayout({ nativeEvent: { layout: { y: 10 } } }));
    assert.deepEqual(g.__scrolledTo.at(-1), { y: 0, animated: false });
  } finally {
    g.__phoneReduceMotion = false;
  }
});

test('what finished is said aloud: a move’s step, and Done when what was asked is answered', async () => {
  g.__announced = [];
  const m = await mount((v) => {
    v.home.state = 'moving';
    v.home.move = {
      moveId: 'm',
      from: ref('studio', 'Studio'),
      to: ref('mini', 'Mac mini'),
      step: 'sealed',
      outcome: 'running',
      finishedAt: null,
      failure: null,
      oldMachineOffline: false,
    };
  });
  assert.ok(g.__announced.includes('Sealed'), g.__announced.join('|'));
  g.__announced = [];
  const v = fixtureView();
  v.view.home.state = 'moving';
  v.view.home.move = {
    moveId: 'm',
    from: ref('studio', 'Studio'),
    to: ref('mini', 'Mac mini'),
    step: 'copied',
    outcome: 'running',
    finishedAt: null,
    failure: null,
    oldMachineOffline: false,
  };
  m.transport.emit({ view: v.view });
  await flush();
  assert.ok(g.__announced.includes('Copied'));
  g.__announced = [];
  await mount();
  await tap('Send');
  await flush();
  assert.ok(g.__announced.includes('Done.'));
});
