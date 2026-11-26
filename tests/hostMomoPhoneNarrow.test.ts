// What a paired phone may do of MoMo's home through the Host's real entry: it is refused starting a home, moving it, standing one down and resetting (those stay with the Mac), and a lane intent only runs for the kinds its screens send (never a rule switched on or off); the owner's desktop is not narrowed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { PHONE_LANE_KINDS } from '../host/src/phoneMomoNarrow.mjs';
import { handedOff } from '../mobile/src/momoPhone/phoneHome/handOff.ts';
import { servedHost } from './support/hostClientsWorld.ts';
import { MOMO, studio } from './support/host/momoMoveWorld.ts';

/** A served Host running a home, a phone and a desktop paired to it, each with its grant. */
async function served(t: any) {
  const a = await studio(t);
  const w = await servedHost(t, { momo: a.home });
  const id = w.identity('phone');
  w.pairing.add(id.publicKey, { name: 'Phone', kind: 'phone' });
  const phone = await w.reconnect(id);
  const { conn: mac } = await w.paired('mac', 'Mac');
  for (const c of [phone, mac]) await c.request('host.momoGrant', { account: 'a1', features: MOMO });
  return { a, phone, mac };
}
/** What a call came to: its refusal code and words, or `ok`. */
const outcome = async (conn: any, method: string, params: object) => {
  try {
    const r = await conn.request(method, params);
    return { ok: true, r } as any;
  } catch (error: any) {
    return { ok: false, code: error?.code, message: String(error?.message ?? error) } as any;
  }
};
const forbidden = (o: any) => o.ok === false && o.code === 'forbidden' && /This phone may not do that/.test(o.message);

test('a phone is refused starting a home, moving it, standing one down and resetting, in every form; the owner’s desktop is not', async (t) => {
  const { phone, mac } = await served(t);
  const forms: [string, object][] = [
    ['host.momoReset', {}],
    ['host.momoReset', { ifRetired: true, expectEpoch: 1 }],
    ['host.momoStandDown', { homeId: 'x', leaseEpoch: 2 }],
    ['host.momoHomeStart', { homeId: 'x', name: 'Phone', floor: 99 }],
    ['host.momoMove', { op: 'begin', moveId: 'move-0001' }],
    ['host.momoMove', { op: 'seal', moveId: 'move-0001' }],
  ];
  for (const [method, params] of forms) assert.ok(forbidden(await outcome(phone, method, params)), `${method} ${JSON.stringify(params)}`);
  // nothing was changed: the home still runs, and the desktop's own reset still works
  assert.equal((await outcome(mac, 'host.momoReset', {})).ok, true);
});

test('a phone runs only the lane kinds its screens send; anything else in the registry is refused as a phone, and the desktop is not narrowed', async (t) => {
  const { phone, mac } = await served(t);
  // kinds the registry has that no phone screen sends
  for (const kind of ['rule.add', 'rule.edit', 'rule.accept', 'signal.make', 'signal.ignore', 'rule.turnOn', 'rule.turnOff', 'rule.undo']) {
    const o = await outcome(phone, 'host.momoLaneIntent', { intent: { kind } });
    assert.ok(forbidden(o), `${kind} ${JSON.stringify(o)}`);
  }
  // a kind the table does not know is refused by the request's own parser, whoever asks
  for (const kind of ['constructor', 'nonsense'])
    assert.equal((await outcome(phone, 'host.momoLaneIntent', { intent: { kind } })).ok, false, kind);
  // a kind it sends is not refused as a phone (what the registry answers is the lane's own business)
  for (const kind of ['task.check', 'approval.send', 'settings.set'])
    assert.equal(forbidden(await outcome(phone, 'host.momoLaneIntent', { intent: { kind } })), false, kind);
  assert.equal(forbidden(await outcome(mac, 'host.momoLaneIntent', { intent: { kind: 'rule.add' } })), false);
});

test('the lane kinds a phone may run are the dotted kinds mobile/src/momoPhone/wire.ts sends, less the rule switches the phone hands to the Mac', () => {
  const wire = fs.readFileSync(new URL('../mobile/src/momoPhone/wire.ts', import.meta.url), 'utf8');
  const sent = [...new Set([...wire.matchAll(/['"]([a-z]+\.[A-Za-z]+)['"]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(
    [...PHONE_LANE_KINDS].sort(),
    sent.filter((k) => !['rule.turnOn', 'rule.turnOff', 'rule.undo'].includes(k)),
  );
  // the three the phone does not run are the ones it hands off (mobile/src/momoPhone/phoneHome/handOff.ts)
  for (const kind of ['rule.turnOn', 'rule.turnOff', 'rule.undo']) assert.equal(handedOff({ kind }), true, kind);
});
