// The pairing confirmation card (electron/remote/pairApproval.cjs, shared/approvalRequest.mjs): a remotePair card through the real ApprovalBroker, the user's choice back to pairing, a withdrawn card, no broker or chat, and the request a window reads carrying only the phone's name and the number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { approvalRequest } from '../shared/approvalRequest.mjs';

const require = createRequire(import.meta.url);
const { createPairConfirm } = require('../electron/remote/pairApproval.cjs');
const { ApprovalBroker, KINDS } = require('../electron/capabilities/contract/approvals.cjs');

test('card: the confirmation goes through the real broker as a remotePair card and returns the user’s choice', async () => {
  const cards: any[] = [];
  const controller = { addApproval: (chatId: string, a: any) => cards.push({ chatId, ...a }), resolveApproval: () => true };
  const broker = new ApprovalBroker({ controller });
  const confirm = createPairConfirm({ broker: () => broker, chatId: () => 'chat-1' });
  const ac = new AbortController();
  const asked = confirm({ device: { id: 'phone-1', name: 'Du’s iPhone' }, safetyNumber: '042913', signal: ac.signal });
  assert.equal(cards[0].chatId, 'chat-1');
  assert.equal(cards[0].method, 'sage/remotePair');
  assert.deepEqual(cards[0].params, { kind: 'remotePair', remotePair: { deviceName: 'Du’s iPhone', safetyNumber: '042913' } });
  assert.ok(KINDS.has('remotePair'));
  broker.answer(cards[0].id, { decision: 'allow' });
  assert.equal(await asked, 'allow');
  const denied = confirm({ device: { id: 'p', name: 'n' }, safetyNumber: '1', signal: ac.signal });
  broker.answer(cards[1].id, { decision: 'deny' });
  assert.equal(await denied, 'deny');
  const odd = confirm({ device: { id: 'p', name: 'n' }, safetyNumber: '1', signal: ac.signal });
  broker.answer(cards[2].id, { decision: 'always' });
  assert.equal(await odd, null);
  const aborted = confirm({ device: { id: 'p', name: 'n' }, safetyNumber: '1', signal: ac.signal });
  ac.abort();
  assert.equal(await aborted, null, 'aborting withdraws the card');
});

test('card: no broker or no chat to put the card in is no confirmation', async () => {
  const req = { device: { id: 'p', name: 'n' }, safetyNumber: '1', signal: new AbortController().signal };
  assert.equal(await createPairConfirm({ broker: () => null, chatId: () => 'c' })(req), null);
  assert.equal(await createPairConfirm({ broker: () => ({ ask: async () => ({ decision: 'allow' }) }), chatId: () => null })(req), null);
});

test('card: the request a window reads carries the phone’s name and the number, and nothing else', () => {
  const a = {
    id: 'x',
    method: 'sage/remotePair',
    params: { kind: 'remotePair', remotePair: { deviceName: 'iPhone', safetyNumber: '123456', secret: 'no' }, other: 1 },
  };
  assert.deepEqual(approvalRequest(a, 'c', null), {
    method: 'sage/remotePair',
    params: { kind: 'remotePair', remotePair: { deviceName: 'iPhone', safetyNumber: '123456' } },
  });
  assert.deepEqual(approvalRequest({ method: 'sage/remotePair' }, 'c', null).params.remotePair, { deviceName: '', safetyNumber: '' });
});
