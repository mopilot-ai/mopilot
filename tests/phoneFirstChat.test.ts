// After pairing the phone lands on the new-chat page for that computer with the keyboard up (#5320): only for a computer this phone paired, and only until that page is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { fakeMedia, scripted } from './support/phone/m3';
const sheetPath = '../mobile/src/usePairingSheet';
const landingPath = '../mobile/src/useLanding';
const appPath = '../mobile/src/MobileApp';
const { usePairingSheet } = await import(sheetPath);
const { useLanding } = await import(landingPath);
const { MobileApp } = await import(appPath);

const base: any = {
  phase: 'ready',
  generation: 1,
  user: { id: 'u', name: 'Dana' },
  pairs: [],
  presence: {},
  selectedPair: null,
  pendingPair: false,
  reconnect: null,
  outbox: [],
  pairingCommit: false,
  pairCleanup: false,
  safetyNumber: null,
  error: null,
};
const PAIRED = { pairId: 'p1', macId: 'm1', name: 'Studio Mac' };

/** The sheet hook with what it reports, for a test to drive with snapshots. */
function Sheet({ state, told }: { state: any; told: () => void }) {
  const [open, setOpen] = usePairingSheet(state, true, told);
  return createElement('button', { 'data-open': String(open), onClick: () => setOpen(false) }, 'sheet');
}
async function drive(states: any[], dismiss = false) {
  let told = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  for (const [i, state] of states.entries()) {
    await act(async () => root.render(createElement(Sheet, { state, told: () => void told++ })));
    if (dismiss && i === 0) await act(async () => (host.querySelector('button') as HTMLElement).click());
  }
  await act(async () => root.unmount());
  host.remove();
  return told;
}

test('a computer added after this phone paired it is told; one that only appeared in the list is not', async () => {
  const pairing = { ...base, phase: 'pairing', pendingPair: true, safetyNumber: '123599' };
  const done = { ...base, phase: 'online', pairs: [PAIRED], selectedPair: 'p1' };
  assert.equal(await drive([base, pairing, done]), 1, 'the sheet opened by itself, a pairing began, a computer was added');
  assert.equal(await drive([{ ...base, user: null }, done]), 0, 'a list that gained a computer on its own');
  // the sheet opened and was left: a computer added later by another device is not this phone's pairing
  assert.equal(await drive([base, done], true), 1, "left open until the computer came, it is this phone's");
  const second = { ...done, pairs: [PAIRED, { pairId: 'p2', macId: 'm2', name: 'Laptop' }] };
  assert.equal(await drive([done, second]), 0, 'a second computer from nowhere');
  assert.equal(await drive([base, pairing, done, second]), 1, 'told once, not again for the next one');
});

/** The landing hook with what it reports. */
function Landing({ creating, arrive }: { creating: boolean; arrive: { current: () => void } }) {
  const landing = useLanding(creating, () => {});
  arrive.current = landing.arrive;
  return createElement('span', { 'data-focus': String(landing.focus) });
}
test('the keyboard is up for the page a pairing opens, and not once that page is left', async () => {
  const arrive = { current: () => {} };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const focus = () => host.querySelector('span')!.getAttribute('data-focus');
  await act(async () => root.render(createElement(Landing, { creating: false, arrive })));
  assert.equal(focus(), 'false', 'a New chat opened by hand has no keyboard forced up');
  await act(async () => arrive.current());
  await act(async () => root.render(createElement(Landing, { creating: true, arrive })));
  assert.equal(focus(), 'true');
  await act(async () => root.render(createElement(Landing, { creating: false, arrive })));
  await act(async () => root.render(createElement(Landing, { creating: true, arrive })));
  assert.equal(focus(), 'false', 'the next New chat is an ordinary one');
  await act(async () => root.unmount());
  host.remove();
});

test('in the app, a pairing ends on the new-chat page for that computer with the field focused', async () => {
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [] } : undefined), base);
  const listeners = new Set<() => void>();
  const change = async (snap: any) => {
    s.state.snap = snap;
    await act(async () => listeners.forEach((fn) => fn()));
  };
  s.runtime.start = async () => {};
  s.runtime.subscribe = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const field = () => host.querySelector('input[placeholder="Describe a task or ask a question"]');
  try {
    await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, media: fakeMedia().media })));
    await flush();
    assert.match(
      host.textContent!,
      /Look for my computer|Scan the code on your computer/,
      'signed in with no computer, the sheet opens by itself',
    );
    await change({ ...base, phase: 'pairing', pendingPair: true, safetyNumber: '123599' });
    await change({ ...base, phase: 'online', pairs: [PAIRED], selectedPair: 'p1' });
    await flush();
    assert.ok(field(), 'the new-chat page');
    assert.equal(field()!.getAttribute('data-auto-focus'), 'true', 'with the keyboard up');
    await click('Back');
    assert.equal(field(), null);
    await click('New chat');
    assert.equal(field()?.getAttribute('data-auto-focus'), 'false', 'a New chat of its own is ordinary');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
