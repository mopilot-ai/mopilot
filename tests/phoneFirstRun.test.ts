// The first minute: the welcome screen, the pairing cards (safety number, finishing, unfinished) and the development host tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, click } from './support/phone/component-kit';

const welcomePath = '../mobile/src/screens/Welcome';
const cardsPath = '../mobile/src/components/PairingCards';
const tagPath = '../mobile/src/components/DevHostTag';
const { Welcome } = await import(welcomePath);
const { PairingCards } = await import(cardsPath);
const { DevHostTag } = await import(tagPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('the welcome screen says what the app is, lists the steps, has one Sign in button and says it is step 1 of 3', async () => {
  let signIns = 0;
  const v = await mount(createElement(Welcome, { busy: false, signIn: () => signIns++ }));
  assert.match(v.host.textContent!, /MoPilot/);
  assert.match(v.host.textContent!, /Your chats, connected to your computer\./);
  // as short as Claude's and Cursor's: no steps to read before the one button
  assert.doesNotMatch(v.host.textContent!, /Step 1 of 3|1\. Sign in/);
  await click('Sign in');
  assert.equal(signIns, 1);
  await v.done();
  const busy = await mount(createElement(Welcome, { busy: true, signIn: () => signIns++ }));
  const button = [...busy.host.querySelectorAll('button')].find((b) => b.textContent === 'Opening sign in…') as HTMLButtonElement;
  assert.equal(button.disabled, true);
  await busy.done();
});

const base = { pairs: [], presence: {}, outbox: [], safetyNumber: null, pendingPair: false, pairCleanup: false, pairingCommit: false };

test('a pairing under way waits for the Connect on the Mac, with the safety number beside it and a way to cancel', async () => {
  const calls: string[] = [];
  const v = await mount(
    createElement(PairingCards, {
      state: { ...base, pendingPair: true, safetyNumber: '123599' },
      busy: false,
      cancel: () => calls.push('cancel'),
    }),
  );
  assert.match(v.host.textContent!, /Confirm on your computer/);
  assert.doesNotMatch(v.host.textContent!, /123 599/, 'the number is a tap away, not on the card');
  assert.match(v.host.textContent!, /Click Connect in MoPilot on your computer\./);
  await click('Check the number');
  assert.match(v.host.textContent!, /123 599/);
  assert.ok(v.host.querySelector('[aria-label^="Safety number"]'), 'read digit by digit');
  assert.match(v.host.textContent!, /If it doesn't, decline there\./);
  await click('Check the number');
  assert.doesNotMatch(v.host.textContent!, /123 599/, 'and closes again');
  assert.equal(v.host.querySelector('[role="alert"]'), null, 'comparing is not a step: no warning');
  await click('Cancel pairing');
  assert.deepEqual(calls, ['cancel']);
  await v.done();

  const waiting = await mount(createElement(PairingCards, { state: { ...base, pendingPair: true }, busy: false, cancel: () => {} }));
  assert.match(waiting.host.textContent!, /Click Connect in MoPilot on your computer\./);
  await waiting.done();
});

test('a pairing that is finishing, one left unfinished, and none show what they should', async () => {
  const finishing = await mount(
    createElement(PairingCards, { state: { ...base, pendingPair: true, pairingCommit: true }, busy: false, cancel: () => {} }),
  );
  assert.match(finishing.host.textContent!, /Finishing pairing/);
  await finishing.done();

  const calls: string[] = [];
  const left = await mount(
    createElement(PairingCards, {
      state: { ...base, pendingPair: true, pairCleanup: true },
      busy: false,
      cancel: () => calls.push('remove'),
    }),
  );
  assert.match(left.host.textContent!, /Unfinished pairing/);
  await click('Remove unfinished pairing');
  assert.deepEqual(calls, ['remove']);
  await left.done();

  const none = await mount(createElement(PairingCards, { state: base, busy: false, cancel: () => {} }));
  assert.equal(none.host.textContent, '');
  await none.done();
});

test('a development build tags its host', async () => {
  const v = await mount(createElement(DevHostTag, { host: '192.168.1.5:8787' }));
  assert.equal(v.host.textContent, 'Dev host: 192.168.1.5:8787');
  await v.done();
});
