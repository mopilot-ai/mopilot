// A tap on a push for a card waiting in a MoMo channel, and Review on a Tasks row of one (A2, #4846; mobile/src/push/route.ts, controller.ts, screens/Momo.tsx): the push names the channel by chatRef of its id, which the phone recomputes from the list it keeps; the page then shows that channel and scrolls to the card. A card of Main opens Main, from any channel. Tasks rows of a channel's card name the channel; Review opens it; a missing or failing list never loses the tap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';
import { controllerRig, tick } from './support/phone/push-controller-rig';

const routePath = '../mobile/src/push/route';
const refPath = '../mobile/src/push/chatRef';
const { locateTarget } = await import(routePath);
const { chatRef } = await import(refPath);

const A = 'ch_000000000000000a';
const B = 'ch_000000000000000b';
const ch = (id: string, name: string) => ({ id, name, group: null, hasInstructions: false, welcome: null });
const card = (id: string, title: string) => ({ id, rev: 1, title, choices: [{ key: 'ok', label: 'OK' }] });
const MAIN_CARD = card('m1', 'Send the invoice?');
const KITCHEN_CARD = card('k1', 'Order the oven?');
const TRIP_CARD = card('t1', 'Book the hotel?');

const loc = (over: Record<string, unknown> = {}) => ({
  pairs: ['p1', 'p2'],
  chatIds: async () => [] as string[],
  channelIds: async (pair: string) => (pair === 'p2' ? [A, B] : []),
  current: () => true,
  ...over,
});

test('a channel’s push resolves to its channel on the computer that lists it, with its card; main’s push and a failing list are as before', async () => {
  const push = (ref: string, card?: string) => ({ kind: 'momoNeedsYou', ref, count: 1, ...(card ? { card } : {}) });
  assert.deepEqual(await locateTarget(push(chatRef('p2', B), 'c'), loc()), { pairId: 'p2', momo: { card: 'c', channel: B } });
  assert.deepEqual(await locateTarget(push(chatRef('p2', A)), loc()), { pairId: 'p2', momo: { channel: A } });
  // a handle no channel matches is Main's push, on the first computer, as before
  assert.deepEqual(await locateTarget(push('nowhere', 'c'), loc()), { pairId: 'p1', momo: { card: 'c' } });
  // a computer that cannot list its channels is skipped, and an older caller with no channel lookup opens Main
  const failing = loc({
    channelIds: async (pair: string) => {
      if (pair === 'p1') throw new Error('offline');
      return [A];
    },
  });
  assert.deepEqual(await locateTarget(push(chatRef('p2', A)), failing), { pairId: 'p2', momo: { channel: A } });
  assert.deepEqual(await locateTarget(push(chatRef('p2', A)), loc({ channelIds: undefined })), { pairId: 'p1', momo: {} });
  // a tap replaced while the list was read opens nothing, and another kind never looks at channels
  assert.equal(await locateTarget(push(chatRef('p2', A)), loc({ current: () => false })), null);
  let looked = false;
  const spy = loc({ channelIds: async () => ((looked = true), [A]) });
  assert.deepEqual(await locateTarget({ kind: 'needsYou', ref: chatRef('p1', 'a'), count: 1 }, { ...spy, chatIds: async () => ['a'] }), {
    pairId: 'p1',
    chatId: 'a',
  });
  assert.equal(looked, false);
});

