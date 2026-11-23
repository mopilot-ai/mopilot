// Real WebSocket framing and ownership decoders share the canonical socket fixture and extension-produced events.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { deferred } from './support/async-scenarios.ts';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { FakeExtension } from './support/chrome-relay-kit.ts';
import { assertLegacyReports } from './support/chrome-relay-report-contract.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];
const require = createRequire(import.meta.url);
const { WsConnection } = require('../electron/capabilities/browser/wsServer.cjs');
const { ChromeLink, CONNECT_PAGE } = require('../electron/capabilities/browser/chromeLink.cjs');

function framed({ memberships = false, split = false } = {}) {
  const socket: any = new EventEmitter();
  socket.destroyed = false;
  socket.write = () => {};
  socket.end = () => {};
  const ws = new WsConnection(socket);
  const link = new ChromeLink('a', ws, 1000, { memberships });
  const client: any = new EventEmitter();
  client.write = (frame: Buffer) => {
    if (!split) return socket.emit('data', frame);
    queueMicrotask(() => socket.emit('data', frame.subarray(0, 3)));
    queueMicrotask(() => socket.emit('data', frame.subarray(3)));
  };
  const ext = new FakeExtension(client, () => ({}));
  return { link, ext };
}

for (const split of [false, true])
  test(`the canonical legacy report contract survives ${split ? 'split asynchronous' : 'whole'} wire frames`, async () => {
    const { link, ext } = framed({ split });
    ext.event('chrome.tabs.onCreated', { id: 1, url: CONNECT_PAGE });
    await Promise.resolve();
    await assertLegacyReports(link, ext);
    link.close('done');
  });

for (const memberships of [false, true]) {
  test(`wire revocations reject malformed identity in ${memberships ? 'negotiated' : 'legacy'} mode`, () => {
    const { link, ext } = framed({ memberships });
    const proof = { membership: 'current' };
    ext.event('chrome.tabs.onCreated', { id: 8 }, proof);
    const seen: any[] = [];
    for (const ev of ['removed', 'detach']) link.on(ev, (...args: any[]) => seen.push([ev, ...args]));
    ext.send({ method: 'chrome.tabs.onRemoved' });
    for (const id of [null, -1, 1.5, '8', Number.MAX_SAFE_INTEGER + 1]) {
      ext.event('chrome.tabs.onRemoved', id, proof);
      ext.event('chrome.debugger.onDetach', { tabId: id }, 'canceled_by_user', proof);
    }
    if (memberships)
      for (const metadata of [undefined, null, {}, { membership: '' }, { membership: 'retired' }]) {
        ext.event('chrome.tabs.onRemoved', 8, metadata);
        ext.event('chrome.debugger.onDetach', { tabId: 8 }, 'canceled_by_user', metadata);
      }
    assert.deepEqual(seen, []);
    assert.ok(link.tabs.has(8));
    ext.event('chrome.debugger.onDetach', { tabId: 8 }, 'canceled_by_user', ...(memberships ? [proof] : []));
    assert.deepEqual(seen, [['detach', 8, 'canceled_by_user']]);
    ext.event('chrome.tabs.onCreated', { id: 8 }, proof);
    ext.event('chrome.tabs.onRemoved', 8, ...(memberships ? [proof] : []));
    ext.event('chrome.tabs.onRemoved', 4242, ...(memberships ? [proof] : []));
    assert.deepEqual(seen.slice(1), [
      ['removed', 8],
      ['removed', 4242],
    ]);
    assert.equal(link.tabs.has(8), false);
    link.close('done');
  });

  test(`real extension producer and wire consumer require acknowledged ownership in ${memberships ? 'negotiated' : 'legacy'} mode`, async () => {
    const { link, ext } = framed({ memberships });
    const chrome = fakeChromeApi();
    const sent: any[] = [];
    const sessions = new Sessions({
      chrome,
      storage: null,
      log: () => {},
      send: (m: any) => {
        sent.push(m);
        ext.send(m);
      },
    });
    await sessions.open('a', { receipts: memberships });
    let requestId = 0;
    const request = async (method: string, params: any[], membership?: string) => {
      let answer: any;
      await sessions.handle(
        { chat: 'a', id: ++requestId, method, params, membership, turn: 0 },
        (m: any) => {
          answer = m;
        },
        memberships,
      );
      assert.equal(answer.error, undefined);
      return answer.result;
    };
    const tab = await request('chrome.tabs.create', []);
    await sessions.open('a', { receipts: memberships });
    assert.ok(link.tabs.has(tab.id), 'the actual extension replay established decoder ownership');
    const source = { tabId: tab.id };
    const events: any[] = [];
    link.on('cdp', (...args: any[]) => events.push(args));
    const emit = () => sessions.onDebuggerEvent(source, 'Page.loadEventFired');
    emit();
    assert.deepEqual(events, [], 'membership alone cannot authenticate native events');
    const held = deferred<void>();
    const started = deferred<void>();
    const attach = chrome.debugger.attach;
    chrome.debugger.attach = async (target, version) => {
      await attach(target, version);
      started.resolve();
      await held.promise;
    };
    const pending = request('chrome.debugger.attach', [source, '1.3'], tab.membership);
    await started.promise;
    emit();
    assert.deepEqual(events, [], 'native effect without acknowledgement is not event authority');
    held.resolve();
    await pending;
    emit();
    assert.deepEqual(events, [[source, 'Page.loadEventFired', {}]]);
    const frame = sent.at(-1);
    assert.deepEqual(frame.params, [source, 'Page.loadEventFired', {}, ...(memberships ? [{ membership: tab.membership }] : [])]);
    await request('chrome.debugger.detach', [source], tab.membership);
    emit();
    assert.equal(events.length, 1, 'retired attachment cannot emit');
    if (memberships) {
      ext.event('chrome.debugger.onDetach', source, 'removed_from_group', { membership: tab.membership });
      ext.event('chrome.tabs.onCreated', { ...tab, membership: undefined }, { membership: 'replacement' });
      ext.send(frame);
      ext.event('chrome.debugger.onEvent', source, 'Page.loadEventFired', {});
      assert.equal(events.length, 1, 'old and receipt-less buffered frames cannot reach replacement ownership');
      ext.event('chrome.debugger.onEvent', source, 'Page.loadEventFired', {}, { membership: 'replacement' });
      assert.equal(events.length, 2);
    }
    link.close('done');
  });
}
