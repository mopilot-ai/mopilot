// MoMo's server-signed entitlement (#5474): the token, the Host's decision (forged, expired, wrong audience, wrong key id, replayed, revoked, downgraded), the client's refresh and the view's access fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  ENTITLEMENT_GRACE_MS,
  ENTITLEMENT_REQUIRED_GRACE_MS,
  ENTITLEMENT_MAX_VALIDITY_MS,
  ENTITLEMENT_MAX_BYTES,
  ENTITLEMENT_TTL_MS,
  entitlementKeyId,
  signEntitlement,
  verifyEntitlement,
} from '../shared/host/momoEntitlement.mjs';
import { ENTITLEMENT_KEYS, REVOKED_ENTITLEMENT_KEY_IDS } from '../shared/host/momoEntitlementKeys.mjs';
import {
  createEntitlementGate,
  emptyEntitlementState,
  entitlementModeFrom,
  entitlementStateShape,
} from '../host/src/momoEntitlementGate.mjs';
import { createEntitlementClient } from '../shared/momoEntitlementClient.mjs';
import { MOMO_ACCESS_CODES, momoAccessFix, momoAccessProblem } from '../shared/momoAccessView.ts';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, pem, id: entitlementKeyId(pem) };
};
const A = pair();
const B = pair();
const HOST = 'a'.repeat(32);
const OTHER_HOST = 'b'.repeat(32);
const T0 = 1_800_000_000_000;
const claims = (o: object = {}) => ({ kid: A.id, sub: 'u1', features: ['momo'], aud: HOST, iat: T0, exp: T0 + ENTITLEMENT_TTL_MS, ...o });
const token = (o: object = {}, key = A.privateKey) => signEntitlement(claims(o), key);
const keys = [{ id: A.id, pem: A.pem }];
const grant = (entitlement?: unknown, account = 'u1') => ({ account, features: ['momo'], entitlement });
const gateAt = (at: number, o: object = {}) => createEntitlementGate({ hostId: HOST, keys, mode: 'required', now: () => at, ...o });

test('the pinned keys are Ed25519 public keys named by the hash of their public half, and none is revoked', () => {
  assert.equal(ENTITLEMENT_KEYS.length, 1, 'the account service key of #5622');
  for (const k of ENTITLEMENT_KEYS) {
    const pub = createPublicKey(k.pem);
    assert.equal(pub.asymmetricKeyType, 'ed25519');
    assert.equal(pub.type, 'public', 'never a private key');
    assert.equal(entitlementKeyId(pub.export({ type: 'spki', format: 'pem' }).toString()), k.id);
  }
  assert.deepEqual(REVOKED_ENTITLEMENT_KEY_IDS, []);
});

test('a token signed by a trusted key verifies and carries its claims', () => {
  const v = verifyEntitlement(token(), { keys });
  assert.deepEqual(v, { ok: true, claims: claims() });
});