function rig(shell: boolean, o: { classic?: boolean } = {}) {
  return momoRuntime({
    'machine.hello': () => ({
      v: 1,
      capabilities: {
        momo: true,
        momoBrainSet: false,
        methods: ['momo.state.get', 'momo.channels.list', 'momo.tasks.list', ...(o.classic ? [] : ['momo.tasks.mark'])],
        permissionCeiling: 'auto-review',
      },
    }),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 3, ...(shell ? { shell: true, shellTasks: true } : {}) }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.channels.list': () => ({ enabled: true, channels: [ch(A, 'Kitchen'), ch(B, 'Trip')], groups: [], room: 10 }),
    'momo.chat.follow': ({ channelId }: any) =>
      channelId === A
        ? snapshotOf([KITCHEN_CARD], [], 'chat-a')
        : channelId === B
          ? snapshotOf([TRIP_CARD], [], 'chat-b')
          : snapshotOf([MAIN_CARD], [], 'main'),
    'momo.chat.unfollow': () => ({}),
    'momo.tasks.list': () => ({
      ...(o.classic ? {} : { v: 2 }),
      now: 1_700_000_000_000,
      paused: false,
      tasks: [
        {
          id: 'card:m1',
          kind: 'card',
          tab: 'active',
          state: 'needs-you',
          title: 'Send the invoice?',
          detail: null,
          ref: 'm1',
          channel: null,
        },
        {
          id: `card:${A}:k1`,
          kind: 'card',
          tab: 'active',
          state: 'needs-you',
          title: 'Order the oven?',
          detail: 'Mail',
          ref: 'k1',
          channel: { id: A, name: 'Kitchen' },
        },
      ],
    }),
  });
}

for (const shell of [false, true]) {
  const where = shell ? 'the shell' : 'the Classic page';

  test(`${where}: a tapped push for a channel’s card shows that channel with its card; one for Main’s card shows Main`, async () => {
    const m = rig(shell);
    const view = await mountMomo(m);
    await flush();
    assert.match(view.text(), /Send the invoice\?/);
    assert.doesNotMatch(view.text(), /Order the oven\?/);
    // the tap names the channel and the card (the channel's, not Main's)
    await view.setProps({ focus: { card: chatRef('p', 'k1'), channel: A, tap: 1 } });
    await flush();
    await flush();
    assert.match(view.text(), /Order the oven\?/);
    assert.doesNotMatch(view.text(), /Send the invoice\?/);
    assert.deepEqual(m.calls.filter(([x]: [string, any]) => x === 'momo.chat.follow').at(-1)?.[1].channelId, A);
    // a second tap, for Main's card, brings Main back
    await view.setProps({ focus: { card: chatRef('p', 'm1'), channel: null, tap: 2 } });
    await flush();
    await flush();
    assert.match(view.text(), /Send the invoice\?/);
    assert.doesNotMatch(view.text(), /Order the oven\?/);
    await view.unmount();
  });
}

