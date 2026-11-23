// The phone's run of MoMo's Google intents (mobile/src/momo/googleSignIn.ts) against a home's real Google service and a fake Google: the redirect comes from the home, the system sign-in session returns the redirect, the home finishes the exchange, and every refusal comes back in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGoogleOnPhone } from '../mobile/src/momo/googleSignIn.ts';
import { OWED_NOTICE } from '../shared/momoGoogle/intents.mjs';
import { iosRedirect } from '../shared/momoGoogle/clientConfig.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { homeWorld } from './support/momoGoogleHostKit.ts';

const IOS_ID = 'ios-client-123456.apps.googleusercontent.com';
const primitives = createNodePrimitives();

async function phone(t: { after(f: () => void): void }, o: { withIos?: boolean; revoke?: boolean } = {}) {
  const w = await homeWorld(t, o.revoke === false ? { revoke: () => ({ status: 503, body: {} }) } : {});
  await w.google.configure({ desktopJson: w.json, ...(o.withIos === false ? {} : { iosClientId: IOS_ID }) });
  const call = async (method: string, p: any) => (assert.equal(method, 'host.momoGoogle'), (w.google as any)[p.op](p));
  /** What the system sign-in session does: the person allows, and the redirect comes back on the app's scheme with the page's own state. */
  const opened: string[] = [];
  const allow = async (url: string, redirectUri: string) => {
    opened.push(url);
    const state = new URL(url).searchParams.get('state');
    return { type: 'success' as const, url: `${redirectUri}?state=${state}&code=the-code` };
  };
  return { w, call, opened, allow };
}

test('the phone signs in through the system session with the redirect the home reports, and signs out again', async (t) => {
  const { w, call, opened, allow } = await phone(t);
  assert.deepEqual((await w.google.iosRedirect()).uri, iosRedirect(IOS_ID));
  assert.deepEqual(await runGoogleOnPhone({ intent: 'connect', call, primitives, openAuthSession: allow }), { ok: true });
  assert.equal(new URL(opened[0] as string).searchParams.get('redirect_uri'), iosRedirect(IOS_ID));
  assert.equal((await w.google.status()).kind, 'connected_read_only');
  assert.deepEqual(await runGoogleOnPhone({ intent: 'remove', call, primitives, openAuthSession: allow }), { ok: true });
  assert.equal((await w.google.status()).kind, 'not_connected');
});

test('a home with no iOS client says to set it up on the Mac; remove still works there; a cancelled sheet says it was not finished', async (t) => {
  const none = await phone(t, { withIos: false });
  const out = await runGoogleOnPhone({ intent: 'connect', call: none.call, primitives, openAuthSession: none.allow });
  assert.deepEqual(out, { ok: false, cause: 'Google is not set up for the phone yet. Set it up on the Mac first.' });
  assert.equal((await runGoogleOnPhone({ intent: 'remove', call: none.call, primitives, openAuthSession: none.allow })).ok, true);

  const { call } = await phone(t);
  const cancelled = await runGoogleOnPhone({ intent: 'connect', call, primitives, openAuthSession: async () => ({ type: 'cancel' }) });
  assert.deepEqual(cancelled, { ok: false, cause: 'The sign-in was not finished.' });
});

test('a Host that cannot be reached comes back as words, never a throw', async () => {
  const out = await runGoogleOnPhone({
    intent: 'connect',
    call: async () => Promise.reject(new Error('Mac is asleep')),
    primitives,
    openAuthSession: async () => ({ type: 'cancel' }),
  });
  assert.deepEqual(out, { ok: false, cause: 'Mac is asleep' });
  const unknown = await runGoogleOnPhone({
    intent: 'x',
    call: async () => ({ uri: 'a:/b' }),
    primitives,
    openAuthSession: async () => ({ type: 'cancel' }),
  });
  assert.equal(unknown.ok, false);
  const noMessage = await runGoogleOnPhone({
    intent: 'connect',
    call: async () => Promise.reject({}),
    primitives,
    openAuthSession: async () => ({ type: 'cancel' }),
  });
  assert.deepEqual(noMessage, { ok: false, cause: 'It did not finish.' });
});

test('a fix the home would offer reaches the phone with its button', async () => {
  const call = async (_method: string, p: any) => {
    if (p.op === 'iosRedirect') return { uri: 'com.googleusercontent.apps.1-a:/oauth2redirect' };
    throw Object.assign(new Error('That is another Google account.'), { code: 'google_different_account' });
  };
  const out = await runGoogleOnPhone({ intent: 'connect', call, primitives, openAuthSession: async () => ({ type: 'cancel' }) });
  assert.deepEqual(out, {
    ok: false,
    cause: 'That is another Google account.',
    fix: { kind: 'google', intent: 'remove', client: 'ios' },
    fixLabel: 'Disconnect Google',
  });
});

test('a removal Google could not be told about comes back with the notice to show', async (t) => {
  const { call, allow } = await phone(t, { revoke: false });
  assert.equal((await runGoogleOnPhone({ intent: 'connect', call, primitives, openAuthSession: allow })).ok, true);
  assert.deepEqual(await runGoogleOnPhone({ intent: 'remove', call, primitives, openAuthSession: allow }), {
    ok: true,
    notice: OWED_NOTICE,
  });
});