test('forged, tampered, malformed, oversize, wrong-key and revoked-key tokens are invalid', () => {
  const good = token();
  const [v, p, s] = good.split('.');
  const forged = signEntitlement(claims(), B.privateKey); // signed by a key the Host does not trust, under the trusted id
  const other = claims({ sub: 'u2' });
  const tamperedPayload = `${v}.${Buffer.from(JSON.stringify([other.kid, other.sub, other.features, other.aud, other.iat, other.exp])).toString('base64url')}.${s}`;
  const reencoded = `${v}.${Buffer.from(` ${Buffer.from(p, 'base64url')}`).toString('base64url')}.${s}`;
  const cases: unknown[] = [
    forged,
    tamperedPayload,
    reencoded,
    `${v}.${p}`,
    `v2.${p}.${s}`,
    `${good}.extra`,
    'v1.!!.!!',
    `v1.${Buffer.from('{"a":1}').toString('base64url')}.${s}`,
    `v1.${Buffer.from('[1,2,3,4,5,6]').toString('base64url')}.${s}`,
    'x'.repeat(ENTITLEMENT_MAX_BYTES + 1),
    undefined,
    42,
    signEntitlement(claims({ exp: T0 }), A.privateKey),
    signEntitlement(claims({ aud: 'short' }), A.privateKey),
    signEntitlement(claims({ features: [1] }), A.privateKey),
    signEntitlement(claims({ sub: '' }), A.privateKey),
    signEntitlement(claims({ iat: 1.5 }), A.privateKey),
  ];
  for (const t of cases)
    assert.deepEqual(verifyEntitlement(t, { keys }), { ok: false, code: 'entitlement_invalid' }, String(t).slice(0, 40));
  // wrong key id: a token naming a key the Host does not know, and one whose pinned pem is not the id's key
  assert.deepEqual(verifyEntitlement(signEntitlement(claims({ kid: B.id }), B.privateKey), { keys }), {
    ok: false,
    code: 'entitlement_unknown_key',
  });
  assert.equal(verifyEntitlement(good, { keys: [{ id: A.id, pem: B.pem }] }).ok, false);
  assert.equal(verifyEntitlement(good, { keys, revoked: [A.id] }).ok, false);
});

test('the Host takes a good token and keeps the floor and the downgrade mark', () => {
  const d = gateAt(T0 + 1000).accept(grant(token()), emptyEntitlementState());
  assert.equal(d.ok, true);
  assert.ok(d.ok);
  assert.deepEqual(d.features, ['momo']);
  assert.equal(d.signed, true);
  assert.equal(d.pausesAt, T0 + ENTITLEMENT_TTL_MS + gateAt(0).graceMs);
  assert.deepEqual(d.state, {
    floorIat: T0,
    signedSince: T0 + 1000,
    account: 'u1',
    features: ['momo'],
    exp: T0 + ENTITLEMENT_TTL_MS,
    clockMark: T0 + 1000,
    held: true,
  });
  // the same token again (the 30-minute resend) is fine and keeps the first signedSince
  const again = gateAt(T0 + 9000).accept(grant(token()), d.state);
  assert.ok(again.ok);
  assert.equal(again.state.signedSince, T0 + 1000);
});

test('refused: wrong Host, other account, too long, key not trusted, skewed clock, replayed older token', () => {
  const g = gateAt(T0 + 1000);
  const fresh = emptyEntitlementState();
  const code = (t: unknown, account?: string, at = T0 + 1000) => {
    const d = gateAt(at).accept(grant(t, account), fresh);
    assert.ok(!d.ok);
    return d.code;
  };
  assert.equal(code(token({ aud: OTHER_HOST })), 'entitlement_wrong_host');
  assert.equal(code(token(), 'u2'), 'entitlement_invalid');
  assert.equal(code(token({ exp: T0 + 49 * 3_600_000 })), 'entitlement_invalid');
  assert.equal(code(signEntitlement(claims(), B.privateKey)), 'entitlement_invalid');
  assert.equal(code(token(), 'u1', T0 - 10 * 60_000), 'clock_skew');
  assert.equal(g.accept(grant(token({ iat: T0 - 1 })), { ...fresh, floorIat: T0 }).ok, false);
  const stale = g.accept(grant(token({ iat: T0 - 1 })), { ...fresh, floorIat: T0 });
  assert.ok(!stale.ok);
  assert.equal(stale.code, 'entitlement_stale');
  assert.equal(stale.message, 'The MoMo entitlement is older than one this Host already took.');
  // within the skew an iat a little ahead is accepted
  assert.ok(g.accept(grant(token({ iat: T0 + 1000 + 60_000 })), fresh).ok);
});

