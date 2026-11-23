// When the pairing sheet is open (mobile/src/usePairingSheet.ts): by itself once on first run, never again for a computer removed later, and closed as a pairing takes over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const sheetPath = '../mobile/src/usePairingSheet';
const { usePairingSheet } = await import(sheetPath);

const signedIn = { user: { id: 'u' }, phase: 'ready', pairs: [], pendingPair: false, pairingCommit: false };
const computer = { pairId: 'p', macId: 'm' };

async function rig(first: any) {
  let open = false;
  let set: (value: boolean) => void = () => {};
  const Probe = ({ state }: any) => {
    [open, set] = usePairingSheet(state);
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const show = (state: any) => act(async () => root.render(createElement(Probe, { state })));
  await show(first);
  return {
    show,
    open: () => open,
    close: () => act(async () => set(false)),
    done: () => act(async () => root.unmount()),
  };
}

test('signed in with no computer, the sheet opens by itself, once; closing it leaves it closed', async () => {
  const r = await rig({ ...signedIn, phase: 'loading', user: null });
  assert.equal(r.open(), false, 'not before the sign-in');
  await r.show({ ...signedIn, phase: 'loading' });
  assert.equal(r.open(), false, 'not while the account loads');
  await r.show(signedIn);
  assert.equal(r.open(), true);
  await r.close();
  await r.show({ ...signedIn, phase: 'offline' });
  await r.show(signedIn);
  assert.equal(r.open(), false, 'its ✕ is not undone');
  await r.done();
});

test('a computer removed later does not start the camera; a new sign-in offers again', async () => {
  const r = await rig({ ...signedIn, pairs: [computer] });
  assert.equal(r.open(), false, 'a phone with a computer stays on its chats');
  await r.show(signedIn);
  assert.equal(r.open(), false, 'removing the last computer opens nothing');
  await r.show({ ...signedIn, phase: 'signedOut', user: null });
  await r.show(signedIn);
  assert.equal(r.open(), true, 'signing in again is a first run');
  await r.done();
});

test('a pairing under way, or a computer added, closes the sheet; one removed does not', async () => {
  const r = await rig(signedIn);
  assert.equal(r.open(), true);
  await r.show({ ...signedIn, pendingPair: true });
  assert.equal(r.open(), false, 'it hands over to the card');
  await r.done();
  const added = await rig(signedIn);
  await added.show({ ...signedIn, pairs: [computer] });
  assert.equal(added.open(), false);
  await added.done();
  const committing = await rig(signedIn);
  await committing.show({ ...signedIn, pairingCommit: true });
  assert.equal(committing.open(), false);
  await committing.done();
});
