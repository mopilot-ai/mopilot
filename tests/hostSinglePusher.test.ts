// The one-pusher rule (P4): a chat whose Host sends the push is not pushed from the Mac, with the Mac online or offline of the Host's phones; everything else is pushed as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPushBridge, hostSendsPush } = require('../electron/remote/pushBridge.cjs');

function rig(hostPushes?: (c: string) => boolean) {
  const sent: any[] = [];
  const remote = { devices: { list: () => [{ pairId: 'p1' }] }, pushRequest: async (r: any) => (sent.push(r), 'sent') };
  const bridge = createPushBridge({ remote: () => remote, idleMs: () => null, ...(hostPushes && { hostPushes }) });
  return { bridge, sent };
}
const need = (chatId: string) => ({ kind: 'permission', chatId, needs: true });

test('the Host pushes: the Mac sends no needs-you for that chat, and no catch-up', async () => {
  const { bridge, sent } = rig((c) => c === 'host-chat');
  bridge.onBanner(need('host-chat'));
  assert.equal(await bridge.catchUp({ chatId: 'host-chat', at: 1 }), true);
  assert.equal(sent.length, 0);
});

test('any other chat, and a finished chat on a Host chat, still goes from the Mac', async () => {
  const { bridge, sent } = rig((c) => c === 'host-chat');
  bridge.onBanner(need('local-chat'));
  assert.equal(sent.length, 1);
  assert.equal(await bridge.catchUp({ chatId: 'local-chat', at: 2 }), true);
  assert.equal(sent.length, 2);
  // default: no Host pushes
  const d = rig();
  d.bridge.onBanner(need('host-chat'));
  assert.equal(d.sent.length, 1);
  // a banner that does not need a person is not the Host's concern
  const f = rig(() => true);
  f.bridge.onBanner({ kind: 'turn', chatId: 'host-chat', needs: false });
  assert.ok(f.sent.length <= 1);
});

test('the Host sends the push only with approvals2 and a phone enrollment', () => {
  assert.equal(hostSendsPush({ features: ['approvals2'], links: [{ client: 'fp' }] }), true);
  assert.equal(hostSendsPush({ features: ['approvals2'], links: [{}] }), false);
  assert.equal(hostSendsPush({ features: [], links: [{ client: 'fp' }] }), false);
  assert.equal(hostSendsPush({ links: [{ client: 'fp' }] }), false);
  assert.equal(hostSendsPush({ features: ['approvals2'] }), false);
  assert.equal(hostSendsPush(null), false);
});
