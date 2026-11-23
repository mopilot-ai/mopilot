// A debugger detach means what the extension says it means: target_closed loses only the debugger, the user's acts lose the tab (#2325).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './support/chrome-membership-kit.mjs';

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
async function attached(t: any) {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  a.wc.debugger.attach();
  await a.wc.debugger.ready;
  return { ...w, a };
}

test('a target_closed detach on a tab that stays open keeps it the chat’s, and the next step attaches again', async (t) => {
  const w = await attached(t);
  const tabId = w.a.wc.tabId;
  // Chrome replaced the page (a prerender activation): the debugger goes, the tab stays in the chat's group
  w.chrome.attached.delete(tabId);
  w.sessions.onDebuggerDetach({ tabId }, 'target_closed');
  await tick();
  assert.equal(w.sessions.owner.get(tabId), 'a');
  assert.equal(w.relay.owns('a', tabId, w.a.wc.membership), true);
  assert.equal(w.a.wc.isDestroyed(), false);
  assert.equal(w.a.wc.debugger.isAttached(), false);
  assert.doesNotThrow(() => w.a.wc.assertDrivable());
  w.a.wc.debugger.attach();
  await w.a.wc.debugger.ready;
  assert.equal(w.a.wc.debugger.isAttached(), true);
  assert.ok(w.chrome.attached.has(tabId));
});

test('the tab closing after a target_closed detach still lets it go', async (t) => {
  const w = await attached(t);
  const tabId = w.a.wc.tabId;
  w.chrome.attached.delete(tabId);
  w.sessions.onDebuggerDetach({ tabId }, 'target_closed');
  w.chrome.tabsById.delete(tabId);
  w.sessions.onTabRemoved(tabId);
  await tick();
  assert.equal(w.relay.owns('a', tabId, w.a.wc.membership), false);
  assert.equal(w.a.wc.isDestroyed(), true);
  const { ChromeTabContents } = await import('../electron/capabilities/browser/chromeTab.cjs');
  const stale = new (ChromeTabContents as any)({ relay: w.relay, chatId: 'a', tab: { id: tabId, membership: w.a.wc.membership } });
  assert.throws(() => stale.assertDrivable(), /was closed/);
});

for (const [reason, said] of [
  ['canceled_by_user', /cancelled Chrome's debugging bar/],
  ['removed_from_group', /dragged it out of the chat's tab group/],
] as const) {
  test(`${reason} takes the tab from the chat, and a step still naming it is told why`, async (t) => {
    const w = await attached(t);
    const tabId = w.a.wc.tabId;
    const link = w.relay.link('a');
    if (reason === 'canceled_by_user') {
      w.chrome.attached.delete(tabId);
      w.sessions.onDebuggerDetach({ tabId }, reason);
    } else w.move(tabId, -1);
    await tick();
    assert.equal(w.relay.owns('a', tabId, w.a.wc.membership), false);
    assert.equal(link.lost.get(tabId), reason);
    // the host let go of its own wrapper, which says which act of the user's took it, through the CDP check too
    assert.equal(w.a.wc.isDestroyed(), true);
    assert.throws(() => w.a.wc.assertDrivable(), said);
    const { assertCdpTarget } = await import('../electron/capabilities/browser/cdp.cjs');
    assert.throws(() => (assertCdpTarget as any)(w.a.wc, { appContents: [], panelSession: null }), said);
    // a wrapper made for the same tab later reads the link's record
    const { ChromeTabContents } = await import('../electron/capabilities/browser/chromeTab.cjs');
    const stale = new (ChromeTabContents as any)({ relay: w.relay, chatId: 'a', tab: { id: tabId, membership: w.a.wc.membership } });
    assert.throws(() => stale.assertDrivable(), said);
  });
}

test('any detach reason but target_closed takes the tab, as the extension drops it (a reason Chrome adds later, none at all)', async (t) => {
  for (const reason of ['', 'some_new_reason']) {
    const w = await attached(t);
    const tabId = w.a.wc.tabId;
    w.chrome.attached.delete(tabId);
    w.sessions.onDebuggerDetach({ tabId }, reason);
    await tick();
    assert.equal(w.sessions.owner.get(tabId), undefined, reason);
    assert.equal(w.relay.owns('a', tabId, w.a.wc.membership), false, reason);
    assert.equal(w.a.wc.isDestroyed(), true, reason);
  }
});

test('a target_closed detach with a stale receipt, a bad tab id, or no receipts at all', async (t) => {
  const w = await attached(t);
  const tabId = w.a.wc.tabId;
  const link = w.relay.link('a');
  const seen: any[] = [];
  link.on('detach', (id: number, why: string) => seen.push([id, why]));
  const port = w.ports.get('a');
  const event = (params: any[]) => port.emit('message', JSON.stringify({ method: 'chrome.debugger.onDetach', params }));
  event([{ tabId }, 'target_closed', { membership: 'stale' }]);
  event([{ tabId: -1 }, 'target_closed', { membership: 'x' }]);
  event([{ tabId: 'x' }, 'target_closed']);
  event([null, 'target_closed']);
  assert.deepEqual(seen, []);
  assert.equal(w.relay.owns('a', tabId, w.a.wc.membership), true);
  event([{ tabId }, 'target_closed', { membership: w.a.wc.membership }]);
  assert.deepEqual(seen, [[tabId, 'target_closed']]);

  // the Playwright Extension's relay has no receipts: its detach is taken as it comes
  const { ChromeLink } = await import('../electron/capabilities/browser/chromeLink.cjs');
  const { EventEmitter } = await import('node:events');
  const ws: any = new EventEmitter();
  ws.open = true;
  ws.send = () => undefined;
  const plain = new (ChromeLink as any)('b', ws, 1000);
  ws.emit('message', JSON.stringify({ method: 'chrome.tabs.onCreated', params: [{ id: 9 }] }));
  const plainSeen: any[] = [];
  plain.on('detach', (id: number, why: string) => plainSeen.push([id, why]));
  ws.emit('message', JSON.stringify({ method: 'chrome.debugger.onDetach', params: [{ tabId: 9 }, 'target_closed'] }));
  assert.equal(plain.tabs.has(9), true);
  ws.emit('message', JSON.stringify({ method: 'chrome.debugger.onDetach', params: [{ tabId: 9 }] }));
  assert.equal(plain.tabs.has(9), false);
  assert.equal(plain.lost.get(9), '');
  assert.deepEqual(plainSeen, [
    [9, 'target_closed'],
    [9, ''],
  ]);
});

test('a tab the chat never had is refused without blaming the user', async (t) => {
  const w = await attached(t);
  const { ChromeTabContents } = await import('../electron/capabilities/browser/chromeTab.cjs');
  const other = new (ChromeTabContents as any)({ relay: w.relay, chatId: 'a', tab: { id: 777, membership: 'x' } });
  assert.throws(
    () => other.assertDrivable(),
    (e: any) => e.code === 'bad_target' && !/the user/.test(e.message),
  );
});
