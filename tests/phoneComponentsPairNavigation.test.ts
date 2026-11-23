// The pairing form is left for the safety-number screen and does not come back when the pairing finishes.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText, openCodeEntry, openScanner } from './support/phone/component-kit';
const phoneModulePath = '../mobile/src/MobileApp';
const { MobileApp } = await import(phoneModulePath);

const base: any = {
  phase: 'ready',
  generation: 1,
  user: { id: 'u' },
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

for (const finish of ['commit', 'immediate']) {
  test(`a finished pairing returns to the home list, not the pairing form (${finish})`, async () => {
    let listener = () => {};
    let state: any = base;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const runtime: any = {
      snapshot: () => state,
      subscribe: (fn: () => void) => {
        listener = fn;
        return () => {};
      },
      start: async () => {},
      request: async () => ({}),
    };
    try {
      await act(async () => root.render(createElement(MobileApp, { runtime })));
      await flush();
      await click('Add a computer');
      await openScanner();
      assert.match(host.textContent!, /Scan the code on your computer/);
      if (finish === 'commit') {
        state = { ...state, phase: 'pairing', pendingPair: true, safetyNumber: '123599' };
        await act(async () => listener());
        await click('Check the number');
        assert.match(host.textContent!, /123\D?599/);
      }
      state = { ...base, pairs: [{ pairId: 'p1', macId: 'm1', name: 'Studio Mac' }] };
      await act(async () => listener());
      await flush();
      assert.doesNotMatch(host.textContent!, /Scan the code on your computer/);
      assert.equal(host.querySelector('[data-stack]')?.getAttribute('data-stack'), 'home', 'back on the home list');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
}

test('a computer removed from the Mac while the form is open does not close it or drop the typed code', async () => {
  let listener = () => {};
  let state: any = { ...base, pairs: [{ pairId: 'p1', macId: 'm1', name: 'Studio Mac' }] };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listener = fn;
      return () => {};
    },
    start: async () => {},
    request: async () => ({}),
  };
  try {
    await act(async () => root.render(createElement(MobileApp, { runtime })));
    await flush();
    // with a Mac paired the sheet opens from Settings › Add a computer
    await click('Settings');
    await click('Add a computer');
    await openScanner();
    await openCodeEntry();
    await inputText('Paste pairing code', 'half-typed-code');
    state = { ...state, pairs: [] };
    await act(async () => listener());
    await flush();
    assert.match(host.textContent!, /Paste the code you copied from MoPilot on your computer/, 'the form is still open');
    const field = host.querySelector('textarea, input') as HTMLTextAreaElement;
    assert.equal(field.value, 'half-typed-code');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

for (const paired of [false, true]) {
  test(`with nothing connected, the phone says "this computer is offline" nowhere, and and says the Mac is offline (one line, no banner) only when one is paired (${paired})`, async () => {
    const state: any = { ...base, phase: 'offline', pairs: paired ? [{ pairId: 'p1', macId: 'm1', name: 'Studio Mac' }] : [] };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const runtime: any = { snapshot: () => state, subscribe: () => () => {}, start: async () => {}, request: async () => ({}) };
    try {
      mock.timers.enable({ apis: ['setTimeout'] });
      await act(async () => root.render(createElement(MobileApp, { runtime })));
      await flush();
      await act(async () => mock.timers.tick(5000));
      await flush();
      assert.equal(/This computer is offline/.test(host.textContent!), false, 'with no computer paired there is no computer to be offline');
      assert.equal(
        /Your computer is offline/.test(host.textContent!),
        paired,
        'one line for a paired Mac that is away, nothing without one',
      );
    } finally {
      mock.timers.reset();
      await act(async () => root.unmount());
      host.remove();
    }
  });
}