test('a signed token without momo revokes, and a held older token cannot undo it', () => {
  const g = gateAt(T0 + 5000);
  const granted = g.accept(grant(token()), emptyEntitlementState());
  assert.ok(granted.ok);
  const revoked = g.accept(grant(token({ features: [], iat: T0 + 2000, exp: T0 + 2000 + ENTITLEMENT_TTL_MS })), granted.state);
  assert.ok(!revoked.ok);
  assert.equal(revoked.code, 'entitlement_revoked');
  assert.equal(revoked.state.floorIat, T0 + 2000);
  assert.equal(g.standing(revoked.state).live, false);
  const replay = g.accept(grant(token()), revoked.state);
  assert.ok(!replay.ok);
  assert.equal(replay.code, 'entitlement_stale');
});

test('past exp the grace holds, then MoMo pauses; standing pauses it without the client', () => {
  const exp = T0 + ENTITLEMENT_TTL_MS;
  const grace = gateAt(0).graceMs;
  const ok = gateAt(T0 + 1).accept(grant(token()), emptyEntitlementState());
  assert.ok(ok.ok);
  assert.deepEqual(gateAt(exp + 1000).standing(ok.state), { live: true });
  assert.ok(gateAt(exp + grace).accept(grant(token()), emptyEntitlementState()).ok);
  // the token already taken, sent again past the grace: it ran out. A token never taken that is this late is the clock ahead (below)
  const late = gateAt(exp + grace + 1).accept(grant(token()), ok.state);
  assert.ok(!late.ok);
  assert.equal(late.code, 'entitlement_expired');
  assert.equal(gateAt(exp + grace + 1).accept(grant(token()), emptyEntitlementState()).ok, false);
  const standing = gateAt(exp + grace + 1).standing(ok.state);
  assert.deepEqual(standing, {
    live: false,
    code: 'entitlement_expired',
    message: 'The MoMo entitlement ran out and this Host could not get a new one.',
  });
  assert.equal(gateAt(1).standing(emptyEntitlementState()).live, false, 'required: none taken, none stands');
});

test('downgrade and modes: unsigned grants by mode, never after a signed one, required needs a key', () => {
  const unsigned = grant(undefined);
  const off = createEntitlementGate({ hostId: HOST, keys, mode: 'off', now: () => T0 });
  const warn = createEntitlementGate({ hostId: HOST, keys, mode: 'warn', now: () => T0 });
  const fresh = emptyEntitlementState();
  const o = off.accept(unsigned, fresh);
  assert.ok(o.ok);
  assert.deepEqual([o.signed, o.warning, o.pausesAt, o.features], [false, null, null, ['momo']]);
  const w = warn.accept(grant(null), fresh);
  assert.ok(w.ok);
  assert.equal(w.warning, 'This Host needs a signed MoMo entitlement and the app sent none.');
  const req = gateAt(T0).accept(unsigned, fresh);
  assert.ok(!req.ok);
  assert.equal(req.code, 'entitlement_missing');
  const signed = off.accept(grant(token()), fresh);
  assert.ok(signed.ok);
  const down = off.accept(unsigned, signed.state);
  assert.ok(!down.ok);
  assert.equal(down.code, 'entitlement_missing');
  // required with no pinned key keeps every grant out and says the update is the fix; it does not stop the Host
  const keyless = createEntitlementGate({ hostId: HOST, keys: [], mode: 'required', now: () => T0 });
  const noKey = keyless.accept(grant(token()), fresh);
  assert.ok(!noKey.ok);
  assert.equal(noKey.code, 'entitlement_unknown_key');
  const none = keyless.standing(fresh);
  assert.ok(!none.live);
  assert.equal(none.code, 'entitlement_missing');
  assert.equal(createEntitlementGate({ hostId: HOST, keys: [], now: () => T0 }).mode, 'off');
});

