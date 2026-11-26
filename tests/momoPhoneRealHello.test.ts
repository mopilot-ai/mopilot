// The Mac's REAL machine.hello (electron/remote/methods/read.cjs over the real gate, electron/momo/access.cjs) read by the phone's real reader (useMomoHome): an allowed account, an account the server said may not see MoMo, and every "unknown" (not loaded yet, offline, signed out, another Mac's account) stay apart, so a revoke is only ever a revoke.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { waitFor } from './support/waitFor.ts';
import { openPhoneHomeMemory } from '../mobile/src/momoPhone/phoneHome/memory';

const require = createRequire(import.meta.url);
const access = require('../electron/momo/access.cjs');
const read = require('../electron/remote/methods/read.cjs');
const hookPath = '../mobile/src/screens/momoPhone/useMomoHome';
const { useMomoHome, forgetMomoHomeAnswers } = await import(hookPath);

type Any = any;
const crypto = {
  key: async () => new Uint8Array(32).fill(5),
  randomBytes: (n: number) => new Uint8Array(n).fill(1),
  seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
    Uint8Array.from([...new TextEncoder().encode(`${aad}|`), ...plain]),
  open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) =>
    new TextDecoder().decode(box).startsWith(`${aad}|`) ? box.slice(aad.length + 1) : null,
};
const roots: { unmount: () => void; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) {
    await act(async () => r.unmount());
    r.host.remove();
  }
  access.openMomoAccess({ file: '/nonexistent/none.json', refresh: () => undefined, flagOn: () => false, feature: 'momo' }).dispose();
});

const account = (user: string | null, features: string[] | null, over: { flags?: boolean; checked?: boolean } = {}) => {
  const gate = access.openMomoAccess({
    file: '/nonexistent/momo-access.json',
    refresh: () => undefined,
    flagOn: () => true,
    waitForFlags: over.flags === false,
    timers: { set: () => 0, clear: () => undefined },
  });
  if (over.flags !== false) gate.flagsLoaded = true;
  gate.update({
    signedIn: user !== null,
    user: user ? { id: user, ...(features ? { features } : {}) } : null,
    ...(over.checked === false ? {} : { checkedAt: Date.now() }),
  });
  return gate;
};
/** The real hello the Mac gives right now. */
const helloNow = () =>
  read['machine.hello'](
    {
      version: '1.0.0',
      machineName: () => 'Mac',
      methodsFor: () => [],
      momoAllowed: access.momoAllowed,
      homeOffered: () => access.momoAllowed(),
      pushSettings: null,
      mirror: { available: () => false },
      policy: {},
      momo: () => null,
      ops: {},
      hostAllowed: () => false,
      transport: { sendLedger: { ready: async () => true } },
    },
    {},
  );

/** `invited`: the hint is on the phone BEFORE the screens mount, so the hook's own memory holds it: only then can a revoke it ignores or applies be seen. */
async function phone(hello: () => Promise<unknown>, user = 'u1', invited = false) {
  forgetMomoHomeAnswers();
  let held: string | null = null;
  const store = { read: async () => held, write: async (v: string) => void (held = v), clear: async () => void (held = null) };
  if (invited) {
    const before = await openPhoneHomeMemory({ store, crypto, user });
    before.invited.set(true);
    await before.settled();
  }
  const runtime: Any = {
    snapshot: () => ({ user: { id: user }, selectedPair: 'p1' }),
    subscribe: () => () => undefined,
    onEvent: () => () => undefined,
    request: async (method: string) => {
      if (method === 'machine.hello') return hello();
      throw new Error(`no ${method}`);
    },
  };
  const out: { last: Any } = { last: null };
  // one `open` for every render: a new one each time would reopen the memory each time
  const open = async () => ({ store, crypto, newId: () => 'tok-0001' });
  const Probe = () => ((out.last = useMomoHome(runtime, true, open, 30)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ unmount: () => root.unmount(), host });
  await act(async () => root.render(createElement(Probe)));
  for (let i = 0; i < 6; i++) await flush();
  const kept = async () => {
    const m = await openPhoneHomeMemory({ store, crypto, user });
    return { invited: m.invited.read() };
  };
  return {
    out,
    kept,
    again: async () => (out.last.retry(), await new Promise((r) => setTimeout(r, 60))),
  };
}

test('before any gate is open, and for a gate that has heard of no account, there is no revoke', () => {
  assert.equal(access.momoRevokedFor(), null);
  access.openMomoAccess({
    file: '/nonexistent/momo-access.json',
    refresh: () => undefined,
    flagOn: () => true,
    timers: { set: () => 0, clear: () => undefined },
  });
  assert.equal(access.momoRevokedFor(), null);
});

test('the real hello says momo: true with its account for an invited account, and the phone keeps the hint', async () => {
  account('u1', ['momo']);
  const hello = await helloNow();
  assert.deepEqual([hello.capabilities.momo, hello.capabilities.momoAccount], [true, 'u1']);
  const p = await phone(helloNow);
  await waitFor(async () => (await p.kept()).invited === true, 'the hint');
});

test('the real hello says momo: false when the server said the account is not invited, and only then the phone takes the hint away', async () => {
  account('u1', ['momo']);
  const p = await phone(helloNow);
  await waitFor(async () => (await p.kept()).invited === true, 'the hint');
  // the account is revoked while the phone is away: the Mac's next read of the account says so
  account('u1', []);
  const hello = await helloNow();
  assert.deepEqual([hello.capabilities.momo, hello.capabilities.momoAccount], [false, 'u1']);
  await p.again();
  await waitFor(async () => (await p.kept()).invited === false, 'the hint to go');
});

test('every unknown stays unknown: a gate not answered yet, a flag not loaded, offline, signed out, and another Mac account never read as a revoke', async () => {
  for (const [name, setup] of [
    ['the server has not answered in this run', () => account('u1', null, { checked: false })],
    ['the remote switches are not loaded yet', () => account('u1', ['momo'], { flags: false })],
    ['signed out', () => account(null, null)],
  ] as const) {
    setup();
    const hello = await helloNow();
    assert.equal('momo' in hello.capabilities && hello.capabilities.momo === false, false, `${name}: no revoke is said`);
    const p = await phone(async () => helloNow(), 'u1', true);
    await p.again();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await p.kept()).invited, true, `${name}: the hint stays`);
  }
  // a Mac signed in as another account that says no does not strip the hint of this phone's account
  account('other', []);
  const hello = await helloNow();
  assert.deepEqual([hello.capabilities.momo, hello.capabilities.momoAccount], [false, 'other']);
  const p = await phone(async () => helloNow(), 'u1', true);
  await p.again();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await p.kept()).invited, true, 'another account’s no changes nothing');
});

test('a gate open to every account, the dev stand-in for the invite and no account at all have no revoke to tell', () => {
  const open = (extra: object) => {
    const gate = access.openMomoAccess({
      file: '/nonexistent/momo-access.json',
      refresh: () => undefined,
      flagOn: () => true,
      timers: { set: () => 0, clear: () => undefined },
      ...extra,
    });
    gate.flagsLoaded = true;
    gate.update({ signedIn: true, user: { id: 'u1', features: [] }, checkedAt: Date.now() });
  };
  open({ feature: null });
  assert.equal(access.momoRevokedFor(), null);
  open({ feature: 'momo', devInvite: true });
  assert.equal(access.momoRevokedFor(), null);
  // for comparison: the same account on a gate that follows the MoMo invite is revoked
  open({ feature: 'momo' });
  assert.equal(access.momoRevokedFor(), 'u1');
});
