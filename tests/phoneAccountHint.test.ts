// The account hint in a computer's pairing code: the hash both sides write, a hint that is not well formed counts as none, and a computer on another account is told at the scan, with the fix on the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
const hintPath = '../mobile/src/accountHint';
const pairingPath = '../mobile/src/screens/Pairing';
const { accountHint, hintOf, otherAccount } = await import(hintPath);
const { Pairing } = await import(pairingPath);

const g = globalThis as any;
const code = (extra: object = {}) =>
  JSON.stringify({ v: 3, macId: 'mac-1', relay: 'wss://relay.example', code: 'AAAA', exp: 4102444800000, ...extra });
const MINE = accountHint('user-1');

test('the hint is the first 8 bytes of sha256("mopilot-acct-v1:" + the user id), as lowercase hex', () => {
  const expected = createHash('sha256').update('mopilot-acct-v1:user-1').digest('hex').slice(0, 16);
  assert.equal(MINE, expected);
  assert.match(MINE, /^[0-9a-f]{16}$/);
  assert.notEqual(accountHint('user-2'), MINE);
});

test('a hint that is missing or not well formed counts as none; the mask is plain, short and shown trimmed', () => {
  assert.deepEqual(hintOf(code({ acct: MINE, who: ' j***@x.com ' })), { acct: MINE, who: 'j***@x.com' });
  assert.deepEqual(hintOf(code({ acct: MINE })), { acct: MINE, who: null });
  assert.deepEqual(hintOf(code({ acct: MINE, who: 'a\u0007b' })), { acct: MINE, who: null }, 'a control character');
  assert.deepEqual(hintOf(code({ acct: MINE, who: 'x'.repeat(81) })), { acct: MINE, who: null }, 'too long to be a mask');
  assert.deepEqual(hintOf(code({ acct: MINE, who: '   ' })), { acct: MINE, who: null });
  assert.deepEqual(hintOf(code({ acct: MINE, who: 5 })), { acct: MINE, who: null });
  for (const acct of [undefined, 5, MINE.toUpperCase(), MINE.slice(1), `${MINE}0`, 'zzzzzzzzzzzzzzzz'])
    assert.equal(hintOf(code({ acct })), null);
  assert.equal(hintOf('not json'), null);
  assert.equal(hintOf('null'), null);
  assert.equal(hintOf('7'), null);
});

test("only a hint naming another account than the phone's is a mismatch", () => {
  assert.equal(otherAccount(code({ acct: MINE }), 'user-1'), null, 'the same account');
  assert.deepEqual(otherAccount(code({ acct: accountHint('user-2'), who: 'b***@y.com' }), 'user-1'), {
    acct: accountHint('user-2'),
    who: 'b***@y.com',
  });
  assert.equal(otherAccount(code(), 'user-1'), null, 'an older computer sends no hint');
  assert.equal(otherAccount(code({ acct: accountHint('user-2') }), null), null, 'a phone that is not signed in has nothing to compare');
  assert.equal(otherAccount(code({ acct: accountHint('user-2') }), undefined), null);
});

async function mount(pair: (...args: any[]) => Promise<void>, props: object = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Pairing, { runtime: { pair }, back: () => {}, ...props })));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const reset = () => {
  g.__phoneCamera = async () => ({ granted: true, canAskAgain: true, status: 'granted' });
  g.__phoneCameraMount = undefined;
  g.__clipboardImage = undefined;
  g.__setPasteButton(true);
};
const OTHER = code({ acct: accountHint('user-2'), who: 'b***@y.com' });

test('a code of another account is told at the scan: nothing is paired, and signing out to use that account is one tap', async () => {
  reset();
  const sent: any[] = [];
  let signedOut = 0;
  const view = await mount(async (...args) => void sent.push(args), {
    account: 'ann@example.com',
    userId: 'user-1',
    signOut: () => void signedOut++,
  });
  g.__clipboardText = OTHER;
  await click('Paste');
  assert.match(view.host.textContent!, /This computer uses b\*\*\*@y\.com\. You're signed in as ann@example\.com\./);
  assert.deepEqual(sent, [], 'no pairing attempt, so no code is spent');
  await click('Sign out and use b***@y.com');
  assert.equal(signedOut, 1);
  await view.unmount();
});

test('Scan another code goes back to the camera, and a code of the same account pairs', async () => {
  reset();
  const sent: any[] = [];
  const view = await mount(async (...args) => void sent.push(args), { userId: 'user-1', signOut: () => {} });
  g.__clipboardText = OTHER;
  await click('Paste');
  assert.doesNotMatch(view.host.textContent!, /signed in as/, 'no account is named when the phone does not know it');
  await click('Scan another code');
  assert.match(view.host.textContent!, /Camera preview/);
  g.__clipboardText = code({ acct: MINE, who: 'a***@x.com' });
  await click('Paste');
  assert.equal(sent.length, 1, 'the same account pairs as before');
  await view.unmount();
});

test('a hint with no mask names no address; with no way to sign out the card offers only another scan', async () => {
  reset();
  const view = await mount(async () => {}, { account: 'ann@example.com', userId: 'user-1' });
  g.__clipboardText = code({ acct: accountHint('user-2') });
  await click('Paste');
  assert.match(view.host.textContent!, /This computer uses a different MoPilot account\. You're signed in as ann@example\.com\./);
  assert.equal(document.querySelector('button[aria-label^="Sign out"]'), null);
  assert.ok(document.querySelector('button[aria-label="Scan another code"]'));
  await view.unmount();
  // with a way to sign out the button says which account to use, or any other when no mask came
  const withSignOut = await mount(async () => {}, { userId: 'user-1', signOut: () => {} });
  await click('Paste');
  assert.ok(document.querySelector('button[aria-label="Sign out and use another account"]'));
  await withSignOut.unmount();
});

test('a computer that sends no hint is refused late by the relay, and the same fix is offered in place', async () => {
  reset();
  let fail!: (e: Error) => void;
  let signedOut = 0;
  const view = await mount(() => new Promise<void>((_, reject) => (fail = reject)), {
    account: 'ann@example.com',
    userId: 'user-1',
    signOut: () => void signedOut++,
  });
  g.__clipboardText = code();
  await click('Paste');
  assert.equal(document.querySelector('button[aria-label="Sign out and use another account"]'), null, 'not before the refusal');
  await act(async () => fail(new Error('relay: forbidden')));
  assert.match(view.host.textContent!, /This computer uses a different MoPilot account\. You're signed in as ann@example\.com\./);
  await click('Sign out and use another account');
  assert.equal(signedOut, 1);
  await view.unmount();
});