test('the mode comes from the environment and the kept state is made safe', () => {
  assert.equal(entitlementModeFrom({}), 'off');
  assert.equal(entitlementModeFrom({ MOPILOT_MOMO_ENTITLEMENT: 'required' }), 'required');
  assert.equal(entitlementModeFrom({ MOPILOT_MOMO_ENTITLEMENT: 'warn' }), 'warn');
  assert.equal(entitlementModeFrom({ MOPILOT_MOMO_ENTITLEMENT: 'yes' }), 'off');
  assert.deepEqual(entitlementStateShape(null), emptyEntitlementState());
  assert.deepEqual(
    entitlementStateShape({ floorIat: 5, signedSince: 6, account: 'u', features: ['momo', 3], exp: 9, clockMark: 7, held: true }),
    {
      floorIat: 5,
      signedSince: 6,
      account: 'u',
      features: ['momo'],
      exp: 9,
      clockMark: 7,
      held: true,
    },
  );
  assert.deepEqual(entitlementStateShape({ floorIat: 'x', features: 'momo' }), emptyEntitlementState());
});

test('the client fetches when it holds none or under 18 hours, shares one fetch, and falls back to the held token', async () => {
  let held: { entitlement: string; expiresAt: number } | null = null;
  let now = T0;
  let calls = 0;
  let fail = false;
  const client = createEntitlementClient({
    hostId: HOST,
    now: () => now,
    store: { get: () => held, set: (v) => (held = v) },
    fetchEntitlement: async (h) => {
      calls += 1;
      assert.equal(h, HOST);
      if (fail) throw new Error('offline');
      return { entitlement: `t${calls}`, expiresAt: now + ENTITLEMENT_TTL_MS };
    },
  });
  const g = { account: 'u1', features: ['momo'] };
  fail = true;
  assert.deepEqual(await client.grantParams(g), g, 'no token yet and the service is away: the Host says why');
  fail = false;
  const [a, b] = await Promise.all([client.grantParams(g), client.grantParams(g)]);
  assert.deepEqual([a.entitlement, b.entitlement, calls], ['t2', 't2', 2], 'one shared fetch');
  now += 5 * 3_600_000;
  assert.equal((await client.grantParams(g)).entitlement, 't2', 'still more than 18 hours left');
  now += 7 * 3_600_000;
  fail = true;
  assert.equal((await client.grantParams(g)).entitlement, 't2', 'refresh failed: the held token still goes');
  fail = false;
  assert.equal((await client.grantParams(g)).entitlement, 't4', 'the failed try was call 3');
  assert.equal((await client.grantParams(g, { force: true })).entitlement, 't5', 'Refresh access forces one');
});

test('the view offers the one-click fix for each access problem', () => {
  assert.deepEqual(
    MOMO_ACCESS_CODES.map((c) => momoAccessFix(c)?.id ?? null),
    ['update-app', 'refresh-access', 'update-app', 'refresh-access', 'refresh-access', 'refresh-access', null, 'check-clock', null, null],
  );
  assert.equal(momoAccessFix('something-newer'), null);
  assert.deepEqual(momoAccessProblem('entitlement_expired', 'ran out'), {
    code: 'entitlement_expired',
    cause: 'ran out',
    fix: { id: 'refresh-access', label: 'Refresh access' },
  });
  assert.equal(momoAccessProblem('home_exists', 'x'), null, 'a refusal that is not about access is not an access problem');
});

test('a key the Host was not given is its own cause: update, not refresh; off and warn go on as the alpha did, until a signed token was taken', () => {
  const rotated = signEntitlement(claims({ kid: B.id }), B.privateKey);
  const required = gateAt(T0 + 1000).accept(grant(rotated), emptyEntitlementState());
  assert.ok(!required.ok);
  assert.equal(required.code, 'entitlement_unknown_key');
  for (const mode of ['off', 'warn'] as const) {
    const gate = createEntitlementGate({ hostId: HOST, keys, mode, now: () => T0 + 1000 });
    const fresh = gate.accept(grant(rotated), emptyEntitlementState());
    assert.ok(fresh.ok);
    assert.equal(fresh.signed, false);
    assert.equal(fresh.warning !== null, mode === 'warn');
    const taken = gate.accept(grant(token()), emptyEntitlementState());
    assert.ok(taken.ok);
    const after = gate.accept(grant(rotated), taken.state);
    assert.ok(!after.ok, 'after a signed token an unverifiable one is refused');
    assert.equal(after.code, 'entitlement_unknown_key');
  }
});

