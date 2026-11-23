// Phone push controller: permission, registration, drains, tap routing and sign-out, over a fake runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatRef } from '../mobile/src/push/chatRef';
import { DEFAULT_PREFS } from '../mobile/src/push/prefs';
import { createPushController } from '../mobile/src/push/controller';
import { controllerRig, defer, tick } from './support/phone/push-controller-rig';

test('start enables registration only when permission is granted and a user is signed in', async () => {
  const granted = controllerRig();
  await granted.ctl.start();
  assert.equal(granted.ctl.ui().step, 'granted');
  assert.ok(granted.log.includes('enable'));
  const signedOut = controllerRig({ user: null });
  await signedOut.ctl.start();
  assert.equal(signedOut.log.includes('enable'), false);
  const explain = controllerRig({ step: 'explain' });
  await explain.ctl.start();
  assert.equal(explain.ctl.ui().step, 'explain');
  assert.equal(explain.log.includes('enable'), false);
  explain.ctl.stop();
  assert.deepEqual(explain.log.filter((l) => l.startsWith('off:')).length, 4);
  explain.ctl.stop();
});

test('accept asks the OS then registers; a refusal reads as blocked; later records Not now', async () => {
  const yes = controllerRig({ step: 'explain' });
  await yes.ctl.start();
  const seen: boolean[] = [];
  yes.ctl.subscribe(() => seen.push(yes.ctl.ui().busy));
  await yes.ctl.accept();
  assert.equal(yes.ctl.ui().step, 'granted');
  assert.deepEqual(seen.includes(true), true);
  assert.equal(yes.ctl.ui().busy, false);
  assert.ok(yes.log.includes('enable'));
  const no = controllerRig({ step: 'explain' });
  await no.ctl.start();
  no.gate.accept = 'denied';
  await no.ctl.accept();
  assert.equal(no.ctl.ui().step, 'blocked');
  assert.equal(no.log.includes('enable'), false);
  await no.ctl.later();
  assert.equal(no.ctl.ui().step, 'later');
  assert.ok(no.log.includes('dismiss'));
  const out = controllerRig({ step: 'explain', user: null });
  await out.ctl.start();
  await out.ctl.accept();
  assert.equal(out.log.includes('enable'), false);
});

test('a push or a foreground drains an offline mailbox by reconnecting the last computer, and leaves an online phone alone', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  await r.ctl.start();
  r.state.selectedPair = 'p_b';
  r.emit();
  r.state.selectedPair = null;
  r.state.phase = 'offline';
  r.handlers.push({});
  await tick();
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('connect')),
    ['connect:p_b'],
  );
  r.handlers.fg();
  await tick();
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('connect')),
    ['connect:p_b'],
  );
  assert.equal(r.state.phase, 'online');
  const noPair = controllerRig({ pairs: [] });
  await noPair.ctl.start();
  noPair.handlers.push({});
  await tick();
  assert.equal(
    noPair.log.some((l) => l.startsWith('connect')),
    false,
  );
  const out = controllerRig({ user: null });
  await out.ctl.start();
  out.handlers.push({});
  await tick();
  assert.equal(
    out.log.some((l) => l.startsWith('connect')),
    false,
  );
  const first = controllerRig({ pairs: ['p_a'] });
  await first.ctl.start();
  first.handlers.push({});
  await tick();
  assert.deepEqual(
    first.log.filter((l) => l.startsWith('connect')),
    ['connect:p_a'],
  );
});

test('a relay that comes up syncs the token; vanished pairs prune their title keys', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.log.length = 0;
  r.state.phase = 'online';
  r.emit();
  r.emit();
  assert.deepEqual(
    r.log.filter((l) => l === 'sync'),
    ['sync'],
  );
  r.state.pairs = [];
  r.emit();
  assert.ok(r.log.includes('prune:'));
  const gone = controllerRig({ step: 'explain' });
  await gone.ctl.start();
  gone.state.phase = 'online';
  gone.emit();
  assert.equal(gone.log.includes('sync'), false);
});

test('tapping a notification connects, finds the chat by ref and publishes the target once', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  await r.ctl.start();
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_b', 'c7'), count: 1 });
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_b', chatId: 'c7' });
  r.ctl.consumeTarget();
  assert.equal(r.ctl.ui().target, null);
  r.handlers.tap({ kind: 'done', ref: 'no-such-ref', count: 1 });
  await tick();
  await tick();
  assert.equal(r.ctl.ui().target, null);
  const out = controllerRig({ user: null });
  await out.ctl.start();
  out.handlers.tap({ kind: 'done', ref: 'x', count: 1 });
  await tick();
  assert.equal(out.ctl.ui().target, null);
});

