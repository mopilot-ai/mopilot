// The receiving chat's hold on a peer message from a stricter chat (electron/session/peerHold.cjs): when it holds, Allow,
// Decline, expiry, release when the modes come to match, a mode change while queued, and the journal across a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { PeerMessageService } = require('../electron/session/peerMessages.cjs');
const hold = require('../electron/session/peerHold.cjs');

function make(t: any, modes: Record<string, string | null> = { A: 'default', B: 'full-access' }, opts: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-hold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: any[] = [];
  const removed: any[] = [];
  const states: Record<string, any> = { A: { turn: 'idle', queue: [] }, B: { turn: 'idle', queue: [] } };
  const controller: any = {
    send: (id: string, item: any) => sent.push({ id, item }),
    state: { get: (id: string) => states[id], patch: (id: string, p: any) => Object.assign(states[id], p) },
    peerCapabilities: () => ({ steer: true }),
    removeQueued: (target: string, id: string) => removed.push([target, id]),
  };
  const file = path.join(dir, 'journal.json');
  const create = () =>
    new PeerMessageService({
      file,
      controller,
      exists: () => true,
      authorize: () => ({ sourceTurnId: 'turn' }),
      gate: opts.gate ?? (() => null),
      permission: (id: string) => modes[id] ?? null,
    });
  return { service: create(), create, sent, removed, modes, file };
}
const req = (requestId: string, extra: any = {}) => ({ targetChatId: 'B', requestId, body: `Run the migration ${requestId}`, ...extra });

test('only a receiver in Full access holds, and only a message from a chat that is not', () => {
  assert.equal(hold.permissionClass('full-access'), 'unattended');
  for (const mode of ['read-only', 'default', 'auto-review', 'plan']) assert.equal(hold.permissionClass(mode), 'prompting');
  assert.equal(hold.permissionClass(null), null);
  assert.equal(hold.permissionClass(''), null);
  assert.equal(hold.holdReason('default', 'full-access'), 'held_mode_mismatch');
  assert.equal(hold.holdReason('read-only', 'full-access'), 'held_mode_mismatch');
  assert.equal(hold.holdReason(null, 'full-access'), 'held_mode_unknown');
  // matching modes, or a receiver whose own prompts still guard it: no friction
  assert.equal(hold.holdReason('full-access', 'full-access'), null);
  assert.equal(hold.holdReason('read-only', 'default'), null);
  assert.equal(hold.holdReason('full-access', 'read-only'), null);
  assert.equal(hold.holdReason('default', null), null);
});

test('a chat’s permission is its harness’s reported mode first, then its saved choice, then the default', () => {
  assert.equal(hold.chatPermission({ session: { permission: 'bypassPermissions' } }), 'full-access');
  assert.equal(hold.chatPermission({ config: { permission: 'read-only' }, session: {} }), 'read-only');
  assert.equal(hold.chatPermission({ prefs: { permission: 'full-access' }, session: {} }), 'full-access');
  assert.equal(hold.chatPermission({}), 'default');
  // a pending harness switch has no native mode yet: the saved choice
  assert.equal(
    hold.chatPermission({ config: { permission: 'default' }, session: { pendingSwitch: true, permission: 'bypassPermissions' } }),
    'default',
  );
  // an ACP chat's mode reads from its anchors; a mode with none falls back to the saved choice
  const acp = (anchor: string | undefined) => ({
    acp: { currentModeId: 'm', modes: { currentModeId: 'm' }, anchors: anchor ? { m: anchor } : {} },
  });
  assert.equal(hold.chatPermission({ session: acp('full') }), 'full-access');
  assert.equal(hold.chatPermission({ config: { permission: 'full-access' }, session: { acp: {} } }), 'full-access');
});

test('a message to a Full access chat waits for its user; Allow delivers it once, without asking again', async (t) => {
  const { service, sent } = make(t);
  const m = await service.send('A', req('r1'));
  assert.equal(m.delivery, 'held');
  assert.equal(m.errorCode, 'held_mode_mismatch');
  assert.equal(m.heldUntil > Date.now() - 1000, true);
  assert.equal(sent.length, 0, 'nothing reaches the receiving harness while held');
  // only the receiving chat answers a hold
  assert.throws(() => hold.declineHeld(service, 'A', m.id), /cannot_decline/);
  await assert.rejects(hold.approveHeld(service, 'A', m.id), /cannot_approve/);
  const approved = await hold.approveHeld(service, 'B', m.id);
  assert.equal(approved.delivery, 'queued');
  assert.equal(approved.allowedByUser, true);
  assert.equal(sent.length, 1);
  await assert.rejects(hold.approveHeld(service, 'B', m.id), /cannot_approve/);
  // the queued item still passes the dispatch check: an allowed message is not held again
  await service.beforeDispatch({ chatId: 'B', kind: 'start', item: sent[0].item, ref: { id: 'native-B', kind: 'claude' } });
  assert.equal(service.get('A', m.id).delivery, 'submitting');
});

