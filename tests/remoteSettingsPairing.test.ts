// Settings-owned pairing rejects stale document answers and retired starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { createSettingsPairing } = require('../electron/remote/settingsPairing.cjs');

test('only the document owning the QR can decide the current safety number', async () => {
  let cancelled = 0;
  const pairing = {
    begin: async () => ({ qr: 'secret', expiresAt: 42 }),
    cancel: () => {
      cancelled++;
    },
  };
  const settings = createSettingsPairing(() => pairing);
  assert.equal((await settings.begin('one')).qr, 'secret');
  assert.deepEqual(
    settings.snapshot('two'),
    { state: 'elsewhere', qr: null, expiresAt: null, device: null, safetyNumber: null },
    'another window learns it is busy, not the code',
  );
  const abort = new AbortController();
  const decision = settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: abort.signal });
  assert.equal(settings.snapshot('one').qr, null);
  assert.equal(settings.answer('two', true), false);
  assert.equal(settings.answer('one', true), true);
  assert.equal(await decision, 'allow');
  assert.equal(settings.answer('one', true), false);
  settings.event(pairing, { state: 'paired' });
  assert.equal(settings.snapshot('one').state, 'paired');
  assert.equal(settings.cancel('one'), true);
  assert.equal(cancelled, 1);
});

test('retiring a document while begin is pending cancels late registration before another begin', async () => {
  const started = deferred<any>();
  let cancelled = 0;
  const pairing = {
    begin: () => started.promise,
    cancel: () => {
      cancelled++;
    },
  };
  const settings = createSettingsPairing(() => pairing);
  const first = settings.begin('one');
  assert.equal(settings.cancel('one'), true);
  assert.equal(settings.cancel('one'), false);
  await assert.rejects(settings.begin('two'), /already in progress/);
  started.resolve({ qr: 'secret', expiresAt: 42 });
  await assert.rejects(first, /cancelled/);
  assert.equal(settings.snapshot('one'), null);
  assert.equal(cancelled, 2);
});

test('abort and cancellation deny a waiting confirmation and reject late decisions', async () => {
  const pairing = { begin: async () => ({ qr: 'secret', expiresAt: 42 }), cancel: () => {} };
  const settings = createSettingsPairing(() => pairing);
  await settings.begin('one');
  const abort = new AbortController();
  const decision = settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: abort.signal });
  abort.abort();
  assert.equal(await decision, null);
  assert.equal(settings.answer('one', true), false);
  assert.equal(settings.snapshot('one'), null);
});

test('an approved commit cannot be cancelled while it is finishing', async () => {
  let cancelled = 0;
  const pairing = {
    begin: async () => ({ qr: 'secret', expiresAt: 42 }),
    cancel: () => {
      cancelled++;
    },
  };
  const settings = createSettingsPairing(() => pairing);
  await settings.begin('one');
  const ac = new AbortController();
  const result = settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: ac.signal });
  assert.equal(settings.answer('one', true), true);
  assert.equal(await result, 'allow');
  assert.equal(settings.cancel('one'), false);
  assert.equal(cancelled, 0);
});

test('unavailable and failed starts return errors, and terminal states can retry', async () => {
  const unavailable = createSettingsPairing(() => null);
  await assert.rejects(unavailable.begin('owner'), /unavailable/);
  let fail = true;
  let cancelled = 0;
  const pairing = {
    begin: async () => {
      if (fail) throw new Error('offline');
      return { qr: 'qr', expiresAt: 1 };
    },
    cancel: () => {
      cancelled++;
    },
  };
  const settings = createSettingsPairing(() => pairing);
  await assert.rejects(settings.begin('owner'), /offline/);
  assert.equal(cancelled, 1);
  fail = false;
  await settings.begin('owner');
  settings.event({}, { state: 'paired' });
  assert.equal(settings.snapshot('owner').state, 'waiting');
  settings.event(pairing, { state: 'expired' });
  assert.equal(settings.snapshot('owner').state, 'expired');
  assert.equal((await settings.begin('owner')).state, 'waiting');
  settings.retire();
  assert.equal(settings.snapshot('owner'), null);
});