test('where entitlements are required a grant never backed by one does not stand; elsewhere it is not judged', () => {
  const none = emptyEntitlementState();
  const s = gateAt(T0).standing(none);
  assert.deepEqual(s, {
    live: false,
    code: 'entitlement_missing',
    message: 'This Host needs a signed MoMo entitlement and the app sent none.',
  });
  assert.deepEqual(createEntitlementGate({ hostId: HOST, keys, mode: 'warn', now: () => T0 }).standing(none), { live: true });
  // marked required with no token behind it (a home that moved here): paused as missing, not as withdrawn
  const marked = { ...none, signedSince: T0 };
  const off = createEntitlementGate({ hostId: HOST, keys, mode: 'off', now: () => T0 });
  assert.equal((off.standing(marked) as any).code, 'entitlement_missing');
});

test('required keeps a shorter grace than off, and the lifetimes stay within the design', () => {
  assert.equal(gateAt(0).graceMs, ENTITLEMENT_REQUIRED_GRACE_MS);
  assert.equal(createEntitlementGate({ hostId: HOST, keys, now: () => 0 }).graceMs, ENTITLEMENT_GRACE_MS);
  assert.ok(ENTITLEMENT_TTL_MS + ENTITLEMENT_REQUIRED_GRACE_MS <= 24 * 3_600_000);
});

test('a clock set back stretches nothing: time never runs behind the newest seen or the newest token', () => {
  const exp = T0 + ENTITLEMENT_TTL_MS;
  const grace = gateAt(0).graceMs;
  const taken = gateAt(exp + grace - 10).accept(grant(token()), emptyEntitlementState());
  assert.ok(taken.ok);
  assert.equal(taken.state.clockMark, exp + grace - 10);
  // the clock goes back a week: the mark still says how late it is
  const back = gateAt(T0 - 7 * 86_400_000);
  assert.equal(back.standing({ ...taken.state, clockMark: exp + grace + 5 }).live, false);
  assert.equal(back.clockOf(taken.state), exp + grace - 10);
  // a stale mark does not move forward on its own
  const refused = back.accept(grant(token({ iat: T0 - 1 })), { ...taken.state, floorIat: T0 });
  assert.ok(!refused.ok);
  assert.equal(refused.state.clockMark, taken.state.clockMark);
});