test('Decline ends a held message; the sender can cancel one; a reply to the receiver’s own request is never held', async (t) => {
  const { service, sent } = make(t);
  const declined = await service.send('A', req('r1'));
  assert.equal(hold.declineHeld(service, 'B', declined.id).delivery, 'declined');
  assert.throws(() => hold.declineHeld(service, 'B', declined.id), /cannot_decline/);
  const cancelled = await service.send('A', req('r2'));
  assert.equal(service.cancel('A', cancelled.id).delivery, 'cancelled');
  // B (Full access) asks A, a prompting chat, which takes it at once; A's answer is data for B's own question
  const ask = await service.send('B', { targetChatId: 'A', requestId: 'ask', body: 'Which tables?' });
  assert.equal(ask.delivery, 'queued');
  await service.beforeDispatch({ chatId: 'A', kind: 'start', item: sent.at(-1).item, ref: { id: 'native-A', kind: 'claude' } });
  service.result({ item: sent.at(-1).item, result: { started: true, turnId: 't' } });
  const reply = await service.reply('A', { messageId: ask.id, requestId: 'answer', body: 'users and orders' });
  assert.equal(reply.delivery, 'queued');
  assert.equal(sent.at(-1).id, 'B');
});

test('a held message expires on time, and is delivered by itself once the two chats’ modes match', async (t) => {
  const clock = useFakeClock(t, 1000);
  const { service, sent, modes } = make(t);
  const late = await service.send('A', req('late'));
  const matched = await service.send('A', req('matched'));
  clock.advance(hold.HOLD_MS - 1);
  await hold.sweepHeld(service);
  assert.equal(service.get('A', late.id).delivery, 'held', 'nothing changes while the modes still differ');
  modes.A = 'full-access';
  // one is answered while the sweep awaits the other's release
  service.gate = async () => {
    service.gate = () => null;
    hold.declineHeld(service, 'B', late.id);
    return null;
  };
  await hold.sweepHeld(service);
  assert.equal(service.get('A', matched.id).delivery, 'queued');
  assert.equal(service.get('A', late.id).delivery, 'declined');
  assert.equal(sent.length, 1);
  modes.A = 'default';
  const expiring = await service.send('A', req('expiring'));
  clock.advance(hold.HOLD_MS);
  await hold.sweepHeld(service);
  assert.equal(service.get('A', expiring.id).delivery, 'expired');
  assert.equal(service.get('A', expiring.id).errorCode, 'hold_expired');
});

test('an Allow awaiting its gate is not expired under the user by a sweep', async (t) => {
  const clock = useFakeClock(t, 0);
  const { service } = make(t);
  const m = await service.send('A', req('r1'));
  clock.advance(hold.HOLD_MS);
  let release: (v: null) => void = () => {};
  service.gate = () => new Promise((resolve) => (release = resolve));
  const allowing = hold.approveHeld(service, 'B', m.id);
  await hold.sweepHeld(service);
  release(null);
  assert.equal((await allowing).delivery, 'queued');
});

test('a held message stays held when the modes part again during its release, and a closed chat blocks it', async (t) => {
  const { service, modes } = make(t);
  const m = await service.send('A', req('r1'));
  modes.A = 'full-access';
  service.gate = async () => {
    modes.A = 'default';
    return null;
  };
  await hold.sweepHeld(service);
  assert.equal(service.get('A', m.id).delivery, 'held');
  assert.equal(service.data.messages.length, 1);
  modes.A = 'full-access';
  service.gate = async () => 'chat_archived';
  await hold.sweepHeld(service);
  assert.deepEqual([service.get('A', m.id).delivery, service.get('A', m.id).errorCode], ['blocked', 'chat_archived']);
});

test('a receiver that turns on Full access while a message waits in its queue holds it at dispatch', async (t) => {
  const { service, sent, modes } = make(t, { A: 'default', B: 'default' });
  const m = await service.send('A', req('r1'));
  assert.equal(m.delivery, 'queued');
  modes.B = 'full-access';
  await assert.rejects(
    service.beforeDispatch({ chatId: 'B', kind: 'start', item: sent[0].item, ref: { id: 'native-B', kind: 'claude' } }),
    /held_mode_mismatch/,
  );
  assert.equal(service.get('A', m.id).delivery, 'held');
  // the controller's failed-dispatch report leaves the hold in place
  service.result({ item: sent[0].item, result: { started: false, error: 'held_mode_mismatch' } });
  assert.equal(service.get('A', m.id).delivery, 'held');
});

test('a held message survives a restart as held, and counts toward the receiver’s queue', async (t) => {
  const { service, create } = make(t);
  const m = await service.send('A', req('r1'));
  const reopened = create();
  assert.equal(reopened.startupError, undefined);
  assert.equal(reopened.get('A', m.id).delivery, 'held');
  for (const delivery of ['declined', 'expired']) {
    reopened.data.messages[0].delivery = delivery;
    reopened.commit(reopened.data);
    assert.equal(create().get('A', m.id).delivery, delivery);
  }
  reopened.data.messages = Array.from({ length: 100 }, () => ({ ...m, id: crypto.randomUUID(), dedupeKey: crypto.randomUUID() }));
  await assert.rejects(reopened.send('A', req('overflow')), /queue_full/);
});
