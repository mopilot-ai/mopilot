// The ways to Connect your phone (src/lib/phoneEntry.ts): who sees one, the sidebar banner until a phone is paired or it is dismissed, and the footer's and chat panel's rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, responses, resetCtl, render, click, text, button, flush } from './support/settings-harness.ts';
await setup();
const { createElement: h } = await import('react');
const entry = await import('../src/lib/phoneEntry.ts');
const { PhoneBanner } = await import('../src/components/sidebar/PhoneBanner.tsx');
const { SummaryPhone } = await import('../src/components/panels/SummaryPhone.tsx');
await import('../src/lib/native/remoteSettings.ts');

const phone = { id: 'a', pairId: 'pa', name: 'iPhone', lastSeenAt: null, pairedAt: 1, online: true, mirrors: false, retired: false };
const invited = {
  visible: true,
  signedIn: true,
  account: null,
  enabled: false,
  running: false,
  locked: false,
  pairing: null,
  devices: [] as any[],
};
const fresh = () => {
  resetCtl();
  localStorage.removeItem('phone-banner-dismissed');
  entry.closeConnectPhone();
};

test('an entry is for an invited account, and only a live phone counts as paired', () => {
  assert.deepEqual(entry.entryOf(null), { available: false, paired: 0 });
  assert.deepEqual(entry.entryOf({ visible: false } as any), { available: false, paired: 0 });
  assert.deepEqual(entry.entryOf({ ...invited, devices: [phone, { ...phone, id: 'b', retired: true }] } as any), {
    available: true,
    paired: 1,
  });
});

test('the banner offers Connect to an invited account with no phone; Connect opens the dialog', async () => {
  fresh();
  responses['remoteSettings.state'] = invited;
  const v = await render(h(PhoneBanner));
  await flush(50);
  assert.match(text(v.host), /Connect your phone/);
  await click(button(v.host, 'Connect'));
  assert.equal(entry.isConnectPhoneOpen(), true);
  await v.unmount();
});

test('the banner is absent for an uninvited account and once a phone is paired, and Later is kept', async () => {
  fresh();
  responses['remoteSettings.state'] = { visible: false };
  let v = await render(h(PhoneBanner));
  await flush(50);
  assert.equal(text(v.host), '');
  await v.unmount();
  responses['remoteSettings.state'] = { ...invited, devices: [phone] };
  v = await render(h(PhoneBanner));
  await flush(50);
  assert.equal(text(v.host), '');
  await v.unmount();
  responses['remoteSettings.state'] = invited;
  v = await render(h(PhoneBanner));
  await flush(50);
  await click(button(v.host, 'Later'));
  assert.equal(text(v.host), '');
  await v.unmount();
  v = await render(h(PhoneBanner));
  await flush(50);
  assert.equal(text(v.host), '', 'it stays dismissed');
  await v.unmount();
});

test('a store that cannot be read or written only costs the convenience', () => {
  const real = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    },
  });
  try {
    assert.equal(entry.phoneBannerDismissed(), false);
    entry.dismissPhoneBanner();
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
  }
});

test('the session menu offers pairing or adding a device for an invited account', async () => {
  fresh();
  responses['remoteSettings.state'] = { visible: false };
  let v = await render(h(SummaryPhone));
  await flush(50);
  assert.equal(text(v.host), '');
  await v.unmount();
  responses['remoteSettings.state'] = invited;
  v = await render(h(SummaryPhone));
  await flush(50);
  assert.match(text(v.host), /Connect your phone/);
  await click(button(v.host, 'Connect your phone'));
  assert.equal(entry.isConnectPhoneOpen(), true);
  await v.unmount();
  responses['remoteSettings.state'] = { ...invited, devices: [phone] };
  v = await render(h(SummaryPhone));
  await flush(50);
  assert.match(text(v.host), /Add another phone/);
  await v.unmount();
});

test('a read that fails keeps the entries away, and a late answer after leaving is dropped', async () => {
  fresh();
  responses['remoteSettings.state'] = () => Promise.reject(new Error('unavailable'));
  const v = await render(h(PhoneBanner));
  await flush(50);
  assert.equal(text(v.host), '');
  await v.unmount();
  let answer: (state: any) => void = () => {};
  responses['remoteSettings.state'] = () => new Promise((resolve) => (answer = resolve));
  const late = await render(h(PhoneBanner));
  await late.unmount();
  answer(invited);
  await flush(20);
});
