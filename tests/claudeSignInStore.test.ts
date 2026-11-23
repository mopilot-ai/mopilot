// The renderer's view of the built-in browser's claude.ai sign-in (src/store/claudeSignIn.ts): main's snapshot and
// pushes, where the higher seq wins whichever arrives first, and malformed answers are dropped.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, listeners, callsOf, resetAll } from './support/store-harness.ts';

const { store } = await loadStore();
const { startClaudeSignIn, takeClaudeSite, claudeSiteOf } = await import('../src/store/claudeSignIn.ts');
const site = () => store.useStore.getState().claudeSite;
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  resetAll();
  store.useStore.setState({ claudeSite: { signedIn: null, seq: 0 } });
});

test('claudeSiteOf keeps a boolean or null answer with a finite seq, and nothing else', () => {
  assert.deepEqual(claudeSiteOf({ signedIn: true, seq: 3 }), { signedIn: true, seq: 3 });
  assert.deepEqual(claudeSiteOf({ signedIn: false, seq: 1 }), { signedIn: false, seq: 1 });
  assert.deepEqual(claudeSiteOf({ signedIn: null, seq: 0 }), { signedIn: null, seq: 0 });
  for (const bad of [
    null,
    undefined,
    {},
    { signedIn: 'yes', seq: 1 },
    { signedIn: true },
    { signedIn: true, seq: '2' },
    { signedIn: true, seq: NaN },
  ])
    assert.equal(claudeSiteOf(bad), null, JSON.stringify(bad));
});

test('the store starts unknown; a snapshot older than a push never overwrites it', async () => {
  assert.deepEqual(site(), { signedIn: null, seq: 0 });
  let answer!: (v: any) => void;
  impl['browser.claudeSignIn'] = () => new Promise((r) => (answer = r));
  startClaudeSignIn();
  assert.equal(callsOf('browser.claudeSignIn').length, 1);
  // the push lands while the snapshot is out
  listeners['browser.onClaudeSignIn']({ signedIn: false, seq: 2 });
  assert.deepEqual(site(), { signedIn: false, seq: 2 });
  answer({ signedIn: true, seq: 1 });
  await flush();
  assert.deepEqual(site(), { signedIn: false, seq: 2 }, 'the older snapshot lost');
  // a newer push wins; an equal or older one, or a malformed one, changes nothing
  listeners['browser.onClaudeSignIn']({ signedIn: true, seq: 3 });
  const before = store.useStore.getState();
  listeners['browser.onClaudeSignIn']({ signedIn: false, seq: 3 });
  listeners['browser.onClaudeSignIn']({ signedIn: false, seq: 1 });
  listeners['browser.onClaudeSignIn']({ nope: true });
  assert.equal(store.useStore.getState(), before, 'no state change at all');
  assert.deepEqual(site(), { signedIn: true, seq: 3 });
});

test('a snapshot newer than the store is taken; a failed snapshot leaves it to the pushes', async () => {
  impl['browser.claudeSignIn'] = () => Promise.resolve({ signedIn: true, seq: 4 });
  startClaudeSignIn();
  await flush();
  assert.deepEqual(site(), { signedIn: true, seq: 4 });
  store.useStore.setState({ claudeSite: { signedIn: null, seq: 0 } });
  impl['browser.claudeSignIn'] = () => Promise.reject(new Error('main went away'));
  startClaudeSignIn();
  await flush();
  assert.deepEqual(site(), { signedIn: null, seq: 0 });
  takeClaudeSite({ signedIn: false, seq: 1 });
  assert.deepEqual(site(), { signedIn: false, seq: 1 });
});