test('the tap that launches the app waits for the runtime to read its account, then routes; a signed-out phone and a newer tap drop it', async () => {
  const r = controllerRig({ user: null, phase: 'loading', pairs: ['p_a', 'p_b'] });
  await r.ctl.start();
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_b', 'c7'), count: 1 });
  await tick();
  assert.equal(r.ctl.ui().target, null, 'nothing routes while the account is still being read');
  // a change that leaves the runtime still loading does not release it
  r.emit();
  await tick();
  assert.equal(r.ctl.ui().target, null);
  r.state.user = { id: 'u' };
  r.state.phase = 'offline';
  r.emit();
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_b', chatId: 'c7' });
  const out = controllerRig({ user: null, phase: 'loading' });
  await out.ctl.start();
  out.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 });
  out.state.phase = 'signedOut';
  out.emit();
  await tick();
  await tick();
  assert.equal(out.ctl.ui().target, null);
  const newer = controllerRig({ user: null, phase: 'loading' });
  await newer.ctl.start();
  newer.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 });
  newer.handlers.tap({ kind: 'done', ref: 'no-such-ref', count: 1 });
  newer.state.user = { id: 'u' };
  newer.state.phase = 'offline';
  newer.emit();
  await tick();
  await tick();
  assert.equal(newer.ctl.ui().target, null, 'the older tap does not route once a newer one has replaced it');
});

test('a computer that answers without a chat list yields no target', async () => {
  const r = controllerRig();
  r.reply.use = true;
  r.reply.value = null;
  await r.ctl.start();
  r.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 });
  await tick();
  await tick();
  assert.equal(r.ctl.ui().target, null);
  r.reply.value = {};
  r.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 });
  await tick();
  await tick();
  assert.equal(r.ctl.ui().target, null);
});

test('a newer tap supersedes an older one that is still searching', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  const hold = defer();
  r.gates.p_a = hold.promise;
  await r.ctl.start();
  r.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 });
  await tick();
  r.handlers.tap({ kind: 'done', ref: chatRef('p_b', 'c7'), count: 1 });
  await tick();
  hold.resolve();
  await tick();
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_b', chatId: 'c7' });
});

test('sign-out removes the token first, never waits longer than the bound, and cancels pending taps', async () => {
  const r = controllerRig();
  await r.ctl.start();
  await r.ctl.signOut();
  assert.deepEqual(r.log.slice(-4), ['disable', 'forget', 'signOut', 'prune:']);
  const slow = controllerRig();
  await slow.ctl.start();
  slow.gate.disable = new Promise(() => {});
  const started = Date.now();
  await slow.ctl.signOut();
  assert.ok(Date.now() - started < 1000);
  assert.equal(slow.log.at(-2), 'signOut');
  const defaults = createPushController({
    runtime: {
      snapshot: () => ({ user: null, pairs: [], phase: 'signedOut', selectedPair: null }),
      subscribe: () => () => {},
      signOut: async () => {},
    } as any,
    permission: { step: async () => 'unknown', accept: async () => 'denied', dismiss: async () => {} },
    prefs: { read: async () => DEFAULT_PREFS, write: async () => {} },
    registration: { enable: async () => {}, disable: async () => {}, sync: async () => {}, forget: async () => {} },
    titleKeys: { prune: async () => {}, save: async () => {} },
    taps: () => () => {},
    pushes: () => () => {},
    foreground: () => () => {},
  });
  await defaults.signOut();
});

