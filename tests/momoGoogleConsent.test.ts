// MoMo Google sign-in that finishes on the home (shared/momoGoogle/consent.ts): the full hand-off against a fake token endpoint, the send-only step and every refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleConsent, type ConsentError } from '../shared/momoGoogle/consent.mjs';
import { iosClientConfig, iosRedirect } from '../shared/momoGoogle/clientConfig.mjs';
import { sealHandoff } from '../shared/momoGoogle/handoff.mjs';
import { createSealer } from '../shared/momoGoogle/seal.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { READ_SCOPES, SEND_SCOPE } from '../shared/momoGoogle/types.mjs';
import { idToken, startFake } from './support/fakeGoogle.ts';
import { makeAccount, memoryFile, NOW, record } from './support/googleAccountKit.ts';

const sealer = createSealer(createNodePrimitives());
const REDIRECT = 'http://127.0.0.1:53682/callback';
const code = (c: string) => (e: unknown) => (e as ConsentError).code === c;

const IOS_ID = 'ios-client-123456.apps.googleusercontent.com';
/** The iOS client pointed at the fake endpoints. */
const ios = (c: { authUri: string; tokenUri: string }) => ({ ...iosClientConfig(IOS_ID), authUri: c.authUri, tokenUri: c.tokenUri });

async function rig(tokenAnswer: (form: URLSearchParams) => { status?: number; body?: unknown }, file = memoryFile()) {
  const fake = await startFake((r) => (r.path === '/token' ? tokenAnswer(r.form) : undefined));
  const kit = makeAccount({ config: fake.config, fetch: fake.fetch, file });
  const consent = new GoogleConsent({
    account: kit.account,
    sealer,
    config: fake.config,
    iosConfig: ios(fake.config),
    fetch: fake.fetch,
    now: () => kit.clock.t,
  });
  /** What a client does: read the auth URL, take state, send the sealed redirect back. */
  const clientSide = (
    started: { flowId: string; authUrl: string; sealTo: string },
    extra: Record<string, string> = { code: 'the-code' },
  ) => {
    const state = new URL(started.authUrl).searchParams.get('state') as string;
    return sealHandoff(sealer, started.flowId, started.sealTo, { state, redirectUri: REDIRECT, ...extra });
  };
  return { fake, kit, consent, clientSide };
}

const readAnswer = (email = 'me@example.com') => ({
  body: { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: READ_SCOPES.join(' '), id_token: idToken(email) },
});

test('read consent: the auth URL asks for read scopes with PKCE, the home exchanges the sealed code and stores the tokens', async () => {
  const { fake, kit, consent, clientSide } = await rig(() => readAnswer(), memoryFile());
  try {
    const started = await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    const q = new URL(started.authUrl).searchParams;
    assert.equal(new URL(started.authUrl).origin + new URL(started.authUrl).pathname, `${fake.url}/auth`);
    assert.equal(q.get('redirect_uri'), REDIRECT);
    assert.equal(q.get('scope'), READ_SCOPES.join(' '));
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('access_type'), 'offline');
    assert.equal(q.get('login_hint'), null);
    assert.equal(started.expiresAt, NOW + 600_000);
    assert.ok(!started.authUrl.includes('code_verifier'));

    assert.deepEqual(await consent.complete(started.flowId, clientSide(started)), { email: 'me@example.com', canSend: false });
    const form = fake.requests[0]?.form as URLSearchParams;
    assert.equal(form.get('code'), 'the-code');
    assert.equal(form.get('redirect_uri'), REDIRECT);
    assert.equal(form.get('client_secret'), 'client-secret');
    // the verifier sent to Google hashes to the challenge the client was shown, and was never in the URL
    const { createHash } = await import('node:crypto');
    assert.equal(
      createHash('sha256')
        .update(form.get('code_verifier') as string)
        .digest('base64url'),
      q.get('code_challenge'),
    );
    assert.deepEqual(await kit.account.status(), { state: 'connected', email: 'me@example.com', canSend: false, connectedAt: NOW });
    assert.equal(kit.file.value?.tokens.refreshToken, 'rt1');
    // the flow was single use
    await assert.rejects(consent.complete(started.flowId, clientSide(started)), code('unknown_flow'));
  } finally {
    await fake.close();
  }
});