test('retirement after approval clears only the local lease while commit finishes', async () => {
  const pairing = {
    begin: async () => ({ qr: 'qr', expiresAt: 1 }),
    cancel: () => {
      throw new Error('must not cancel');
    },
  };
  const settings = createSettingsPairing(() => pairing);
  await settings.begin('owner');
  const ac = new AbortController();
  const pending = settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: ac.signal });
  assert.equal(settings.answer('owner', true), true);
  assert.equal(await pending, 'allow');
  settings.retire();
  assert.equal(settings.snapshot('owner'), null);
});

test('a declined or already-aborted confirmation cannot approve a phone', async () => {
  const pairing = { begin: async () => ({ qr: 'qr', expiresAt: 1 }), cancel: () => undefined };
  const settings = createSettingsPairing(() => pairing);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: aborted.signal }), null);
  await settings.begin('one');
  assert.equal(await settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: aborted.signal }), null);
  const ac = new AbortController();
  const pending = settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: ac.signal });
  assert.equal(settings.answer('one', 'allow'), false);
  assert.equal(settings.answer('one', false), true);
  assert.equal(await pending, 'deny');
});

test('an abort observed as a listener is installed withdraws confirmation', async () => {
  const pairing = { begin: async () => ({ qr: 'qr', expiresAt: 1 }), cancel: () => undefined };
  const settings = createSettingsPairing(() => pairing);
  await settings.begin('owner');
  let reads = 0;
  const signal = {
    get aborted() {
      return ++reads > 1;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  assert.equal(await settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal }), null);
  assert.equal(settings.snapshot('owner'), null);
});

test('an uncertain activation remains visible after the owning document closes without exposing its pairing data', async () => {
  const pairing = { begin: async () => ({ qr: 'secret', expiresAt: 1 }), cancel: () => undefined };
  const settings = createSettingsPairing(() => pairing);
  await settings.begin('old');
  settings.event(pairing, { state: 'failed', error: 'uncertain' });
  assert.equal(settings.cancel('old'), false);
  assert.deepEqual(settings.snapshot('new'), { state: 'uncertain', qr: null, expiresAt: null, device: null, safetyNumber: null });
  await assert.rejects(settings.begin('new'), /already in progress/);
  settings.retire();
  assert.equal(settings.snapshot('new'), null);
});

test('a late abort from an old confirmation cannot cancel a replacement pairing', async () => {
  const pairing = { begin: async () => ({ qr: 'qr', expiresAt: 1 }), cancel: () => undefined };
  const settings = createSettingsPairing(() => pairing);
  await settings.begin('owner');
  let abort: () => void = () => undefined;
  const signal = {
    aborted: false,
    addEventListener: (_: string, fn: () => void) => {
      abort = fn;
    },
    removeEventListener: () => undefined,
  };
  const pending = settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal });
  assert.equal(settings.answer('owner', false), true);
  assert.equal(await pending, 'deny');
  assert.equal((await settings.begin('owner')).state, 'waiting');
  abort();
  assert.equal(settings.snapshot('owner').state, 'waiting');
});

test('a storage lock remains visible across navigation without implying activation succeeded', async () => {
  const pairing = { begin: async () => ({ qr: 'secret', expiresAt: 1 }), cancel: () => undefined };
  const settings = createSettingsPairing(() => pairing);
  await settings.begin('old');
  settings.event(pairing, { state: 'failed', error: 'storage-locked' });
  assert.equal(settings.cancel('old'), false);
  assert.deepEqual(settings.snapshot('new'), { state: 'storage-locked', qr: null, expiresAt: null, device: null, safetyNumber: null });
  await assert.rejects(settings.begin('new'), /already in progress/);
});

test('another window takes over a QR nobody has scanned, but not a phone being confirmed', async () => {
  let cancelled = 0;
  const pairing = { begin: async () => ({ qr: 'secret', expiresAt: 1 }), cancel: () => void cancelled++ };
  const settings = createSettingsPairing(() => pairing);
  await settings.begin('one');
  assert.equal((await settings.begin('two')).qr, 'secret');
  assert.equal(cancelled, 1);
  assert.equal(settings.snapshot('one').state, 'elsewhere');
  assert.equal(settings.snapshot('one').qr, null);
  const decision = settings.confirm({ device: { name: 'Phone' }, safetyNumber: '123456', signal: new AbortController().signal });
  await assert.rejects(settings.begin('one'), /already in progress/);
  assert.equal(settings.snapshot('two').state, 'confirming');
  settings.answer('two', false);
  assert.equal(await decision, 'deny');
  assert.equal(settings.snapshot('one'), null, 'how a pairing ended is for its owner');
});
