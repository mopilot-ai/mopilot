// Stale push state after unpair, re-pair, account change and sign-out: title keys, pending taps and remembered tokens.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatRef } from '../mobile/src/push/chatRef';
import { createPushRegistration } from '../mobile/src/push/registration';
import { controllerRig, tick } from './support/phone/push-controller-rig';

// the prune that names no pair is the start's removal of keys while titles are off, counted apart
const prunes = (log: string[]) => log.filter((l) => l.startsWith('prune:') && l !== 'prune:');

test('the first signed-in snapshot drops the keys of pairs removed while the app was closed, once per start', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  await r.ctl.start();
  assert.deepEqual(prunes(r.log), ['prune:p_a,p_b']);
  r.emit();
  await tick();
  assert.equal(prunes(r.log).length, 1, 'later snapshots with the same pairs prune nothing');
  await r.ctl.start();
  assert.equal(prunes(r.log).length, 2, 'a restarted controller checks again');
  const loading = controllerRig({ pairs: [] });
  loading.state.phase = 'loading';
  await loading.ctl.start();
  assert.deepEqual(prunes(loading.log), [], 'nothing is pruned before the pairs are loaded');
  const signedOut = controllerRig({ user: null });
  await signedOut.ctl.start();
  assert.deepEqual(prunes(signedOut.log), []);
});

test('an unpaired computer takes its pending tap target and its keys with it; a re-paired one is a new pair', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  await r.ctl.start();
  r.state.phase = 'offline';
  r.handlers.tap({ kind: 'done', ref: chatRef('p_b', 'c7'), count: 1 });
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_b', chatId: 'c7' });
  r.state.selectedPair = null;
  r.state.pairs = [{ pairId: 'p_a', macId: 'm' }];
  r.emit();
  await tick();
  assert.equal(r.ctl.ui().target, null, 'a target for a removed computer is dropped');
  assert.ok(r.log.includes('prune:p_a'));
  r.state.pairs = [
    { pairId: 'p_a', macId: 'm' },
    { pairId: 'p_b2', macId: 'm' },
  ];
  r.emit();
  await tick();
  assert.equal(prunes(r.log).length, 2, 'adding a pair prunes nothing');
});

test('another account on the same phone starts without the previous account’s title keys, and so does a sign-out', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.log.length = 0;
  r.state.user = { id: 'b' };
  r.emit();
  await tick();
  await tick();
  assert.deepEqual(
    r.log.filter((l) => l === 'forget' || l.startsWith('prune:') || l === 'enable'),
    ['forget', 'prune:p_a', 'enable'],
    'the prune keeps the keys of computers the new account already has',
  );
  r.log.length = 0;
  await r.ctl.signOut();
  assert.deepEqual(r.log.slice(-3), ['forget', 'signOut', 'prune:']);
});

test('a tap whose computer was unpaired while its chats were being read publishes nothing', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  const { defer } = await import('./support/phone/push-controller-rig');
  const hold = defer();
  r.gates.p_b = hold.promise;
  await r.ctl.start();
  r.state.phase = 'offline';
  r.handlers.tap({ kind: 'done', ref: chatRef('p_b', 'c7'), count: 1 });
  await tick();
  r.state.pairs = [{ pairId: 'p_a', macId: 'm' }];
  hold.resolve();
  await tick();
  await tick();
  assert.equal(r.ctl.ui().target, null);
});

test('a computer paired again after the last one went registers the token from scratch, even though the phone remembers it as registered', async () => {
  const relay = { held: null as string | null, calls: 0 };
  const registration = createPushRegistration({
    relay: {
      register: async (_platform, token) => void (relay.calls++, (relay.held = token)),
      unregister: async () => void (relay.held = null),
    },
    tokens: { platform: 'apns', get: async () => 'T1', onRefresh: () => () => undefined },
    store: { read: async () => null, write: async () => undefined },
  });
  const r = controllerRig({ pairs: ['p_a', 'p_b'], registration });
  await r.ctl.start();
  await tick();
  assert.equal(relay.held, 'T1', 'signed in with a computer: the token is registered');
  r.state.pairs = [{ pairId: 'p_a', macId: 'm' }];
  r.emit();
  await tick();
  assert.equal(relay.calls, 1, 'one computer left: the relay still holds the token, nothing is sent');
  r.state.pairs = [];
  r.emit();
  await tick();
  relay.held = null; // the relay drops the token with the last computer
  await registration.sync(); // the app coming back to the front while no computer is paired
  relay.held = null; // ...and a late removal on the relay deletes what that sync registered
  r.state.pairs = [{ pairId: 'p_c', macId: 'm' }];
  r.emit();
  await tick();
  await tick();
  assert.equal(relay.held, 'T1', 'the new computer finds the token on the relay');
  const calls = relay.calls;
  r.state.pairs = [
    { pairId: 'p_c', macId: 'm' },
    { pairId: 'p_d', macId: 'm' },
  ];
  r.emit();
  await tick();
  assert.equal(relay.calls, calls, 'a second computer needs no new registration');
});

test('the token is registered again for a returning computer only when it is wanted: signed in, loaded, allowed, and not at start', async () => {
  const start = controllerRig({ pairs: [] });
  await start.ctl.start();
  assert.ok(!start.log.includes('forget') && !start.log.includes('sync'), 'a phone that starts with no computer decides nothing');
  const rig = (over: object) => controllerRig({ pairs: ['p_a'], ...over });
  const cases: Array<[string, (r: ReturnType<typeof rig>) => void]> = [
    ['signed out', (r) => (r.state.user = null)],
    ['pairs still loading', (r) => (r.state.phase = 'loading')],
  ];
  for (const [name, change] of cases) {
    const r = rig({});
    await r.ctl.start();
    r.state.pairs = [];
    r.emit();
    await tick();
    r.log.length = 0;
    change(r);
    r.state.pairs = [{ pairId: 'p_b', macId: 'm' }];
    r.emit();
    await tick();
    assert.ok(!r.log.includes('sync'), name);
  }
  const later = rig({ step: 'later' });
  await later.ctl.start();
  later.state.pairs = [];
  later.emit();
  await tick();
  later.state.pairs = [{ pairId: 'p_b', macId: 'm' }];
  later.emit();
  await tick();
  assert.ok(!later.log.includes('sync'), 'without notification permission nothing registers');
});