test("begin refuses a redirect that is not the client's loopback, and a send step with no account", async () => {
  const { fake, consent } = await rig(() => readAnswer());
  try {
    for (const bad of [
      'https://evil.example/callback',
      'http://127.0.0.1:80/other',
      'http://localhost:5000/callback',
      'http://127.0.0.1:1/callback',
    ]) {
      await assert.rejects(consent.begin({ purpose: 'read', redirectUri: bad, client: 'desktop' }), code('bad_redirect'));
    }
    await assert.rejects(consent.begin({ purpose: 'send', redirectUri: REDIRECT, client: 'desktop' }), code('no_account'));
    for (let i = 0; i < 9; i++) await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    assert.equal(consent.pending(), 8, 'the ninth pushed the oldest out');
  } finally {
    await fake.close();
  }
});

test('a flow that waited ten minutes is gone; expired ones free their place', async () => {
  const { fake, kit, consent, clientSide } = await rig(() => readAnswer());
  try {
    const started = await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    kit.clock.t += 600_000;
    await assert.rejects(consent.complete(started.flowId, clientSide(started)), code('expired'));
    for (let i = 0; i < 8; i++) await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    kit.clock.t += 600_000;
    await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
  } finally {
    await fake.close();
  }
});

test('a hand-off with the wrong state, redirect, key or shape is invalid and is refused without burning the flow; a provider error is "denied"', async () => {
  const { fake, consent, clientSide } = await rig(() => readAnswer());
  try {
    const tries: Array<(s: { flowId: string; authUrl: string; sealTo: string }) => string> = [
      (s) => sealHandoff(sealer, s.flowId, s.sealTo, { state: 'wrong', redirectUri: REDIRECT, code: 'c' }),
      (s) =>
        sealHandoff(sealer, s.flowId, s.sealTo, {
          state: new URL(s.authUrl).searchParams.get('state') as string,
          redirectUri: 'http://127.0.0.1:1111/callback',
          code: 'c',
        }),
      (s) => sealHandoff(sealer, s.flowId, sealer.generateKeyPair().publicKey, { state: 's', redirectUri: REDIRECT, code: 'c' }),
      (s) => sealHandoff(sealer, 'another-flow', s.sealTo, { state: 's', redirectUri: REDIRECT, code: 'c' }),
      (s) => 'not sealed',
    ];
    for (const t of tries) {
      const s = await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
      // not the client's hand-off: refused, the flow stays for the real one, and three such tries end it
      for (let i = 0; i < 3; i++) await assert.rejects(consent.complete(s.flowId, t(s)), code('invalid'));
      await assert.rejects(consent.complete(s.flowId, clientSide(s)), code('unknown_flow'));
    }
    // the client's own hand-off with no code is authentic: invalid, and the flow is used
    const empty = await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(consent.complete(empty.flowId, clientSide(empty, {})), code('invalid'));
    await assert.rejects(consent.complete(empty.flowId, clientSide(empty)), code('unknown_flow'));
    const s = await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(consent.complete(s.flowId, clientSide(s, { error: 'access_denied' })), code('denied'));
    // a sealed JSON that is not an object
    const n = await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(consent.complete(n.flowId, sealer.seal(n.sealTo, 'null', `google-consent:${n.flowId}`)), code('invalid'));
    assert.equal(fake.requests.length, 0, 'nothing reached Google');
  } finally {
    await fake.close();
  }
});

