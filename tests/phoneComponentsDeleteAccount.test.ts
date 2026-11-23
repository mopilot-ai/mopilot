// Settings › Account › Delete account: the card says what goes, asks for the account's email, shows progress and the reason when it fails, and signs the phone out after the account is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText, openAccount } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
// the phone's React Native sources are imported through variables, as the other component tests do, so the Node type check does not read them
const appPath = '../mobile/src/MobileApp';
const deletePath = '../mobile/src/components/DeleteAccount';
const { MobileApp } = await import(appPath);
const { deleteErrorText } = await import(deletePath);

const online = (user: any) => ({
  phase: 'online',
  generation: 1,
  user,
  pairs: [{ pairId: 'p1', macId: 'm1', name: 'Studio Mac' }],
  selectedPair: 'p1',
  safetyNumber: null,
  pendingPair: false,
  error: null,
});
const mounted: any[] = [];
async function mount(
  user: any,
  deleteAccount: (confirm: string) => Promise<void>,
  withPush = false,
  momoCache?: Promise<{ clear(): Promise<void> } | null>,
) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [] } : undefined), online(user));
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  s.runtime.start = async () => {};
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  s.runtime.signOut = async () => {
    calls.push('signOut');
    s.state.snap = { ...s.state.snap, user: null, phase: 'signedOut', pairs: [] };
    listeners.forEach((f) => f());
  };
  s.runtime.deleteAccount = async (confirm: string) => {
    calls.push(`delete:${confirm}`);
    await deleteAccount(confirm);
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const push: any = {
    ui: () => ({ step: 'unknown', target: null, busy: false, notice: null, prefs: {} }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {},
    setOpenChat: () => {},
    // the phone's push registration goes through the same sign-out the Sign out button runs
    signOut: async () => {
      calls.push('push.signOut');
      await s.runtime.signOut();
    },
  };
  await act(async () =>
    root.render(
      createElement(MobileApp, { runtime: s.runtime, ...(withPush ? { push } : {}), ...(momoCache ? { momo: { cache: momoCache } } : {}) }),
    ),
  );
  await flush();
  await click('Settings');
  await openAccount();
  return { host, calls, s };
}
const deleteButton = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Delete account') as HTMLButtonElement | undefined;

test('the card says what is deleted, keeps Delete off until the email matches, then deletes and signs out', async () => {
  const { host, calls } = await mount({ id: 'u', name: 'Dana', email: 'Dana@Example.com' }, async () => undefined);
  assert.doesNotMatch(host.textContent!, /Delete your account/);
  await click('Delete account…');
  assert.match(host.textContent!, /Delete your account\?/);
  assert.match(host.textContent!, /Your chats and files stay on your computers/);
  assert.match(host.textContent!, /including the Mac app/);
  assert.match(host.textContent!, /credits and payment history/);
  assert.equal(deleteButton()!.disabled, true);
  await inputText('Type your email to confirm', 'dana@example');
  assert.equal(deleteButton()!.disabled, true);
  await inputText('Type your email to confirm', ' dana@example.com ');
  assert.equal(deleteButton()!.disabled, false);
  await click('Delete account');
  assert.deepEqual(calls, ['delete:dana@example.com', 'signOut']);
  assert.doesNotMatch(host.textContent!, /Delete your account/);
});

test('progress is shown while it runs, a failure says why and can be tried again, and Cancel closes the card', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let fail: unknown = Object.assign(new Error('x'), { code: 'relay_unavailable' });
  const { host, calls } = await mount({ id: 'u', email: 'a@b.co' }, async () => {
    await gate;
    if (fail) throw fail;
  });
  await click('Delete account…');
  await inputText('Type your email to confirm', 'a@b.co');
  await click('Delete account');
  assert.match(host.textContent!, /Deleting…/);
  assert.equal([...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.disabled, true);
  release();
  await flush();
  assert.match(host.textContent!, /Nothing was deleted; try again/);
  assert.deepEqual(calls, ['delete:a@b.co']);
  fail = null;
  await click('Delete account');
  assert.deepEqual(calls, ['delete:a@b.co', 'delete:a@b.co', 'signOut']);
});

test('Cancel closes the card and forgets what was typed; with no email on file the word DELETE confirms', async () => {
  const { host } = await mount({ id: 'u', email: 'a@b.co' }, async () => undefined);
  await click('Delete account…');
  await inputText('Type your email to confirm', 'a@b.co');
  await click('Cancel');
  assert.doesNotMatch(host.textContent!, /Delete your account/);
  await click('Delete account…');
  assert.equal((document.querySelector('input') as HTMLInputElement).value, '');
  const bare = await mount({ id: 'u' }, async () => undefined);
  await click('Delete account…');
  await inputText('Type DELETE to confirm', 'anything');
  assert.equal(deleteButton()!.disabled, true);
  await inputText('Type DELETE to confirm', ' Delete ');
  assert.equal(deleteButton()!.disabled, false);
  await click('Delete account');
  assert.deepEqual(bare.calls, ['delete:Delete', 'signOut']);
});

test('the reason shown follows the service’s code', () => {
  assert.match(deleteErrorText({ code: 'confirm_mismatch' }), /Check what you typed/);
  assert.match(deleteErrorText({ code: 'leave_failed' }), /deleted, but this phone couldn't finish signing out/);
  assert.match(deleteErrorText({ code: 'relay_unavailable' }), /Nothing was deleted/);
  assert.match(deleteErrorText(new Error('offline')), /Check your connection/);
  assert.match(deleteErrorText(null), /Check your connection/);
});

test('with push wired, deleting the account also takes this phone off push, through the one sign-out', async () => {
  const { calls } = await mount({ id: 'u', email: 'a@b.co' }, async () => undefined, true);
  await click('Delete account…');
  await inputText('Type your email to confirm', 'a@b.co');
  await click('Delete account');
  assert.deepEqual(calls, ['delete:a@b.co', 'push.signOut', 'signOut']);
});

test('a session the service no longer accepts means the account is gone: the phone leaves, whether the code or the sign-in says so', async () => {
  for (const error of [
    Object.assign(new Error('x'), { code: 'unauthorized' }),
    new Error('Account service returned HTTP 401'),
    new Error('sign in required'),
  ]) {
    const { calls } = await mount({ id: 'u', email: 'a@b.co' }, async () => {
      throw error;
    });
    await click('Delete account…');
    await inputText('Type your email to confirm', 'a@b.co');
    await click('Delete account');
    assert.deepEqual(calls, ['delete:a@b.co', 'signOut'], String(error));
  }
});

test('a phone that cannot finish leaving after the account is gone says so, not "could not delete"', async () => {
  const { deleteThenLeave } = await import(deletePath);
  await assert.rejects(
    deleteThenLeave('a@b.co', {
      deleteAccount: async () => undefined,
      leave: async () => {
        throw new Error('Secure storage unavailable');
      },
    }),
    (e: any) => e.code === 'leave_failed' && deleteErrorText(e).startsWith('Your account was deleted'),
  );
  // a deletion that failed for another reason is passed on as it is, and nothing is left
  let left = false;
  await assert.rejects(
    deleteThenLeave('a@b.co', {
      deleteAccount: async () => {
        throw Object.assign(new Error('x'), { code: 'relay_unavailable' });
      },
      leave: async () => void (left = true),
    }),
    (e: any) => e.code === 'relay_unavailable',
  );
  assert.equal(left, false);
});

test('while it runs the app is busy (Sign out is off), and a phone that became another account’s is not signed out', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { calls, s } = await mount({ id: 'u', email: 'a@b.co' }, async () => {
    await gate;
  });
  await click('Delete account…');
  await inputText('Type your email to confirm', 'a@b.co');
  await click('Delete account');
  await click('Back');
  const signOut = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign out');
  assert.equal(signOut(), undefined, 'Sign out cannot be pressed while busy');
  assert.match(document.body.textContent!, /Sign out/);
  // somebody else signed in meanwhile
  s.state.snap = { ...s.state.snap, user: { id: 'other', email: 'o@b.co' }, generation: 2 };
  release();
  await flush();
  assert.deepEqual(calls, ['delete:a@b.co'], 'the new account was signed out');
  assert.ok(signOut(), 'Sign out can be pressed again');
});

test('two taps before the card re-renders are one request, and an error with no message is an ordinary failure', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { calls } = await mount({ id: 'u', email: 'a@b.co' }, async () => {
    await gate;
  });
  await click('Delete account…');
  await inputText('Type your email to confirm', 'a@b.co');
  await act(async () => {
    const button = deleteButton()!;
    button.click();
    button.click();
  });
  assert.deepEqual(calls, ['delete:a@b.co']);
  release();
  await flush();
  const { deleteThenLeave } = await import(deletePath);
  await assert.rejects(
    deleteThenLeave('a@b.co', { deleteAccount: () => Promise.reject({}), leave: async () => undefined }),
    (e: any) => !('code' in e),
  );
});

test('leaving the account also clears the saved MoMo memory of that account, and a phone without a memory just leaves', async () => {
  const cleared: string[] = [];
  const cache = { clear: async () => void cleared.push('cleared') };
  const withMemory = await mount({ id: 'u', email: 'a@b.co' }, async () => undefined, false, Promise.resolve(cache));
  await click('Delete account…');
  await inputText('Type your email to confirm', 'a@b.co');
  await click('Delete account');
  assert.deepEqual(withMemory.calls, ['delete:a@b.co', 'signOut']);
  assert.deepEqual(cleared, ['cleared']);

  const without = await mount({ id: 'u', email: 'a@b.co' }, async () => undefined, false, Promise.resolve(null));
  await click('Delete account…');
  await inputText('Type your email to confirm', 'a@b.co');
  await click('Delete account');
  assert.deepEqual(without.calls, ['delete:a@b.co', 'signOut']);
  assert.deepEqual(cleared, ['cleared'], 'nothing more to clear');
});