test('sign-out runs the before-sign-out work with the token removal, while the session still authenticates, and a failure of it does not stop the sign-out', async () => {
  const order: string[] = [];
  const make = (before: () => Promise<unknown>) =>
    createPushController({
      runtime: {
        snapshot: () => ({ user: null, pairs: [], phase: 'signedOut', selectedPair: null }),
        subscribe: () => () => {},
        signOut: async () => void order.push('signOut'),
      } as any,
      permission: { step: async () => 'unknown', accept: async () => 'denied', dismiss: async () => {} },
      prefs: { read: async () => DEFAULT_PREFS, write: async () => {} },
      registration: {
        enable: async () => {},
        disable: async () => void order.push('disable'),
        sync: async () => {},
        forget: async () => {},
      },
      titleKeys: { prune: async () => {}, save: async () => {} },
      taps: () => () => {},
      pushes: () => () => {},
      foreground: () => () => {},
      beforeSignOut: before,
    });
  await make(async () => void order.push('activity')).signOut();
  assert.deepEqual(order.slice(0, 2).sort(), ['activity', 'disable']);
  assert.equal(order.at(-1), 'signOut');
  order.length = 0;
  await make(async () => {
    throw new Error('relay unreachable');
  }).signOut();
  assert.deepEqual(order, ['disable', 'signOut']);
});

test('signing in after start registers, a second account forgets the first, and sign-out forgets the token', async () => {
  const r = controllerRig({ user: null });
  await r.ctl.start();
  assert.equal(r.log.includes('enable'), false);
  r.state.user = { id: 'a' };
  r.emit();
  await tick();
  assert.deepEqual(
    r.log.filter((l) => l === 'enable' || l === 'forget'),
    ['enable'],
  );
  r.emit();
  await tick();
  assert.equal(r.log.filter((l) => l === 'enable').length, 1);
  r.state.user = { id: 'b' };
  r.emit();
  await tick();
  assert.deepEqual(
    r.log.filter((l) => l === 'enable' || l === 'forget'),
    ['enable', 'forget', 'enable'],
  );
  await r.ctl.signOut();
  assert.deepEqual(r.log.slice(-4), ['disable', 'forget', 'signOut', 'prune:']);
  r.state.user = { id: 'b' };
  r.emit();
  await tick();
  assert.equal(r.log.filter((l) => l === 'enable').length, 3);
});

test('the title key event of the selected pair is stored; malformed, foreign or unselected events are ignored', async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  r.prefsBox.value = { ...DEFAULT_PREFS, titles: true };
  await r.ctl.start();
  const key = `01${'ab'.repeat(30)}ff`;
  const event = (patch: unknown, extra: object = {}) => ({ kind: 'event', ev: 'push.titleKey', patch, ...extra });
  r.handlers.event(event({ key }));
  await tick();
  assert.equal(
    r.log.some((l) => l.startsWith('save')),
    false,
    'no pair is selected yet',
  );
  r.state.selectedPair = 'p_a';
  r.handlers.event(event({ key }));
  await tick();
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('save')),
    ['save:p_a:32:1:255'],
  );
  for (const bad of [
    event({ key: key.toUpperCase() }),
    event({ key: key.slice(2) }),
    event({ key: 5 }),
    event(undefined),
    event({ key }, { ev: 'session.patch' }),
    event({ key }, { kind: 'reply' }),
  ])
    r.handlers.event(bad);
  await tick();
  assert.equal(r.log.filter((l) => l.startsWith('save')).length, 1);
  r.gate.saveFails = true;
  r.handlers.event(event({ key }));
  await tick();
  assert.equal(r.log.filter((l) => l.startsWith('save')).length, 2);
});

test('a sign-out during an account switch wins: the switch does not register the signed-out account', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.gate.forget = new Promise(() => {});
  r.state.user = { id: 'b' };
  r.emit();
  await tick();
  assert.equal(r.log.filter((l) => l === 'enable').length, 1, 'still waiting to forget the first account');
  r.gate.forget = null;
  await r.ctl.signOut();
  await tick();
  assert.equal(r.log.filter((l) => l === 'enable').length, 1);
});

test('a session that ends outside sign-out forgets the remembered token so the next sign-in registers', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.state.user = null;
  r.emit();
  await tick();
  assert.equal(r.log.filter((l) => l === 'forget').length, 1);
  r.emit();
  assert.equal(r.log.filter((l) => l === 'forget').length, 1);
  r.state.user = { id: 'a' };
  r.emit();
  await tick();
  assert.equal(r.log.filter((l) => l === 'enable').length, 2);
});

test('an account switch superseded by another switch while forgetting does not register the stale account', async () => {
  const r = controllerRig();
  await r.ctl.start();
  const hold = defer();
  r.gate.forget = hold.promise;
  r.state.user = { id: 'b' };
  r.emit();
  await tick();
  r.state.user = { id: 'c' };
  r.emit();
  await tick();
  hold.resolve();
  await tick();
  await tick();
  assert.equal(r.log.filter((l) => l === 'enable').length, 2, 'the first account, then only the latest one');
});

