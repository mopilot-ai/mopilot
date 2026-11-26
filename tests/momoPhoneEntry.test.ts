// The door to MoMo: the home screens for a computer that serves them, the classic screen for a channel and for everyone else, quiet bars and a Back while the computer is asked, the last answer while it is asked again, and no question for a home that did not change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { fakeDraft } from './support/phone/drafts';
import { fakeMedia } from './support/phone/m3';
import { fixtureView } from './support/phone/momo-screens';

const entryPath = '../mobile/src/screens/momoPhone/MomoEntry';
const { MomoEntry } = await import(entryPath);

type Any = any;
const micOf = () => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Record a voice note');
const allowed = { capabilities: { momo: true, momoHome: true } };

function rig(hello: () => Promise<unknown> | unknown, pair = 'p') {
  const calls: string[] = [];
  const listeners: Any[] = [];
  const snap = { phase: 'online', outbox: [], generation: 1, user: { id: 'u' }, pairs: [], selectedPair: pair };
  const runtime: Any = {
    snapshot: () => snap,
    subscribe: () => () => undefined,
    onEvent: (l: Any) => (listeners.push(l), () => undefined),
    request: async (method: string) => {
      calls.push(method);
      if (method === 'machine.hello') return hello();
      if (method === 'momo.home.view') return { view: fixtureView().view };
      throw new Error(`no ${method}`);
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const back: string[] = [];
  const props = (extra: Any = {}) => ({
    runtime,
    state: snap,
    cache: Promise.resolve(null),
    back: () => back.push('back'),
    focus: null,
    media: undefined,
    computers: undefined,
    drafts: fakeDraft(),
    ...extra,
  });
  return {
    calls,
    listeners,
    snap,
    back,
    host,
    show: async (extra: Any = {}) => {
      await act(async () => root.render(createElement(MomoEntry, props(extra))));
      await flush();
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
    text: () => host.textContent ?? '',
  };
}

test('a push tap on a channel opens the classic screen, which holds the channels', async () => {
  const r = rig(() => allowed);
  await r.show({ focus: { card: null, channel: 'c1', tap: 1 } });
  assert.equal(r.calls.includes('momo.home.view'), false, 'the home screens are not asked for');
  assert.doesNotMatch(r.text(), /MoMo · Studio/);
  await r.show({ focus: { card: 'x', channel: null, tap: 2 } });
  await flush();
  assert.match(r.text(), /MoMo · Studio/, 'a card of the main chat opens the home screens');
  await r.close();
});

test('until the computer has said there is a Back and quiet bars, not a blank page; the next opening shows the last answer at once', async () => {
  let answer: (v: unknown) => void = () => undefined;
  const r = rig(() => new Promise((resolve) => (answer = resolve)), 'pairOne');
  await r.show();
  assert.ok(document.querySelector('[aria-label="Loading"]'), 'quiet bars');
  const backButton = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Back') as HTMLElement;
  assert.ok(backButton);
  await act(async () => backButton.click());
  assert.deepEqual(r.back, ['back']);
  answer(allowed);
  await flush();
  await flush();
  assert.match(r.text(), /MoMo · Studio/);
  await r.close();
  // opened again: the screen it showed is there while the computer is asked again
  const again = rig(() => new Promise(() => undefined), 'pairOne');
  await again.show();
  assert.equal(document.querySelector('[aria-label="Loading"]'), null);
  assert.match(again.text(), /MoMo · Studio/);
  await again.close();
});

test('a home that did not change is not asked about again; another home is', async () => {
  const r = rig(() => allowed, 'pairTwo');
  await r.show();
  const asked = () => r.calls.filter((c) => c === 'machine.hello').length;
  assert.equal(asked(), 1);
  const event = (id: string | undefined) => ({
    ev: 'momo.home.changed',
    view: id === undefined ? undefined : { home: { homeMachineId: id } },
  });
  const push = async (e: Any) => {
    await act(async () => r.listeners.forEach((l) => l(e)));
    await flush();
  };
  await push(event('studio'));
  assert.equal(asked(), 2, 'the first word of a home is asked');
  await push(event('studio'));
  await push(event('studio'));
  assert.equal(asked(), 2, 'the same home again is not');
  await push(event('mini'));
  assert.equal(asked(), 3, 'another home is');
  await push(event(undefined));
  assert.equal(asked(), 4, 'a change that names no home is');
  await push({ ev: 'something.else' });
  assert.equal(asked(), 4);
  await r.close();
});

test('with a microphone and a computer that lists the voice method the home screens offer a voice note; without the method they do not', async () => {
  const { media } = fakeMedia();
  const withVoice = rig(() => ({ capabilities: { momo: true, momoHome: true, methods: ['momo.chat.transcribe'] } }), 'pairVoice');
  await withVoice.show({ media });
  await flush();
  assert.ok(micOf(), 'a voice note is offered');
  await withVoice.close();
  const without = rig(() => allowed, 'pairNoVoice');
  await without.show({ media });
  await flush();
  assert.equal(micOf(), undefined);
  await without.close();
});
