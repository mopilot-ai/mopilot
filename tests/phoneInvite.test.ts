// Whether this account has Mobile Remote and Host, on the phone (mobile/src/usePhoneInvite.ts): every signed-in account since they left the closed alpha; the service is asked at sign-in and on coming back, and an answer that can't be had blocks nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const invitePath = '../mobile/src/usePhoneInvite';
const { usePhoneInvite } = await import(invitePath);
const g = globalThis as any;

async function rig(features: () => unknown, first: string | undefined = 'u1') {
  let invite = '';
  let host = false;
  const runtime = { features };
  const Probe = ({ user }: any) => {
    ({ invite, host } = usePhoneInvite(runtime, user));
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const show = (user: string | undefined) => act(async () => root.render(createElement(Probe, { user })));
  await show(first);
  await flush();
  return { show, invite: () => invite, host: () => host, done: () => act(async () => root.unmount()) };
}

test('every signed-in account has Mobile Remote and Host, whatever the service lists', async () => {
  for (const features of [['momo', 'phone'], ['momo'], []]) {
    const r = await rig(async () => features);
    assert.equal(r.invite(), 'invited', String(features));
    assert.equal(r.host(), true, String(features));
    await r.done();
  }
  const both = await rig(async () => ['phone', 'host']);
  await both.show(undefined);
  assert.equal(both.host(), false, 'Host goes with the account');
  await both.done();
});

test('with no answer from the service, Host’s tab is still offered to a signed-in account', async () => {
  const none = await rig(async () => null);
  assert.equal(none.host(), true);
  assert.equal(none.invite(), 'unknown');
  await none.done();
  const failed = await rig(async () => {
    throw new Error('offline');
  });
  assert.equal(failed.host(), true);
  await failed.done();
});

test('no answer is not a no: the first read leaves it unknown, and a later one keeps what was known', async () => {
  let answer: any = null;
  const r = await rig(async () => answer);
  assert.equal(r.invite(), 'unknown');
  answer = ['phone'];
  await act(async () => g.__phoneForeground());
  await flush();
  assert.equal(r.invite(), 'invited', 'it is read again on coming back');
  answer = null;
  await act(async () => g.__phoneForeground());
  await flush();
  assert.equal(r.invite(), 'invited');
  answer = () => {
    throw new Error('offline');
  };
  await r.done();
  const failing = await rig(async () => {
    throw new Error('offline');
  });
  assert.equal(failing.invite(), 'unknown');
  await failing.done();
});

test('a read that fails keeps a known answer; signing out starts over; a late answer after leaving is dropped', async () => {
  let fail = false;
  let release: (value: string[]) => void = () => {};
  let hold = false;
  const r = await rig(() => {
    if (hold) return new Promise((resolve) => (release = resolve));
    return fail ? Promise.reject(new Error('offline')) : Promise.resolve(['phone']);
  });
  assert.equal(r.invite(), 'invited');
  fail = true;
  await act(async () => g.__phoneForeground());
  await flush();
  assert.equal(r.invite(), 'invited');
  await r.show(undefined);
  assert.equal(r.invite(), 'loading');
  fail = false;
  hold = true;
  await r.show('u2');
  await r.show(undefined);
  release(['phone']);
  await flush();
  assert.equal(r.invite(), 'loading', 'the answer for an account that left');
  await r.done();
  hold = true;
  const rejecting = await rig(() => new Promise((_, reject) => (release = reject as never)));
  await rejecting.done();
  release(new Error('late') as never);
  await flush();
});
