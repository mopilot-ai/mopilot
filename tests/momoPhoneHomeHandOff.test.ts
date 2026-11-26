// What only a Mac does, on the phone's own home: starting a home, picking where MoMo lives, every step of a move, taking it back, deleting or using an older MoMo, Start fresh, and a rule switched or undone each answer "Do this on your Mac." in place, send nothing to any Host, and leave the home as it was (keeping an older MoMo is the phone's own note and still works). A stolen phone cannot start, move, stand down or reset a home, whatever it is paired to.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixId } from '../shared/momoFixId.mjs';
import { handedOff } from '../mobile/src/momoPhone/phoneHome/handOff.ts';
import { world } from './support/momoHomeRealWorld.ts';
import { INTENT_METHOD, crypto, openPhoneHomeMemory, phoneOn, sealedStore } from './support/phone/phoneHomeRig.ts';

const FOUR = ['host.momoHomeStart', 'host.momoStandDown', 'host.momoMove', 'host.momoReset'];
const WORDS = 'Do this on your Mac.';

test('every intent that only a Mac does is refused in words, to any machine and in any form, and no request leaves the phone', async (t) => {
  const w = await world(t, { second: true });
  const store = sealedStore();
  const memory = await openPhoneHomeMemory({ store, crypto, user: 'u1' });
  memory.learn({ machineId: 'studio', homeId: 'home-studio-0001', name: 'Studio', leaseEpoch: 1 });
  await memory.settled();
  const p = await phoneOn(w, store);
  const ask = (intent: object) => p.home.channel.request(INTENT_METHOD, { intent }) as Promise<any>;
  const intents: object[] = [
    { kind: 'choose-home', machineId: 'studio' },
    { kind: 'choose-home', machineId: 'stranger' },
    { kind: 'move', toId: 'mini' },
    // a machine this phone is not paired to is no different: the phone moves nothing
    { kind: 'move', toId: 'ssh:thief@elsewhere' },
    { kind: 'move-cancel', moveId: 'm' },
    { kind: 'move-retry' },
    { kind: 'move-stay' },
    { kind: 'move-ack' },
    { kind: 'reclaim', moveId: 'm', toId: 'mini' },
    { kind: 'rule.turnOn', id: 'r1' },
    { kind: 'rule.turnOff', id: 'r1' },
    { kind: 'rule.undo', id: 'r1' },
    // the fixes of the view that start, delete or take back a home, asked and confirmed, for a machine id with colons too
    ...['use-older', 'use-older!', 'delete-older', 'delete-older!', 'start-fresh', 'start-fresh!'].flatMap((kind) => [
      { kind: 'fix', id: kind },
      { kind: 'fix', id: fixId(kind, 'studio') },
      { kind: 'fix', id: fixId(kind, 'tok', 'ssh:runner@localhost') },
    ]),
  ];
  for (const intent of intents) {
    const answer = await ask(intent);
    assert.deepEqual([answer.ok, answer.cause], [false, WORDS], JSON.stringify(intent));
  }
  assert.deepEqual(
    p.sent.filter((x) => FOUR.includes(x.method)),
    [],
    'nothing that only a Mac does was sent',
  );
  p.home.dispose();
});

test('keeping an older MoMo is the phone’s own note and still works', async (t) => {
  const w = await world(t, { second: true });
  const p = await phoneOn(w);
  const answer = (await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'fix', id: 'keep-older:nowhere' } })) as any;
  // refused as the shared rules refuse an older MoMo that is not offered, not handed off
  assert.equal(answer.ok, false);
  assert.notEqual(answer.cause, WORDS);
  p.home.dispose();
});

test('what is not an intent, a fix that cannot be read and the fixes the phone keeps are not handed off', () => {
  for (const raw of [
    undefined,
    {},
    { kind: 'fix' },
    { kind: 'fix', id: '%E0%A4%A' },
    { kind: 'fix', id: 'keep-older:studio' },
    { kind: 'send', text: 'hi' },
  ])
    assert.equal(handedOff(raw as any), false, JSON.stringify(raw));
});
