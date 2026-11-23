// MoMo's Google intents through the home's registry and API (shared/momoGoogle/intents.mjs, shared/momoIntents.mjs, shared/momoHomeApi.mjs): the table's three kinds against the real Google service of a home and a fake Google, with the refusals a screen shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHomeApi } from '../shared/momoHomeApi.mjs';
import { createIntentRegistry } from '../shared/momoIntents.mjs';
import { composeGoogle, googleViewOf } from '../shared/momoGoogle/compose.mjs';
import { googleIntents } from '../shared/momoGoogle/intents.mjs';
import { fakeCatcher, homeWorld, sealer } from './support/momoGoogleHostKit.ts';

async function rig(t: { after(f: () => void): void }, o: { catcher?: boolean } = {}) {
  const w = await homeWorld(t);
  await w.google.configure({ desktopJson: w.json });
  // the home's Host: `host.momoGoogle` steps reach the Google service of the home
  const call = async (method: string, p: any) => {
    assert.equal(method, 'host.momoGoogle');
    return (w.google as any)[p.op](p);
  };
  const registry = createIntentRegistry();
  registry.register(
    'google',
    googleIntents({ call, sealer, startCatcher: o.catcher === false ? null : fakeCatcher(() => ({ code: 'c' })) }),
  );
  const changed: unknown[] = [];
  const api = createHomeApi({
    compose: async () => ({ home: {}, rest: { google: await w.google.status() } }),
    intents: registry.intents(),
  });
  api.onChanged?.((v: unknown) => changed.push(v));
  return { w, api, registry, changed };
}
const send = (api: { intent: (i: object) => Promise<any> }, intent: object) => api.intent(intent);

test('google connect signs in through the home and the view that comes back carries the state; remove signs out again', async (t) => {
  const { w, api, registry, changed } = await rig(t);
  assert.deepEqual(
    registry.pending().filter((k) => k === 'google' || k.startsWith('source.')),
    [],
  );
  const on = await send(api, { kind: 'google', intent: 'connect', client: 'desktop' });
  assert.equal(on.ok, true);
  assert.equal(on.view.google.kind, 'connected_read_only');
  // every client hears the fresh view (the phone's `momo.home.changed`), not only the one that asked
  assert.equal((changed.at(-1) as any).view.google.kind, 'connected_read_only');
  assert.equal((await w.google.status()).kind, 'connected_read_only');

  const off = await send(api, { kind: 'source.remove', id: 'gmail' });
  assert.equal(off.ok, true);
  assert.equal(off.view.google.kind, 'not_connected');
  assert.equal((await w.google.status()).kind, 'not_connected');

  // this home has no iOS client set up: the phone's sign-in is refused in words
  const phone = await send(api, { kind: 'google', intent: 'connect', client: 'ios' });
  assert.equal(phone.ok, false);
  assert.ok(phone.cause.length > 0);
  assert.equal((await send(api, { kind: 'google', intent: 'reconnect', client: 'desktop' })).ok, true);
  assert.equal((await send(api, { kind: 'source.reconnect', id: 'calendar' })).ok, true);
});

test('what is not an intent of Google is refused in words, never run', async (t) => {
  const { api } = await rig(t);
  for (const bad of [
    { kind: 'google', intent: 'sing', client: 'desktop' },
    { kind: 'google', intent: 'connect', client: 'tv' },
    { kind: 'source.remove', id: 'drive' },
    { kind: 'source.reconnect', id: 'drive' },
    { kind: 'google', intent: 3, client: 'desktop' },
  ]) {
    const out = await send(api, bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.match(out.cause, /not something MoMo can do/);
  }
});

test('a Host has no browser: it says where to sign in, and still removes the account', async (t) => {
  const { w, api } = await rig(t, { catcher: false });
  const no = await send(api, { kind: 'google', intent: 'connect', client: 'desktop' });
  assert.equal(no.ok, false);
  assert.match(no.cause, /from the Mac or the phone you are using/);
  assert.equal((await send(api, { kind: 'google', intent: 'remove', client: 'desktop' })).ok, true);
  assert.equal((await w.google.status()).kind, 'not_connected');
});

test('a sign-in that failed comes back with the one tap that fixes it', async () => {
  const failing = (code: string) => {
    const handlers = googleIntents({
      call: async () => Promise.reject(Object.assign(new Error('Words for the person.'), { code })),
      sealer,
      startCatcher: fakeCatcher(() => ({ code: 'c' })),
    });
    return handlers.google({ intent: 'connect', client: 'ios' });
  };
  await assert.rejects(
    failing('google_needs_sign_in'),
    (e: any) =>
      e.fixLabel === 'Sign in again' && e.fix.intent === 'reconnect' && e.fix.client === 'ios' && e.message === 'Words for the person.',
  );
  await assert.rejects(failing('google_different_account'), (e: any) => e.fixLabel === 'Disconnect Google' && e.fix.intent === 'remove');
  await assert.rejects(failing('google_wrong_account'), (e: any) => e.fixLabel === 'Disconnect Google');
  await assert.rejects(failing('google_failed'), (e: any) => e.fix === undefined && e.message === 'Words for the person.');
});

test('the view parts: rows and the setup line follow the home’s Google state, and an unreachable Host shows nothing connected', async (t) => {
  const { api, w } = await rig(t);
  const call = async (method: string, p: any) => (assert.equal(method, 'host.momoGoogle'), (w.google as any)[p.op](p));
  const before = await composeGoogle({ call });
  assert.deepEqual([before.reachable, before.sources, before.setupGoogle, before.cause], [true, [], 'idle', null]);
  await send(api, { kind: 'google', intent: 'connect', client: 'desktop' });
  const on = await composeGoogle({ call, progress: { done: 1, total: 4 } });
  assert.deepEqual(
    on.sources.map((s) => [s.id, s.account, s.access, s.status]),
    [
      ['gmail', 'me@example.com', 'read-only', 'catching-up'],
      ['calendar', 'me@example.com', 'read-only', 'catching-up'],
    ],
  );
  assert.equal(on.setupGoogle, 'connected');
  const down = await composeGoogle({ call: async () => Promise.reject(new Error('offline')), lastAttemptFailed: true });
  assert.deepEqual([down.reachable, down.sources, down.setupGoogle], [false, [], 'failed']);
  const ended = googleViewOf({ kind: 'disconnected', email: 'me@example.com', cause: 'revoked', since: 1 });
  assert.deepEqual([ended.sources[0]?.status, ended.setupGoogle, ended.cause], ['needs-reconnect', 'failed', 'revoked']);
});
