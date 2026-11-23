// Receipt negotiation and malformed boundary records cannot upgrade tab authority; legacy peers retain opener-only admission.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { world } from './support/chrome-membership-kit.mjs';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];
const require = createRequire(import.meta.url);
const { ChromeLink } = require('../electron/capabilities/browser/chromeLink.cjs');
const { ExtensionPeer, proofOf, MEMBERSHIP_CAPABILITY } = require('../electron/capabilities/browser/chromeExtensionTransport.cjs');
const { ChromeExtensionChannel } = require('../electron/capabilities/browser/chromeExtension.cjs');
const { memoryPairing } = await import('./support/chrome-extension-kit.ts');

function port() {
  const ws: any = new EventEmitter();
  ws.open = true;
  ws.sent = [];
  ws.send = (text: string) => ws.sent.push(JSON.parse(text));
  ws.close = () => {
    ws.open = false;
    ws.emit('close');
  };
  ws.report = (method: string, params: any[]) => ws.emit('message', JSON.stringify({ method, params }));
  ws.reply = (id: number, result: any) => ws.emit('message', JSON.stringify({ id, result }));
  return ws;
}
const receipt = (membership: string, groupId?: number) => ({
  membership,
  ...(groupId === undefined ? {} : { ownership: { kind: 'user_group', groupId } }),
});

for (const capabilities of [
  undefined,
  null,
  false,
  {},
  MEMBERSHIP_CAPABILITY,
  [],
  ['unknown'],
  [MEMBERSHIP_CAPABILITY, false],
  [MEMBERSHIP_CAPABILITY, MEMBERSHIP_CAPABILITY],
  [MEMBERSHIP_CAPABILITY],
  ['future', MEMBERSHIP_CAPABILITY],
]) {
  test(`authenticated capability acknowledgement ${JSON.stringify(capabilities)} is exact`, () => {
    const ws = port();
    const secret = 'synthetic-unit-secret';
    const peer = new ExtensionPeer(ws, secret, 1000, () => null);
    assert.equal(ws.sent[0].protocol, 1);
    const accepted =
      Array.isArray(capabilities) &&
      capabilities.every((v) => typeof v === 'string') &&
      capabilities.filter((v) => v === MEMBERSHIP_CAPABILITY).length === 1;
    ws.emit(
      'message',
      JSON.stringify({
        type: 'auth',
        protocol: 1,
        nonce: 'n'.repeat(16),
        proof: proofOf(secret, 'extension', peer.nonce, 'n'.repeat(16)),
        capabilities,
      }),
    );
    assert.equal(peer.memberships, accepted);
    assert.deepEqual(ws.sent.at(-1).capabilities, accepted ? [MEMBERSHIP_CAPABILITY] : undefined);
    peer.close(1000, 'done');
  });
}

test('unproved capability advertisement never authenticates an extension', () => {
  const ws = port();
  const peer = new ExtensionPeer(ws, 'synthetic-unit-secret', 1000, () => null);
  ws.emit(
    'message',
    JSON.stringify({ type: 'auth', protocol: 1, nonce: 'n'.repeat(16), proof: 'wrong', capabilities: [MEMBERSHIP_CAPABILITY] }),
  );
  assert.equal(peer.memberships, false);
  assert.equal(peer.open, false);
});

for (const metadata of [
  undefined,
  null,
  {},
  { membership: '' },
  { membership: 1 },
  { membership: 'x'.repeat(129) },
  { membership: 'x', ownership: null },
  { membership: 'x', ownership: [] },
  { membership: 'x', ownership: { kind: 'other', groupId: 7 } },
  receipt('x', -1),
  receipt('x', 7.5),
  receipt('x', Number.MAX_SAFE_INTEGER + 1),
  receipt('x', 8),
]) {
  test(`negotiated link rejects malformed receipt or proof ${JSON.stringify(metadata)}`, () => {
    const ws = port();
    const link = new ChromeLink('a', ws, 1000, { memberships: true });
    ws.report('chrome.tabs.onCreated', [{ id: 1, groupId: 7 }, metadata]);
    assert.equal(link.tabs.size, 0);
    assert.equal(link.memberships.size, 0);
    link.close('done');
  });
}

test('receipt and proof remain separate, and stale removal cannot revoke a newer receipt', () => {
  const ws = port();
  const link = new ChromeLink('a', ws, 1000, { memberships: true });
  for (const tab of [null, {}, { id: -1 }, { id: 0.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }])
    ws.report('chrome.tabs.onCreated', [tab, receipt('old', 7)]);
  assert.equal(link.tabs.size, 0);
  ws.report('chrome.tabs.onCreated', [{ id: 1, groupId: 7, membership: 'forged' }, receipt('old', 7)]);
  assert.deepEqual(link.memberships.get(1), { membership: 'old', manual: true });
  ws.report('chrome.tabs.onCreated', [{ id: 1, groupId: 7 }, receipt('new')]);
  assert.deepEqual(link.memberships.get(1), { membership: 'new', manual: false }, 'manual proof is not sticky');
  ws.report('chrome.tabs.onRemoved', [1]);
  ws.report('chrome.tabs.onRemoved', [1, receipt('old')]);
  ws.report('chrome.debugger.onDetach', [{ tabId: 1 }, 'removed_from_group', receipt('old')]);
  assert.equal(link.tabs.get(1).membership, 'new');
  ws.report('chrome.tabs.onRemoved', [1, receipt('new')]);
  assert.equal(link.tabs.size, 0);
  link.close('done');
});