test('an entitlement that is not a string fails closed where it is required', () => {
  for (const bad of [42, {}, ['v1'], true]) {
    const d = gateAt(T0).accept(grant(bad), emptyEntitlementState());
    assert.ok(!d.ok);
    assert.equal(d.code, 'entitlement_invalid');
  }
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const between = (at: number, iat: number) => token({ iat, exp: iat + ENTITLEMENT_TTL_MS });

test('a signature must be the canonical 86 characters: trailing or padded characters are not what the issuer signed', () => {
  const [v, p, s] = token().split('.');
  assert.equal(s.length, 86);
  for (const sig of [`${s}AA`, `${s}=`, s.slice(0, -1), `${s.slice(0, -1)}${s.at(-1) === 'A' ? 'B' : 'A'}`, `${s}.x`])
    assert.deepEqual(verifyEntitlement(`${v}.${p}.${sig}`, { keys }), { ok: false, code: 'entitlement_invalid' }, sig);
  // a non-canonical last character decodes to the same bytes, so only the canonical check refuses it
  const lenient = `${s.slice(0, -1)}${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'.includes(s.at(-1)!) ? 'g' : 'A'}`;
  assert.deepEqual(verifyEntitlement(`${v}.${p}.${lenient}`, { keys }), { ok: false, code: 'entitlement_invalid' });
});

test('the longest accepted validity is exactly ENTITLEMENT_MAX_VALIDITY_MS: one millisecond more is refused', () => {
  const at = gateAt(T0 + 1000);
  const edge = at.accept(grant(token({ exp: T0 + ENTITLEMENT_MAX_VALIDITY_MS })), emptyEntitlementState());
  assert.ok(edge.ok, 'exactly the limit is taken');
  const over = at.accept(grant(token({ exp: T0 + ENTITLEMENT_MAX_VALIDITY_MS + 1 })), emptyEntitlementState());
  assert.ok(!over.ok);
  assert.equal(over.code, 'entitlement_invalid');
  assert.ok(ENTITLEMENT_MAX_VALIDITY_MS < 48 * HOUR);
});

test('a clock that jumped forward and came back never keeps the Host out: a refusal carries no time forward', () => {
  const first = gateAt(T0 + 1000).accept(grant(token()), emptyEntitlementState());
  assert.ok(first.ok);
  const mark = first.state.clockMark;
  const ahead = gateAt(T0 + 10 * DAY);
  // the token it holds, now long past its time by this clock: expired, and the time mark stays where it was
  const held = ahead.accept(grant(token()), first.state);
  assert.ok(!held.ok);
  assert.equal(held.code, 'entitlement_expired');
  assert.equal(held.state.clockMark, mark);
  // a token newer than any taken that this clock still calls out of date: the clock is ahead, not the token old
  const newer = ahead.accept(grant(between(T0 + 10 * DAY, T0 + HOUR)), held.state);
  assert.ok(!newer.ok);
  assert.equal(newer.code, 'clock_skew');
  assert.equal(newer.state.clockMark, mark);
  // the standing is read from the same clock without writing it: gone while the clock is wrong, back once it is right
  assert.equal(ahead.standing(first.state).live, false);
  assert.equal(gateAt(T0 + 2 * HOUR).standing(first.state).live, true);
  // the clock is fixed: the next fresh token is taken, and nothing waits for real time to catch up
  const back = gateAt(T0 + 2 * HOUR).accept(grant(between(T0 + 2 * HOUR, T0 + 2 * HOUR)), newer.state);
  assert.ok(back.ok);
  assert.equal(back.state.clockMark, T0 + 2 * HOUR);
});

test('an account never invited is told so; one whose access was withdrawn is told that', () => {
  const g = gateAt(T0 + 1000);
  const never = g.accept(grant(token({ features: [] })), emptyEntitlementState());
  assert.ok(!never.ok);
  assert.equal(never.code, 'not_invited');
  const standing = g.standing(never.state);
  assert.ok(!standing.live);
  assert.equal(standing.code, 'not_invited');
  const had = g.accept(grant(token()), emptyEntitlementState());
  assert.ok(had.ok);
  const out = g.accept(grant(token({ features: [], iat: T0 + 500 })), had.state);
  assert.ok(!out.ok);
  assert.equal(out.code, 'entitlement_revoked');
  const gone = g.standing(out.state);
  assert.ok(!gone.live);
  assert.equal(gone.code, 'entitlement_revoked');
  const old = g.accept(grant(token({ features: [], iat: T0 + 600 })), out.state);
  assert.ok(!old.ok);
  assert.equal(old.code, 'entitlement_revoked');
  // a state kept before an account was known says nothing was taken
  assert.equal(gateAt(T0).standing({ ...emptyEntitlementState(), signedSince: T0 }).live, false);
});

test('a payload that is not JSON, or a pinned key that is not a key, is invalid and never throws', () => {
  const [v, , s] = token().split('.');
  const notJson = `${v}.${Buffer.from('not json').toString('base64url')}.${s}`;
  assert.deepEqual(verifyEntitlement(notJson, { keys }), { ok: false, code: 'entitlement_invalid' });
  // a key id that matches no PEM it can read: the Host's own list is broken, which is a refusal, not a crash
  assert.deepEqual(verifyEntitlement(token(), { keys: [{ id: A.id, pem: 'not a pem' }] }), { ok: false, code: 'entitlement_invalid' });
});
