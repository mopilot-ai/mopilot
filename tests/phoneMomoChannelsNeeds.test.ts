// MoMo's Needs you state per chat on the phone (mobile/src/momo/useNeeds.ts): a card waiting in a channel shows only in that channel (no card, count, "Answered on your Mac" or settled line on Main); allowed or denied here it leaves its settled line in the channel; answered on the Mac it says so in the channel only. On the Classic page and in the shell's Chat tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const A = 'ch_000000000000000a';
const B = 'ch_000000000000000b';
const G = 'gr_000000000000000a';
const ch = (id: string, name: string, extra: any = {}) => ({ id, name, group: null, hasInstructions: false, welcome: null, ...extra });
const METHODS = ['momo.state.get', 'momo.prefs.set', 'momo.channels.list', 'momo.channels.create'];

let list: any;
const reset = () => {
  list = { enabled: true, channels: [ch(A, 'Kitchen'), ch(B, 'Garden', { group: G })], groups: [{ id: G, name: 'Home' }], room: 10 };
};
function page(over: Record<string, any> = {}, methods = METHODS) {
  return momoRuntime({
    'machine.hello': () => ({ v: 1, capabilities: { momo: true, momoBrainSet: false, methods, permissionCeiling: 'auto-review' } }),
    'momo.chat.follow': () => snapshotOf(),
    'momo.chat.unfollow': () => ({}),
    'momo.chat.send': () => ({ sent: true }),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0 }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.channels.list': () => list,
    ...over,
  });
}
const calls = (m: any, method: string) => m.calls.filter(([x]: [string]) => x === method).map(([, p]: any) => p);
const openPicker = async () => {
  await click('More');
  await click('Channels');
};

/**
 * MoMo's page with a channel whose card waits, on the Classic page (no shell) and in the shell's Chat tab: what each chat shows while the card
 * waits, after it is allowed or denied here, and after it is answered on the Mac. `after` is what the channel's thread holds once the card is settled.
 */
function waitingCard(shell: boolean) {
  const card = {
    id: 'k1',
    rev: 1,
    title: 'Run this command?',
    choices: [
      { key: 'once', label: 'Allow' },
      { key: 'deny', label: 'Deny' },
    ],
  };
  const world = { settled: null as null | any[] };
  const m = page(
    {
      'momo.chat.follow': ({ channelId }: any) =>
        channelId
          ? world.settled
            ? snapshotOf([], world.settled, 'chat-channel')
            : snapshotOf([card], [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'check the repo' }] }], 'chat-channel')
          : snapshotOf([], [{ id: 'm1', type: 'agentMessage', text: 'Good morning' }], 'main'),
      'momo.card.answer': ({ key }: any) => ({ answered: true, key }),
      'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0, ...(shell ? { shell: true, shellTasks: false } : {}) }),
    },
    METHODS,
  );
  return { m, world };
}
const SHOWS = /Run this command\?/;
const nothingOfIt = (text: string) => assert.doesNotMatch(text, /Run this command\?|Answered on your Mac|need you|check the repo/);