for (const newer of ['removed', 'replaced', 'same']) {
  test(`create decoder fences ${newer} ownership observed before reply`, async () => {
    const ws = port();
    const link = new ChromeLink('a', ws, 1000, { memberships: true });
    const pending = link.send('chrome.tabs.create', [{}]);
    if (newer === 'removed') ws.report('chrome.tabs.onRemoved', [20, receipt('old')]);
    else ws.report('chrome.tabs.onCreated', [{ id: 20 }, receipt(newer === 'same' ? 'old' : 'new')]);
    ws.reply(1, { id: 20, membership: 'old' });
    if (newer === 'same') assert.equal((await pending).id, 20);
    else await assert.rejects(pending, { code: 'bad_target' });
    assert.equal(link.tabs.has(20), newer !== 'removed');
    link.close('done');
  });
}

for (const result of [undefined, {}, { id: 20 }, { id: 20, membership: '' }]) {
  test(`negotiated create decoder rejects missing identity ${JSON.stringify(result)}`, async () => {
    const ws = port();
    const link = new ChromeLink('a', ws, 1000, { memberships: true });
    const pending = link.send('chrome.tabs.create', [{}]);
    ws.reply(1, result);
    await assert.rejects(pending, { code: 'bad_target' });
    link.close('done');
  });
}

test('bare, null, foreign and retired tokens cannot acquire a current negotiated membership', async (t) => {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  const b = await w.tabs.create('b');
  const old = a.wc.token();
  const groupA = w.chrome.tabsById.get(a.wc.tabId).groupId;
  w.move(a.wc.tabId, w.chrome.tabsById.get(b.wc.tabId).groupId);
  w.move(a.wc.tabId, groupA);
  const current = w.tabs.list('a')[0].wc.token();
  for (const token of [w.relay.token('a'), { ...current, membership: null }, { ...current, membership: undefined }, b.wc.token(), old]) {
    for (const operation of ['attach', 'detach', 'removeTab'])
      await assert.rejects(w.relay[operation](token, a.wc.tabId), { code: 'bad_target' });
  }
  await w.relay.attach(current, a.wc.tabId);
  assert.equal(w.chrome.attached.has(a.wc.tabId), true);
  w.relay.advance('a');
  await w.relay.detach(current, a.wc.tabId);
  assert.equal(w.chrome.attached.has(a.wc.tabId), false, 'same-receipt cleanup still tolerates old turns');
});

test('legacy links ignore forged manual metadata and raw receipt properties while explicit openers still work', async (t) => {
  const w = world({ memberships: false });
  t.after(() => w.tabs.dispose());
  const root = await w.tabs.create('a');
  const ws = w.ports.get('a');
  const report = (tab: any) => ws.emit('message', JSON.stringify({ method: 'chrome.tabs.onCreated', params: [tab, receipt('fake', 7)] }));
  report({ id: 900, groupId: 7, membership: 'fake' });
  assert.deepEqual(w.ids('a'), [root.wc.tabId]);
  assert.equal(w.relay.link('a').tabs.get(900).membership, undefined);
  report({ id: 901, groupId: 7, openerTabId: root.wc.tabId });
  assert.deepEqual(w.ids('a'), [root.wc.tabId, 901]);
});

for (const memberships of [false, true]) {
  test(`real channel captures authenticated capability ${memberships} before replay and host listeners`, async () => {
    const channel = new ChromeExtensionChannel({
      pairing: memoryPairing(),
      openPage: () => {
        throw Error('no browser');
      },
    });
    channel.start = async () => 1;
    const peer: any = {
      open: true,
      memberships,
      send: (m: any) => {
        if (m.method !== 'session.open') return;
        const port = channel.ports.get(m.chat);
        port.emit('message', JSON.stringify({ method: 'chrome.tabs.onCreated', params: [{ id: 50, groupId: 7 }, receipt('known', 7)] }));
        port.emit('message', JSON.stringify({ method: 'extension.initialized' }));
      },
    };
    channel.peer = peer;
    const link = await channel.connect('a');
    assert.equal(link.membershipReceipts, memberships);
    assert.equal(link.tabs.size, 1);
    assert.equal(link.memberships.get(50)?.manual, memberships ? true : undefined);
    channel.disconnect('a');
  });
}

test('retiring a suspended source rechecks destination after a reentrant chat close', async (t) => {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  const b = await w.tabs.create('b');
  const old = w.relay.link('a');
  old.resumable = true;
  old.close('simulated transport loss');
  let closed = false;
  w.tabs.o.onChange = (chat) => {
    if (chat === 'a' && !closed) {
      closed = true;
      w.tabs.forget('b');
    }
  };
  w.move(a.wc.tabId, w.chrome.tabsById.get(b.wc.tabId).groupId);
  assert.equal(closed, true);
  assert.equal(w.relay.link('b'), null);
  assert.deepEqual(w.ids('b'), []);
  await Promise.resolve();
  assert.deepEqual(w.ids('b'), []);
});

test('negative and unsafe native IDs cannot revoke a link inventory', () => {
  const ws = port();
  const link = new ChromeLink('a', ws, 1000, { memberships: true });
  ws.report('chrome.tabs.onCreated', [{ id: 1 }, receipt('one')]);
  for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) ws.report('chrome.tabs.onRemoved', [id, receipt('one')]);
  assert.equal(link.tabs.size, 1);
  link.close('done');
});
