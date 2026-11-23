// Security review of Mobile Remote: a signed-in Mac may not fill the relay's database with pairs nobody joins.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeHub } from './support/relayKit.ts';
import { MAX_PENDING_PAIRS, PENDING_PAIR_KEEP_MS } from '../relay/src/store.mjs';

const { db, reset } = await makeDb();
beforeEach(reset);
const pair = (n: number) => `p_pending${String(n).padStart(4, '0')}`;

test('a Mac cannot register more unjoined pairs than a person could scan', async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  for (let i = 0; i < MAX_PENDING_PAIRS; i++) {
    await mac.say({ t: 'pair.register', pair: pair(i), rid: `r${i}` });
    assert.equal(mac.socket.last().t, 'ok', `pair ${i}`);
  }
  await mac.say({ t: 'pair.register', pair: pair(MAX_PENDING_PAIRS), rid: 'over' });
  assert.equal(mac.socket.last().code, 'pair_limit');
  assert.equal(await r.store.getPair(pair(MAX_PENDING_PAIRS)), null);
  // registering one of them again is a refresh, not a new pair
  await mac.say({ t: 'pair.register', pair: pair(0), rid: 'again' });
  assert.equal(mac.socket.last().t, 'ok');
  // another Mac has its own allowance
  const other = await r.join('u1', 'mac2', 'desktop');
  // a pair id somebody else holds is taken, not a limit
  await other.say({ t: 'pair.register', pair: pair(0), rid: 'taken' });
  assert.equal(other.socket.last().code, 'pair_exists');
  await other.say({ t: 'pair.register', pair: 'p_other0001', rid: 'o' });
  assert.equal(other.socket.last().t, 'ok');
  // pairs whose join window has passed free their places
  r.clock.advance(r.hub.config.pairJoinMs + 1);
  await mac.say({ t: 'pair.register', pair: pair(MAX_PENDING_PAIRS), rid: 'later' });
  assert.equal(mac.socket.last().t, 'ok');
});

test('the sweep forgets pairs nobody joined, and keeps joined ones', async () => {
  const r = makeHub(db);
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: 'p_joined001' });
  await phone.say({ t: 'pair.join', pair: 'p_joined001' });
  await mac.say({ t: 'pair.register', pair: 'p_unjoined1' });
  r.clock.advance(r.hub.config.pairJoinMs + PENDING_PAIR_KEEP_MS - 1);
  await r.hub.sweep();
  assert.ok(await r.store.getPair('p_unjoined1'), 'kept while a late join can still be explained');
  r.clock.advance(2);
  await r.hub.sweep();
  assert.equal(await r.store.getPair('p_unjoined1'), null);
  assert.ok(await r.store.getPair('p_joined001'));
});