test('the shell’s Tasks lists a channel’s card naming its channel; Review opens that channel on the card, and Main’s card brings Main back', async () => {
  const m = rig(true);
  const view = await mountMomo(m);
  await flush();
  await click('Tasks');
  await flush();
  await flush();
  assert.match(view.text(), /Order the oven\?/);
  assert.match(view.text(), /#Kitchen · Mail/);
  assert.doesNotMatch(view.text(), /#Kitchen · Send/);
  // Review on the channel's row: the Chat tab shows #Kitchen with its card
  await click('Order the oven?');
  await flush();
  await flush();
  assert.match(view.text(), /‹#Kitchen/);
  assert.match(view.text(), /Order the oven\?/);
  // and Review on Main's row from there shows Main
  await click('Tasks');
  await flush();
  await click('Send the invoice?');
  await flush();
  await flush();
  assert.doesNotMatch(view.text(), /#Kitchen/);
  assert.match(view.text(), /Send the invoice\?/);
  // a push's tap older than that Review does not take the page away from it; a newer one does
  await click('Tasks');
  await flush();
  await click('Order the oven?');
  await flush();
  await view.setProps({ focus: { card: chatRef('p', 'm1'), channel: null, tap: 1 } });
  await flush();
  assert.match(view.text(), /‹#Kitchen/);
  await view.setProps({ focus: { card: chatRef('p', 'm1'), channel: null, tap: Date.now() + 1_000_000 } });
  await flush();
  await flush();
  assert.doesNotMatch(view.text(), /#Kitchen/);
  await view.unmount();
});

test('the classic Tasks list (an older Mac with no marks) names a channel’s card and its row opens that channel', async () => {
  const m = rig(false, { classic: true });
  const view = await mountMomo(m);
  await flush();
  await click('Mo, MoMo’s page');
  assert.match(view.text(), /Order the oven\?#Kitchen · Mail/);
  assert.match(view.text(), /Send the invoice\?/);
  await click('Order the oven?, Review');
  await flush();
  await flush();
  assert.match(view.text(), /‹#Kitchen/);
  await view.unmount();
});

test('Review with no computer to name a handle for still shows the chat it names', async () => {
  const hookPath = '../mobile/src/screens/useReviewFocus';
  const { useReviewFocus } = await import(hookPath);
  const seen: any[] = [];
  const { createElement, createRoot, act } = await import('./support/phone/component-kit');
  function Probe() {
    const r = useReviewFocus({ focus: null, channelId: null, setChannelId: (id: string | null) => seen.push(id), pairId: null });
    seen.push(r.aimedAt);
    if (!r.aimedAt) r.reviewCard({ ref: 'k1', channel: { id: A } });
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  assert.deepEqual(
    seen.filter((x) => x && typeof x === 'object').map((x) => [x.card, x.channel]),
    [[null, A]],
  );
  assert.ok(seen.includes(A));
  await act(async () => root.unmount());
});

test('the Classic page’s Tasks (MoMo’s page) names a channel’s card and its Review closes the page on that channel’s chat', async () => {
  const m = rig(false);
  const view = await mountMomo(m);
  await flush();
  await click('Mo, MoMo’s page');
  assert.match(view.text(), /Order the oven\?#Kitchen · Mail/);
  await click('Order the oven?, Review');
  await flush();
  await flush();
  assert.match(view.text(), /‹#Kitchen/);
  assert.match(view.text(), /Order the oven\?/);
  assert.doesNotMatch(view.text(), /Send the invoice\?/);
  await view.unmount();
});

test('the push controller reads the channels of the computer a tap is for: its channel is the target, and a Mac with channels off or no list leaves Main', async () => {
  const tap = async (reply: unknown) => {
    const r = controllerRig({ pairs: ['p_a'] });
    await r.ctl.start();
    r.reply.use = true;
    r.reply.value = reply;
    r.handlers.tap({ kind: 'momoNeedsYou', ref: chatRef('p_a', A), count: 1, card: 'h' });
    for (let i = 0; i < 4; i++) await tick();
    return r.ctl.ui().target;
  };
  assert.deepEqual(await tap({ enabled: true, channels: [{ id: B }, { id: A }, { name: 'no id' }] }), {
    pairId: 'p_a',
    momo: { card: 'h', channel: A },
  });
  // channels off at the Mac, a reply with no channels, or none of them this one: Main, as before
  assert.deepEqual(await tap({ enabled: false, channels: [{ id: A }] }), { pairId: 'p_a', momo: { card: 'h' } });
  assert.deepEqual(await tap({ enabled: true }), { pairId: 'p_a', momo: { card: 'h' } });
  assert.deepEqual(await tap(null), { pairId: 'p_a', momo: { card: 'h' } });
});

test('a tap replaced while the computer is being reached does not read its channels or route', async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  await r.ctl.start();
  let open!: () => void;
  r.gates.p_a = new Promise<void>((resolve) => (open = resolve));
  r.reply.use = true;
  r.reply.value = { enabled: true, channels: [{ id: A }] };
  r.handlers.tap({ kind: 'momoNeedsYou', ref: chatRef('p_a', A), count: 1 });
  await tick();
  // a newer tap (a push that names nothing it can find) replaces it before the computer answers
  r.handlers.tap({ kind: 'done', ref: 'no-such-ref', count: 1 });
  open();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(r.ctl.ui().target, null);
  assert.equal(r.calls.filter((c) => c.startsWith('momo.channels.list')).length, 0, 'the replaced tap never read the list');
});
