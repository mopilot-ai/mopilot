// Native CDP events belong only to an acknowledged current debugger generation and its exact tab membership.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { membershipExtension } from './support/chrome-membership-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

for (const receipts of [false, true]) {
  test(`native events require acknowledged attachment ownership with ${receipts ? 'receipt-bearing' : 'legacy'} payloads`, async () => {
    const w = await membershipExtension({ receipts });
    const a = await w.create();
    const source = { tabId: a.id };
    const event = () => w.sessions.onDebuggerEvent(source, 'Page.loadEventFired');
    const events = () => w.sent.filter((m) => m.method === 'chrome.debugger.onEvent');
    event();
    assert.equal(events().length, 0, 'tab ownership alone never authenticates native events');
    await w.request('a', 'chrome.debugger.attach', [source], a.membership);
    event();
    assert.equal(events().length, 1);
    assert.deepEqual(events()[0].params, [source, 'Page.loadEventFired', {}, ...(receipts ? [{ membership: a.membership }] : [])]);
    await w.request('a', 'chrome.debugger.detach', [source], a.membership);
    event();
    assert.equal(events().length, 1, 'retirement withdraws event authority synchronously');
  });
}

for (const returned of [false, true]) {
  test(`old native CDP events stay retired during ${returned ? 'ABA' : 'A to B'} cleanup and replacement attach acknowledgement`, async () => {
    const w = await membershipExtension();
    const a = await w.create();
    const b = await w.create('b');
    await w.request('a', 'chrome.debugger.attach', [{ tabId: a.id }], a.membership);
    const cleanup = deferred<void>();
    const cleanupStarted = deferred<void>();
    const attach = deferred<void>();
    const attachStarted = deferred<void>();
    const detachNative = w.chrome.debugger.detach;
    const attachNative = w.chrome.debugger.attach;
    w.chrome.debugger.detach = async (target) => {
      cleanupStarted.resolve();
      await cleanup.promise;
      await detachNative(target);
    };
    w.chrome.debugger.attach = async (target, version) => {
      await attachNative(target, version);
      attachStarted.resolve();
      await attach.promise;
    };
    w.move(a.id, b.groupId);
    if (returned) w.move(a.id, a.groupId);
    const chat = returned ? 'a' : 'b';
    const membership = w.sessions.memberships.get(a.id)!.id;
    await cleanupStarted.promise;
    const event = () =>
      w.sessions.onDebuggerEvent({ tabId: a.id }, 'Page.frameNavigated', { frame: { id: 'old-frame', url: 'https://old.example/' } });
    const events = () => w.sent.filter((m) => m.method === 'chrome.debugger.onEvent');
    event();
    const pending = w.request(chat, 'chrome.debugger.attach', [{ tabId: a.id }], membership);
    event();
    assert.equal(events().length, 0, 'the retired attachment cannot be relabelled to the destination');
    cleanup.resolve();
    await attachStarted.promise;
    event();
    assert.equal(events().length, 0, 'native effect without acknowledgement cannot emit');
    attach.resolve();
    assert.equal((await pending).error, undefined);
    event();
    assert.equal(events().length, 1);
    assert.equal(events()[0].chat, chat);
    assert.deepEqual(events()[0].params[3], { membership });
  });
}

test('failed old debugger cleanup leaves native events suppressed until a valid retry attaches', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const b = await w.create('b');
  await w.request('a', 'chrome.debugger.attach', [{ tabId: a.id }], a.membership);
  w.chrome.fail['debugger.detach'] = new Error('native cleanup unavailable');
  w.move(a.id, b.groupId);
  const membership = w.sessions.memberships.get(a.id)!.id;
  const next = await w.request('b', 'chrome.debugger.attach', [{ tabId: a.id }], membership);
  assert.match(next.error.message, /cleanup unavailable/);
  w.sessions.onDebuggerEvent({ tabId: a.id }, 'Page.frameNavigated', {});
  assert.equal(
    w.sent.some((m) => m.method === 'chrome.debugger.onEvent'),
    false,
  );
  delete w.chrome.fail['debugger.detach'];
  assert.equal((await w.request('b', 'chrome.debugger.attach', [{ tabId: a.id }], membership)).error, undefined);
  w.sessions.onDebuggerEvent({ tabId: a.id }, 'Page.frameNavigated', {});
  assert.deepEqual(w.sent.at(-1).params[3], { membership });
});

test('debugger event authority checks exact caller identity and rotates a same-owner replacement generation', async () => {
  const { Debuggers } = await import('../electron/chrome-extension/src/debuggers.mjs');
  const w = await membershipExtension();
  const a = await w.create();
  const owner = { attached: new Set<number>() };
  const other = { attached: new Set<number>() };
  const old = {};
  const fresh = {};
  const debuggerOwner = new Debuggers({ chrome: w.chrome, changed: () => {}, log: () => {} });
  await debuggerOwner.attach(owner, a.id, '1.3', () => true, old);
  assert.equal(debuggerOwner.ownsEvents(owner, a.id, old), true);
  assert.equal(debuggerOwner.ownsEvents(other, a.id, old), false);
  assert.equal(debuggerOwner.ownsEvents(owner, a.id, fresh), false);
  owner.attached.clear();
  assert.equal(debuggerOwner.ownsEvents(owner, a.id, old), false, 'missing acknowledged state cannot authenticate an event');
  owner.attached.add(a.id);
  await debuggerOwner.attach(owner, a.id, '1.3', () => true, fresh);
  assert.equal(debuggerOwner.ownsEvents(owner, a.id, old), false);
  assert.equal(debuggerOwner.ownsEvents(owner, a.id, fresh), true);
  await debuggerOwner.attach(other, a.id, '1.3', () => true, fresh);
  assert.equal(debuggerOwner.ownsEvents(owner, a.id, fresh), false);
  assert.equal(debuggerOwner.ownsEvents(other, a.id, fresh), true);
  await debuggerOwner.release(other, a.id);
});

test('attachment invalidated before native acknowledgement cannot emit while its cleanup remains pending', async () => {
  const w = await membershipExtension();
  const a = await w.create();
  const attach = deferred<void>();
  const attachStarted = deferred<void>();
  const cleanup = deferred<void>();
  const cleanupStarted = deferred<void>();
  const nativeAttach = w.chrome.debugger.attach;
  const nativeDetach = w.chrome.debugger.detach;
  w.chrome.debugger.attach = async (target, version) => {
    attachStarted.resolve();
    await attach.promise;
    await nativeAttach(target, version);
  };
  w.chrome.debugger.detach = async (target) => {
    cleanupStarted.resolve();
    await cleanup.promise;
    await nativeDetach(target);
  };
  const pending = w.request('a', 'chrome.debugger.attach', [{ tabId: a.id }], a.membership);
  await attachStarted.promise;
  w.sessions.advance('a', 1);
  attach.resolve();
  await cleanupStarted.promise;
  w.sessions.onDebuggerEvent({ tabId: a.id }, 'Page.frameNavigated', {});
  assert.equal(
    w.sent.some((m) => m.method === 'chrome.debugger.onEvent'),
    false,
  );
  cleanup.resolve();
  assert.ok((await pending).error);
});
