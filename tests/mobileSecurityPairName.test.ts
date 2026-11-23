// S-12: the name a phone chooses cannot reorder or hide the confirmation card, and a pairing that replaces a phone this Mac already has says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helloFor, makePhone } from './support/remotePhone.ts';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fakeSafe, fs, tempDir } from './support/remoteKit.ts';
import { rig } from './support/remotePairingRig.ts';

const require = createRequire(import.meta.url);
const { DeviceList } = require('../electron/remote/deviceList.cjs');
const { writeSealedJson } = require('../electron/remote/sealedJson.cjs');

const pairedName = async (name: unknown) => {
  const r = rig();
  const { payload } = await r.svc.begin();
  await r.svc.handleHello(helloFor(makePhone(), payload, { request: { name } }));
  return { stored: r.devices.list()[0].name, shown: r.state.confirms[0].device.name };
};

test('a phone name loses right-to-left overrides, zero-width marks and control characters before anyone reads it', async () => {
  for (const [name, want] of [
    ['Dana\u202Eevil', 'Danaevil'],
    ['\u2066Dana\u2069 phone', 'Dana phone'],
    ['Da\u200Bna\u200E', 'Dana'],
    ['Dana\nSecond\tline\u0000', 'Dana Second line'],
    ['Dana\u2028phone\u2029', 'Dana phone'],
    ['  many    spaces  ', 'many spaces'],
    ['\u202E\u0007\u200B', 'Phone'],
  ] as const) {
    const got = await pairedName(name);
    assert.equal(got.stored, want, JSON.stringify(name));
    assert.equal(got.shown, want, 'the card shows what is stored');
  }
});

test('a name that only looks empty is "Phone", and a stack of combining marks is cut to two', async () => {
  for (const blank of ['\u3164', '\u2800\u2800', '\uFFA0 \u115F\u1160', '\u034F', ' \u3164 '])
    assert.equal((await pairedName(blank)).stored, 'Phone', JSON.stringify(blank));
  assert.equal((await pairedName(`e${'\u0301'.repeat(200)}`)).stored, 'e\u0301\u0301');
  assert.equal((await pairedName('Dana\u3164 phone')).stored, 'Dana phone');
});

test('a long name is cut to 60 characters as a reader counts them, never in the middle of an emoji or a flag', async () => {
  const got = await pairedName('\u{1F600}'.repeat(80));
  assert.equal(Array.from(got.stored).length, 60);
  assert.ok(!/[\uD800-\uDBFF]$/.test(got.stored) && !/^[\uDC00-\uDFFF]/.test(got.stored));
  assert.equal((await pairedName('\u{1F1E9}\u{1F1EA}'.repeat(80))).stored, '\u{1F1E9}\u{1F1EA}'.repeat(60), 'a flag is one character');
  assert.equal((await pairedName(`${'a'.repeat(59)} b`)).stored, 'a'.repeat(59), 'a space left at the cut is dropped');
});

test('pairing a phone this Mac already has says first which phone it replaces, and a new phone is shown by its own name', async () => {
  const r = rig();
  const first = (await r.svc.begin()).payload;
  assert.equal(await r.svc.handleHello(helloFor(makePhone('phone-1', 'Old phone'), first)), 'paired');
  assert.equal(r.state.confirms[0].device.name, 'Old phone');
  const second = (await r.svc.begin()).payload;
  assert.equal(await r.svc.handleHello(helloFor(makePhone('phone-1', 'New phone'), second)), 'paired');
  assert.equal(r.state.confirms[1].device.name, 'Replaces "Old phone" with "New phone"');
  assert.equal(r.devices.get('phone-1').name, 'New phone', 'the card says so; the stored name is the phone’s own');
  assert.ok(r.state.events.some((e: any) => e.state === 'confirming' && e.deviceName === 'Replaces "Old phone" with "New phone"'));
  const third = (await r.svc.begin()).payload;
  await r.svc.handleHello(helloFor(makePhone('phone-2', 'Other'), third));
  assert.equal(r.state.confirms[2].device.name, 'Other');
});

test('a name that claims to replace a phone is no more than a name: a new phone is not shown as a replacement, and the real one comes first', async () => {
  const r = rig();
  const fake = 'Mine (replaces "Old")';
  await r.svc.handleHello(helloFor(makePhone('phone-9', fake), (await r.svc.begin()).payload));
  assert.equal(r.state.confirms[0].device.name, fake, 'the Mac added nothing: nothing was replaced');
  await r.svc.handleHello(helloFor(makePhone('phone-9', 'Next'), (await r.svc.begin()).payload));
  assert.match(r.state.confirms[1].device.name, /^Replaces "Mine \(replaces "Old"\)" with "Next"$/);
});

test('a rename from anywhere goes through the same cleaning, and a name that is not text is "Phone"', async () => {
  const r = rig();
  await r.svc.handleHello(helloFor(makePhone('phone-1', 'First'), (await r.svc.begin()).payload));
  assert.equal(await r.devices.rename('phone-1', 'Ana\u202Elog\u200B'), true);
  assert.equal(r.devices.get('phone-1').name, 'Analog');
  await r.devices.rename('phone-1', 42 as any);
  assert.equal(r.devices.get('phone-1').name, 'Phone');
});

test('a name saved by an earlier version is cleaned when the list is read, so Settings never shows it raw', async () => {
  const file = join(tempDir(), 'devices.key');
  const safe = fakeSafe();
  const old = { id: 'p1', name: 'Dana\u202Eevil\u3164', pairId: 'x', pub: '', edPub: '', createdAt: 1, rotatedAt: 1, lastSeenAt: null };
  await writeSealedJson({ file, safe, fs, value: { v: 1, devices: [old, { ...old, id: 'p2', name: '\u3164' }] } });
  const list = new DeviceList({ file, safe, fs });
  await list.load();
  assert.deepEqual(
    list.list().map((d: any) => d.name),
    ['Danaevil', 'Phone'],
  );
});