for (const shell of [false, true]) {
  const where = shell ? 'the shell’s Chat tab' : 'the Classic page';
  for (const [button, line] of [
    ['Allow', 'Ran git status --short'],
    ['Deny', 'Understood, I did not run it.'],
  ] as const) {
    test(`${where}: a channel’s card waits only in the channel, and ${button} leaves its settled line there; Main shows nothing of it`, async () => {
      reset();
      const { m, world } = waitingCard(shell);
      const view = await mountMomo(m);
      await flush();
      await openPicker();
      await click('#Kitchen');
      await flush();
      assert.match(view.text(), SHOWS);
      assert.match(view.text(), /1 needs you/);
      assert.doesNotMatch(view.text(), /Answered on your Mac/);
      // Main while the card waits: no card, no count, and not "answered on your Mac" for a card nobody answered
      await openPicker();
      await click('Main');
      await flush();
      nothingOfIt(view.text());
      // back in the channel it is still waiting, still not answered
      await openPicker();
      await click('#Kitchen');
      await flush();
      assert.match(view.text(), SHOWS);
      assert.doesNotMatch(view.text(), /Answered on your Mac/);
      // answered here: the turn goes on in the channel and leaves its lines there
      world.settled = [{ id: 'a1', type: 'agentMessage', text: line }];
      await click(button);
      assert.deepEqual(calls(m, 'momo.card.answer').at(-1)?.channelId, A);
      await act(async () => m.emit({ ev: 'momo.changed', area: 'chat' }));
      await flush();
      await flush();
      assert.match(view.text(), new RegExp(line.replace(/\./g, '\\.')));
      // the card is settled, with the receipt an ordinary chat keeps for it: what was chosen and where (the model's reply is its own words)
      assert.match(view.text(), new RegExp(`Run this command\\? · ${button} · answered on this (iPhone|phone)`));
      assert.doesNotMatch(view.text(), /Run this command\?(?! ·)/);
      assert.doesNotMatch(view.text(), /Answered on your Mac/);
      // and Main still shows nothing of it
      await openPicker();
      await click('Main');
      await flush();
      nothingOfIt(view.text());
      assert.doesNotMatch(view.text(), new RegExp(line.replace(/\./g, '\\.')));
      await view.unmount();
    });
  }

  test(`${where}: a channel’s card answered on the Mac says so in the channel, once it is gone, and never on Main`, async () => {
    reset();
    const { m, world } = waitingCard(shell);
    const view = await mountMomo(m);
    await flush();
    await openPicker();
    await click('#Kitchen');
    await flush();
    assert.match(view.text(), SHOWS);
    // away from the channel, the card is answered on the Mac
    await openPicker();
    await click('Main');
    await flush();
    world.settled = [{ id: 'a1', type: 'agentMessage', text: 'Ran git status --short' }];
    nothingOfIt(view.text());
    await openPicker();
    await click('#Kitchen');
    await flush();
    assert.match(view.text(), /Run this command\? · Answered on your Mac/);
    await openPicker();
    await click('Main');
    await flush();
    nothingOfIt(view.text());
    await view.unmount();
  });
}

test('the status capsule of a paused MoMo resumes it', async () => {
  reset();
  const m = page({
    'momo.state.get': () => ({ name: 'Mo', status: 'paused', needsYou: 0 }),
    'momo.prefs.set': ({ paused }: any) => ({ paused }),
  });
  const view = await mountMomo(m);
  await flush();
  await click('Paused · Tap to resume');
  await flush();
  assert.deepEqual(calls(m, 'momo.prefs.set').at(-1), { paused: false });
  await view.unmount();
});

test('a card answered here on Main leaves the same receipt as in a channel, for Deny as for Allow, and a refused answer leaves none', async () => {
  reset();
  const card = {
    id: 'k9',
    rev: 1,
    title: 'Send the email?',
    choices: [
      { key: 'once', label: 'Allow' },
      { key: 'deny', label: 'Deny', deny: true },
    ],
  };
  let refuse = true;
  const m = page({
    'momo.chat.follow': () => snapshotOf([card], [{ id: 'm1', type: 'agentMessage', text: 'Good morning' }], 'main'),
    'momo.card.answer': () => (refuse ? Promise.reject(new Error('The Mac could not take that.')) : { answered: true }),
  });
  const view = await mountMomo(m);
  await flush();
  await click('Deny');
  await flush();
  assert.doesNotMatch(view.text(), /answered on this/);
  refuse = false;
  await click('Deny');
  await flush();
  assert.match(view.text(), /Send the email\? · Deny · answered on this (iPhone|phone)/);
  await view.unmount();
});

// The prop is optional in the component, and tests load it through a path variable (typed any), so only a render without it can show it is safe.
test('the transcript draws without answeredHere (none answered here) and with it (their receipts)', async () => {
  const chatPath = '../mobile/src/screens/MomoChat';
  const { MomoTranscript } = await import(chatPath);
  const props = {
    rows: [{ kind: 'message', key: 'k0', row: { role: 'assistant', text: 'Done.', key: 'k0' } }],
    queued: null,
    cards: [],
    answeredOnMac: [],
    answer: async () => true,
    act: () => {},
    canAct: true,
    closed: {},
    working: false,
    progress: '',
    empty: null,
    cardRef: () => {},
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MomoTranscript, props)));
  assert.match(host.textContent ?? '', /Done\./);
  assert.doesNotMatch(host.textContent ?? '', /answered on/);
  const card = { id: 'k1', rev: 1, title: 'Run this command?', choices: [] };
  await act(async () => root.render(createElement(MomoTranscript, { ...props, answeredHere: [{ card, choice: 'Deny' }] })));
  assert.match(host.textContent ?? '', /Run this command\? · Deny · answered on this (iPhone|phone)/);
  await act(async () => root.unmount());
});