test('a push drains only an idle offline or failed phone: never over a pairing, a cleanup, a first connect or a loading app', async () => {
  for (const patch of [{ phase: 'ready' }, { phase: 'pairing' }, { phase: 'loading' }, { pendingPair: true }, { pairCleanup: true }]) {
    const r = controllerRig();
    await r.ctl.start();
    Object.assign(r.state, patch);
    r.handlers.push({});
    await tick();
    assert.equal(
      r.log.some((l) => l.startsWith('connect')),
      false,
      JSON.stringify(patch),
    );
  }
  const failed = controllerRig();
  await failed.ctl.start();
  failed.state.phase = 'error';
  failed.handlers.push({});
  await tick();
  assert.equal(failed.log.filter((l) => l.startsWith('connect')).length, 1);
});

test('a failed background drain backs off, so a storm of pushes does not reconnect each time; success clears the backoff', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.connectFail.on = true;
  r.handlers.push({});
  await tick();
  r.handlers.push({});
  await tick();
  assert.equal(r.log.filter((l) => l.startsWith('connect')).length, 1);
  r.clock.t += 31_000;
  r.connectFail.on = false;
  r.handlers.push({});
  await tick();
  assert.equal(r.log.filter((l) => l.startsWith('connect')).length, 2);
  r.state.phase = 'offline';
  r.handlers.push({});
  await tick();
  assert.equal(r.log.filter((l) => l.startsWith('connect')).length, 3, 'a success leaves no backoff');
});

test('a typed reply becomes a draft on the tapped chat only; an offline notice and a plain tap carry none', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  await r.ctl.start();
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_b', 'c7'), count: 1 }, 'looks good');
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_b', chatId: 'c7', draft: 'looks good' });
  r.ctl.consumeTarget();
  r.handlers.tap({ kind: 'machineOffline', ref: 'p_a', count: 1 }, 'ignored');
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_a' });
  r.ctl.consumeTarget();
  r.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 });
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_a', chatId: 'c1' });
});

test('a reply for a chat that cannot be found shows a notice instead of vanishing, and the notice clears with the next tap result', async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  await r.ctl.start();
  r.handlers.tap({ kind: 'done', ref: 'no-such-chat-ref', count: 1 }, 'lost text');
  await tick();
  await tick();
  assert.match(r.ctl.ui().notice ?? '', /reply was not kept/);
  assert.equal(r.ctl.ui().target, null);
  r.handlers.tap({ kind: 'done', ref: 'no-such-chat-ref', count: 1 });
  await tick();
  await tick();
  assert.match(r.ctl.ui().notice ?? '', /reply was not kept/, 'a tap without a reply leaves the notice alone');
  r.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 });
  await tick();
  await tick();
  assert.equal(r.ctl.ui().notice, null);
  r.ctl.consumeTarget();
});

test('two replies for the chat of a still-pending tap join in order; a different chat replaces it', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  await r.ctl.start();
  r.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 }, 'one');
  await tick();
  await tick();
  r.handlers.tap({ kind: 'done', ref: chatRef('p_a', 'c1'), count: 1 }, 'two');
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_a', chatId: 'c1', draft: 'one\ntwo' });
  r.handlers.tap({ kind: 'done', ref: chatRef('p_b', 'c7'), count: 1 }, 'three');
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_b', chatId: 'c7', draft: 'three' });
  r.handlers.tap({ kind: 'machineOffline', ref: 'p_a', count: 1 });
  await tick();
  await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_a' });
});

test('the token status the registration reports is part of the push state, and stops being heard after stop', async () => {
  const r = controllerRig();
  await r.ctl.start();
  assert.equal(r.ctl.ui().token, null);
  r.setStatus('waiting');
  assert.equal(r.ctl.ui().token, 'waiting');
  r.setStatus('registered');
  assert.equal(r.ctl.ui().token, 'registered');
  r.setStatus(null);
  assert.equal(r.ctl.ui().token, null);
  r.ctl.stop();
  assert.equal(r.statusListeners.size, 0);
  const plain = controllerRig({ noStatus: true });
  await plain.ctl.start();
  assert.equal(plain.ctl.ui().token, null, 'a registration that reports no status leaves it empty');
  plain.ctl.stop();
});