test('exchange failures: refused, offline, no refresh token, no email, unticked scope; nothing is stored', async () => {
  const answers: Array<{ status?: number; body?: unknown }> = [
    { status: 400, body: { error: 'invalid_grant' } },
    { body: { access_token: 'a', id_token: idToken('me@example.com'), scope: READ_SCOPES.join(' ') } },
    { body: { access_token: 'a', refresh_token: 'r', scope: READ_SCOPES.join(' ') } },
    { body: { access_token: 'a', refresh_token: 'r', id_token: 'x.%%%.y', scope: READ_SCOPES.join(' ') } },
    { status: 200, body: null },
    {
      body: {
        access_token: 'a',
        refresh_token: 'r',
        id_token: `x.${Buffer.from('{}').toString('base64url')}.y`,
        scope: READ_SCOPES.join(' '),
      },
    },
  ];
  let i = 0;
  const { fake, kit, consent, clientSide } = await rig(() => answers[i++] as any);
  try {
    for (let n = 0; n < answers.length; n++) {
      const s = await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
      await assert.rejects(consent.complete(s.flowId, clientSide(s)), code('exchange_failed'));
    }
    i = 99;
    const bare = await startFake((r) =>
      r.path === '/token' ? { body: { access_token: 'a', refresh_token: 'r', id_token: idToken('me@example.com') } } : undefined,
    );
    const c3 = new GoogleConsent({ account: kit.account, sealer, config: bare.config, fetch: bare.fetch, now: () => kit.clock.t });
    const b = await c3.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(
      c3.complete(
        b.flowId,
        sealHandoff(sealer, b.flowId, b.sealTo, {
          state: new URL(b.authUrl).searchParams.get('state') as string,
          redirectUri: REDIRECT,
          code: 'c',
        }),
      ),
      code('scope_missing'),
    );
    await bare.close();
    const partial = {
      body: {
        access_token: 'a',
        refresh_token: 'r',
        id_token: idToken('me@example.com'),
        scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
      },
    };
    const t = await startFake((r) => (r.path === '/token' ? (partial as any) : undefined));
    const c2 = new GoogleConsent({ account: kit.account, sealer, config: t.config, fetch: t.fetch, now: () => kit.clock.t });
    const s = await c2.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    const state = new URL(s.authUrl).searchParams.get('state') as string;
    await assert.rejects(
      c2.complete(s.flowId, sealHandoff(sealer, s.flowId, s.sealTo, { state, redirectUri: REDIRECT, code: 'c' })),
      code('scope_missing'),
    );
    await t.close();
    const html = new GoogleConsent({
      account: kit.account,
      sealer,
      config: fake.config,
      fetch: async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('html');
        },
      }),
      now: () => kit.clock.t,
    });
    const h = await html.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(html.complete(h.flowId, clientSide(h)), code('exchange_failed'));
    const down = new GoogleConsent({
      account: kit.account,
      sealer,
      config: fake.config,
      fetch: async () => {
        throw new Error('offline');
      },
      now: () => kit.clock.t,
    });
    const d = await down.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(down.complete(d.flowId, clientSide(d)), code('exchange_failed'));
    assert.equal(kit.file.value, null, 'nothing was stored');
  } finally {
    await fake.close();
  }
});

test('send-only step: asks for the send scope for the signed-in account and adds it to the grant', async () => {
  const { fake, kit, consent, clientSide } = await rig(
    () => ({
      body: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, scope: SEND_SCOPE, id_token: idToken('me@example.com') },
    }),
    memoryFile(record()),
  );
  try {
    const s = await consent.begin({ purpose: 'send', redirectUri: REDIRECT, client: 'desktop' });
    const q = new URL(s.authUrl).searchParams;
    assert.equal(q.get('scope'), SEND_SCOPE);
    assert.equal(q.get('login_hint'), 'me@example.com');
    assert.equal(q.get('include_granted_scopes'), 'true');
    assert.deepEqual(await consent.complete(s.flowId, clientSide(s)), { email: 'me@example.com', canSend: true });
    assert.deepEqual(new Set(kit.file.value?.tokens.scopes), new Set([...READ_SCOPES, SEND_SCOPE]));
    assert.equal(kit.file.value?.tokens.refreshToken, 'rt2');
  } finally {
    await fake.close();
  }
});

