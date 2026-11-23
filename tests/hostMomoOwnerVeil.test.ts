// Who may act on MoMo's home on a Host: every method that changes it or shows its data beyond the status is the owner's own devices only (a paired desktop or phone), never the local CLI (any process on the machine), a narrower kind of client or an unpaired connection; the chat veil treats those as strangers too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import methods from '../host/src/methods/momo.mjs';
// @ts-ignore
import { isOwner } from '../host/src/momoOwner.mjs';
// @ts-ignore
import { createMomoChats } from '../host/src/momoChats.mjs';

const OWNER_ONLY = ['host.momoGrant', 'host.momoHomeStart', 'host.momoChat', 'host.momoTurn', 'host.momoMove', 'host.momoReset'];
const veils = (granted: boolean) =>
  methods({ momo: { granted: () => granted, stamp: () => null } as any }).veils as Record<string, (p: unknown) => boolean>;
const who = (kind: string) => ({ fingerprint: `fp-${kind}`, name: kind, kind });

test('each state-changing MoMo method is the owner’s devices only: the CLI, a narrow home kind, an unpaired connection and a device without the grant are refused', () => {
  const live = veils(true);
  for (const method of OWNER_ONLY) {
    for (const kind of ['desktop', 'phone']) assert.equal(live[method](who(kind)), true, `${method} for ${kind}`);
    for (const kind of ['cli', 'home', 'unknown']) assert.equal(live[method](who(kind)), false, `${method} for ${kind}`);
    for (const none of [null, undefined]) assert.equal(live[method](none), false, `${method} for an unpaired connection`);
    assert.equal(live[method]({ fingerprint: 'f' }), false, `${method} for a principal with no kind`);
  }
  // without a live grant only the grant itself is open, and still only to the owner's devices
  const none = veils(false);
  for (const method of OWNER_ONLY.filter((m) => m !== 'host.momoGrant'))
    assert.equal(none[method](who('desktop')), false, `${method} with no grant`);
  assert.equal(none['host.momoGrant'](who('desktop')), true);
  assert.equal(none['host.momoGrant'](who('cli')), false);
});

test('the status is the one thing the CLI may still read, and only while a grant is held', () => {
  assert.equal(veils(true)['host.momoStatus'](who('cli')), true);
  assert.equal(veils(false)['host.momoStatus'](who('cli')), false);
  assert.equal(veils(true)['host.momoStatus'](null), false);
});

test('the chat veil sees MoMo’s chats for the owner’s devices only', () => {
  assert.deepEqual(
    [isOwner(who('desktop')), isOwner(who('phone')), isOwner(who('cli')), isOwner(who('home')), isOwner(null), isOwner({})],
    [true, true, false, false, false, false],
  );
  const rules = createMomoChats({
    home: {
      granted: () => true,
      hostOnlyStorage: { dir: '/nonexistent-momo', safeStorage: null },
      stamp: () => null,
      stores: () => null,
      voided: () => false,
      watch: () => () => undefined,
      turnEnded: () => undefined,
    } as any,
    sessions: { chats: { records: new Map(), patchMeta: () => undefined }, isolated: () => true } as any,
    epochs: { current: () => 1 } as any,
    env: {},
  }).rules;
  assert.deepEqual(
    [rules.seen(who('desktop')), rules.seen(who('phone')), rules.seen(who('cli')), rules.seen(null)],
    [true, true, false, false],
  );
});
