// Native and buffered CDP events require the current acknowledged attachment and exact membership.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { world } from './support/chrome-membership-kit.mjs';
import { waitFor } from './support/waitFor.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];
const require = createRequire(import.meta.url);
const { ChromeLink } = require('../electron/capabilities/browser/chromeLink.cjs');

test('old native debugger event during transfer cleanup cannot mutate the new destination wrapper', async (t) => {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  const b = await w.tabs.create('b');
  a.wc.debugger.attach();
  await a.wc.debugger.ready;
  const id = a.wc.tabId;
  let finishDetach;
  const detach = w.chrome.debugger.detach;
  w.chrome.debugger.detach = async (target) => {
    await new Promise((resolve) => {
      finishDetach = resolve;
    });
    return detach(target);
  };
  t.after(() => finishDetach?.());
  w.chrome.tabsById.get(id).url = 'https://current.example/';
  w.move(id, w.chrome.tabsById.get(b.wc.tabId).groupId);
  await waitFor(() => finishDetach, 'detach cleanup to start');
  assert.ok(finishDetach, 'old native attachment cleanup is still running');
  assert.equal(w.chrome.attached.has(id), true);
  const fresh = w.tabs.list('b').find((tab) => tab.wc.tabId === id);
  assert.ok(fresh);
  assert.equal(fresh.wc.getURL(), 'https://current.example/');
  assert.equal(fresh.wc.debugger.isAttached(), false);
  w.sessions.onDebuggerEvent({ tabId: id }, 'Page.frameNavigated', {
    frame: { id: 'source-frame', url: 'https://source-history.example/private' },
  });
  assert.equal(fresh.wc.getURL(), 'https://current.example/', 'retired attachment event must not reach the new wrapper');
  assert.equal(fresh.wc.mainFrame, null);
});

test('buffered wire events from an old receipt cannot cross A to B to A', async (t) => {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  const b = await w.tabs.create('b');
  const id = a.wc.tabId;
  const groupA = w.chrome.tabsById.get(id).groupId;
  const oldReceipt = a.wc.membership;
  w.move(id, w.chrome.tabsById.get(b.wc.tabId).groupId);
  w.move(id, groupA);
  const fresh = w.tabs.list('a').find((tab) => tab.wc.tabId === id);
  const emit = (receipt: any) =>
    w.ports.get('a').emit(
      'message',
      JSON.stringify({
        method: 'chrome.debugger.onEvent',
        params: [{ tabId: id }, 'Page.frameNavigated', { frame: { id: 'source-frame', url: 'https://stale.example/' } }, receipt],
      }),
    );
  const before = fresh.wc.getURL();
  for (const receipt of [undefined, null, {}, { membership: '' }, { membership: oldReceipt }]) emit(receipt);
  assert.equal(fresh.wc.getURL(), before);
  assert.equal(fresh.wc.mainFrame, null);
  emit({ membership: fresh.wc.membership });
  assert.equal(fresh.wc.getURL(), 'https://stale.example/');
});

for (const memberships of [false, true])
  test(`CDP event decoder validates native targets in ${memberships ? 'negotiated' : 'legacy'} mode`, () => {
    const ws: any = new EventEmitter();
    ws.open = true;
    ws.send = () => {};
    ws.close = () => {
      ws.open = false;
      ws.emit('close');
    };
    const link = new ChromeLink('a', ws, 1000, { memberships });
    const emit = (params: any[]) => ws.emit('message', JSON.stringify({ method: 'chrome.debugger.onEvent', params }));
    const events: any[] = [];
    link.on('cdp', (...args: any[]) => events.push(args));
    ws.emit('message', JSON.stringify({ method: 'chrome.tabs.onCreated', params: [{ id: 1 }, { membership: 'current' }] }));
    for (const [source, method] of [
      [null, 'x'],
      [{}, 'x'],
      [{ tabId: -1 }, 'x'],
      [{ tabId: 1.5 }, 'x'],
      [{ tabId: 1 }, null],
    ])
      emit([source, method, {}, { membership: 'current' }]);
    assert.equal(events.length, 0);
    if (memberships) {
      emit([{ tabId: 2 }, 'x', {}, { membership: 'current' }]);
      assert.equal(events.length, 0, 'an unknown native ID has no event authority');
    }
    emit([{ tabId: 1 }, 'x', null, { membership: 'current' }]);
    assert.deepEqual(events, [[{ tabId: 1 }, 'x', {}]]);
    link.close('done');
  });
