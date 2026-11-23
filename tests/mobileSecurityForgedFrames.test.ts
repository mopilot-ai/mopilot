// Security review of Mobile Remote (exploit-style): a frame anyone can forge must not end a pair's session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SKIP } from '../shared/remote/crypto.mjs';
import { drain, request, rig, wireOf } from './support/remoteChannelRig.ts';

test('one forged frame with a far-ahead counter and no valid tag does not close the pair’s session', async () => {
  const r = await rig();
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  const forged = { ...wireOf(r.phone, request('real')), ctr: MAX_SKIP + 10 };
  r.relay.emit('frame', forged);
  await drain(r);
  assert.deepEqual(closed, [], 'a forged frame closed the session: it stays closed until the app restarts');
  // the phone's own next frame still gets through
  r.relay.emit('frame', wireOf(r.phone, request('after')));
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['after'],
  );
});

test('the same forged frame cannot be replayed into a session that does not ack (replay and rewind)', async () => {
  const r = await rig();
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  const first = wireOf(r.phone, request('one'));
  r.relay.emit('frame', first);
  await drain(r);
  // a relay without acks may redeliver anything it recorded
  r.relay.emit('frame', first);
  await drain(r);
  assert.deepEqual(closed, [], 'a recorded frame played again closed the session');
});