test('send-only step refuses another Google account and a grant that lacks the send scope', async () => {
  let answer: any = { body: { access_token: 'x', refresh_token: 'y', scope: SEND_SCOPE, id_token: idToken('someone-else@example.com') } };
  const { fake, kit, consent, clientSide } = await rig(() => answer, memoryFile(record()));
  try {
    const a = await consent.begin({ purpose: 'send', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(consent.complete(a.flowId, clientSide(a)), code('wrong_account'));
    answer = { body: { access_token: 'x', refresh_token: 'y', scope: 'openid', id_token: idToken('me@example.com') } };
    const b = await consent.begin({ purpose: 'send', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(consent.complete(b.flowId, clientSide(b)), code('scope_missing'));
    // the account vanished while the user was in the browser
    const c = await consent.begin({ purpose: 'send', redirectUri: REDIRECT, client: 'desktop' });
    kit.file.value = null;
    answer = { body: { access_token: 'x', refresh_token: 'y', scope: SEND_SCOPE, id_token: idToken('me@example.com') } };
    await assert.rejects(consent.complete(c.flowId, clientSide(c)), code('wrong_account'));
    assert.equal(kit.file.value, null);
  } finally {
    await fake.close();
  }
});

test('iOS client: the app scheme is the redirect, the exchange carries no secret, and the grant is remembered as iOS', async () => {
  const seen: URLSearchParams[] = [];
  const { fake, kit, consent } = await rig((form) => {
    seen.push(form);
    return readAnswer();
  });
  try {
    await assert.rejects(consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'ios' }), code('bad_redirect'));
    await assert.rejects(consent.begin({ purpose: 'read', redirectUri: iosRedirect(IOS_ID), client: 'desktop' }), code('bad_redirect'));
    const started = await consent.begin({ purpose: 'read', redirectUri: iosRedirect(IOS_ID), client: 'ios' });
    const q = new URL(started.authUrl).searchParams;
    assert.equal(q.get('client_id'), IOS_ID);
    assert.equal(q.get('redirect_uri'), 'com.googleusercontent.apps.ios-client-123456:/oauth2redirect');
    const state = q.get('state') as string;
    const hand = sealHandoff(sealer, started.flowId, started.sealTo, { state, redirectUri: iosRedirect(IOS_ID), code: 'c' });
    await consent.complete(started.flowId, hand);
    assert.equal(seen[0]?.get('client_id'), IOS_ID);
    assert.equal(seen[0]?.has('client_secret'), false);
    assert.equal(kit.file.value?.client, 'ios');
  } finally {
    await fake.close();
  }
});

test('without an iOS client the iOS flow is refused; a send step must use the client that made the grant', async () => {
  const fake = await startFake((r) =>
    r.path === '/token'
      ? { body: { access_token: 'x', refresh_token: 'y', scope: SEND_SCOPE, id_token: idToken('me@example.com') } }
      : undefined,
  );
  try {
    const kit = makeAccount({ config: fake.config, fetch: fake.fetch, file: memoryFile(record({ client: 'ios' })) });
    const consent = new GoogleConsent({ account: kit.account, config: fake.config, sealer, fetch: fake.fetch, now: () => kit.clock.t });
    await assert.rejects(consent.begin({ purpose: 'read', redirectUri: iosRedirect(IOS_ID), client: 'ios' }), code('no_ios_client'));
    const s = await consent.begin({ purpose: 'send', redirectUri: REDIRECT, client: 'desktop' });
    const state = new URL(s.authUrl).searchParams.get('state') as string;
    await assert.rejects(
      consent.complete(s.flowId, sealHandoff(sealer, s.flowId, s.sealTo, { state, redirectUri: REDIRECT, code: 'c' })),
      code('wrong_account'),
    );
  } finally {
    await fake.close();
  }
});

test('an unexpected failure while keeping the grant is not turned into a consent refusal', async () => {
  const { fake, kit, consent, clientSide } = await rig(() => readAnswer(), memoryFile());
  try {
    const boom = new Error('disk full');
    kit.account.connect = () => Promise.reject(boom);
    const started = await consent.begin({ purpose: 'read', redirectUri: REDIRECT, client: 'desktop' });
    await assert.rejects(consent.complete(started.flowId, clientSide(started)), (e) => e === boom);
  } finally {
    await fake.close();
  }
});
