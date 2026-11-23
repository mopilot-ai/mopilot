// MoMo inside the phone app: invited accounts get the home entry, the tab survives the Mac going away and closes on sign-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { fakeCache, hello, momoRuntime, snapshotOf } from './support/phone/momo-kit';
const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

const handlers = (allowed: boolean) => ({
  'chats.recent': () => ({ chats: [] }),
  'machine.hello': () => hello(allowed),
  'momo.brain.get': () => ({ brain: { harness: 'claude', model: 'm', modelLabel: 'Sage brain' } }),
  'momo.routines.list': () => ({ proposals: [], routines: [] }),
  'momo.chat.follow': () => snapshotOf(),
  'momo.chat.unfollow': () => ({}),
});
async function mount(m: ReturnType<typeof momoRuntime>, momo?: { cache: Promise<any> }) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: m.runtime, momo })));
  // the list asks the Mac for its machines as well, so MoMo's own answer lands a turn later
  await flush();
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('without the MoMo wiring or for an uninvited account the home screen has no MoMo', async () => {
  const plain = momoRuntime(handlers(true));
  const a = await mount(plain);
  assert.doesNotMatch(a.host.textContent!, /Open MoMo/);
  assert.equal(plain.calls.filter(([m]) => m.startsWith('momo.')).length, 0, 'nothing of MoMo is asked without its wiring');
  await a.done();
  const uninvited = momoRuntime(handlers(false));
  const b = await mount(uninvited, { cache: Promise.resolve(null) });
  assert.doesNotMatch(b.host.textContent!, /MoMo/);
  await b.done();
});

test('an invited account opens MoMo from home, keeps it while the Mac is away, and loses it on sign-out', async () => {
  const m = momoRuntime(handlers(true));
  const view = await mount(m, { cache: Promise.resolve(fakeCache()) });
  await click('MoMo');
  const composer = () => document.querySelector('input[placeholder="Ask MoMo anything"]');
  assert.ok(composer(), 'MoMo is open');
  assert.equal(m.count('momo.chat.follow'), 1);
  m.set({ phase: 'offline', selectedPair: null, generation: 2 });
  await flush();
  assert.match(view.host.textContent!, /Your Mac is asleep or offline/);
  await click('Back');
  assert.equal(composer(), null);
  m.set({ phase: 'signedOut', user: null, generation: 3 });
  await flush();
  assert.equal(composer(), null);
  await view.done();
});

test('the MoMo draft survives leaving and reopening MoMo', async () => {
  const m = momoRuntime({ ...handlers(true), 'momo.chat.send': () => ({}) });
  const view = await mount(m, { cache: Promise.resolve(null) });
  await click('MoMo');
  const field = () => document.querySelector('input[placeholder="Ask MoMo anything"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), 'half typed');
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Back');
  await click('MoMo');
  assert.equal(field().value, 'half typed');
  await click('Send');
  assert.equal(field().value, '');
  await view.done();
});

test('signing out clears the saved memory copy, and works with no MoMo wiring', async () => {
  const cache = fakeCache();
  await cache.save('s', { facts: [{ id: '1', text: 'private' }], docs: null });
  const m = momoRuntime({ ...handlers(true), signOut: undefined as any });
  let signedOut = 0;
  m.runtime.signOut = async () => void signedOut++;
  const view = await mount(m, { cache: Promise.resolve(cache) });
  await click('Settings');
  await click('Sign out');
  await click('Confirm sign out');
  assert.equal(signedOut, 1);
  assert.equal(cache.raw(), null);
  await view.done();

  const none = momoRuntime(handlers(true));
  none.runtime.signOut = async () => void signedOut++;
  const bare = await mount(none);
  await click('Settings');
  await click('Sign out');
  await click('Confirm sign out');
  assert.equal(signedOut, 2);
  await bare.done();

  const unopened = momoRuntime(handlers(true));
  unopened.runtime.signOut = async () => void signedOut++;
  const noStore = await mount(unopened, { cache: Promise.resolve(null) });
  await click('Settings');
  await click('Sign out');
  await click('Confirm sign out');
  assert.equal(signedOut, 3);
  await noStore.done();
});
