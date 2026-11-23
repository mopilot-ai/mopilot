// Organization leases on a Host (#3361 Tier 2): the shared lease schema (shared/host/orgAccess.mjs), the Host's in-memory holder keyed by (harness, org identity) (host/src/credentialLease.mjs) and the `host.orgLease` request (host/src/protocol.mjs). A: expiry, renewal, replacement; W: two identities on one Host; B: bad leases; I: what each harness gets.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
import { baseUrlOf, isIdentity, isLeaseToken, LEASE_HOURS, leaseHoursOf, leaseOf, ORG_FEATURE } from '../shared/host/orgAccess.mjs';

const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');

/** Dummy tokens and identities: never real ones. */
const TOKEN_A = 'eyJ.dummy-org-token-alice-0000.sig';
const TOKEN_A2 = 'eyJ.dummy-org-token-alice-1111.sig';
const TOKEN_B = 'eyJ.dummy-org-token-bobby-0000.sig';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const GW = { anthropic: 'https://llm.example.test/anthropic', openai: 'https://llm.example.test/openai/v1' };
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-org-lease-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** Timers the test fires by hand. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => (pending.set(next, { fn, ms }), next++),
    clearTimeout: (t: number) => void pending.delete(t),
    fire(t: number) {
      const p = pending.get(t);
      pending.delete(t);
      p?.fn();
    },
  };
}
const lease = (o: Record<string, unknown> = {}) => ({
  harness: 'claude',
  identity: A,
  token: TOKEN_A,
  gateways: GW,
  expiresAt: NOW + 8 * HOUR,
  ...o,
});

test('B: the lease schema takes a harness, an identity, a token, the gateways it is good for and an end within 24 h; a refusal never repeats the token', () => {
  assert.equal(ORG_FEATURE, 'orgCredentials');
  assert.deepEqual(LEASE_HOURS, { min: 1, max: 24, default: 8 });
  assert.deepEqual(leaseOf(lease({ gateways: GW }), NOW), {
    harness: 'claude',
    identity: A,
    token: TOKEN_A,
    gateways: { anthropic: GW.anthropic },
    expiresAt: NOW + 8 * HOUR,
  });
  assert.deepEqual((leaseOf(lease({ harness: 'acp' }), NOW) as any).gateways, GW, 'an ACP agent may talk to either gateway');
  assert.deepEqual((leaseOf(lease({ harness: 'codex', gateways: { openai: `${GW.openai}/` } }), NOW) as any).gateways, {
    openai: GW.openai,
  });
  assert.deepEqual(leaseOf({ harness: 'codex', identity: B, token: null }, NOW), { harness: 'codex', identity: B, token: null });
  const refuses = (p: unknown, message: RegExp) =>
    assert.throws(
      () => leaseOf(p, NOW),
      (e: any) => message.test(e.message) && !String(e.message).includes(TOKEN_A),
    );
  refuses(lease({ harness: 'gemini' }), /takes no organization access/);
  refuses(null, /takes no organization access/);
  refuses(lease({ identity: 'alice' }), /names no one/);
  refuses(lease({ token: 'short' }), /not an organization token/);
  refuses(lease({ token: `${TOKEN_A} x` }), /not an organization token/);
  // a Host's clock up to 15 minutes off the app's still takes the end the app gave
  assert.equal((leaseOf(lease({ expiresAt: NOW - 14 * 60_000 }), NOW) as any).expiresAt, NOW - 14 * 60_000);
  assert.equal((leaseOf(lease({ expiresAt: NOW + 24 * HOUR + 14 * 60_000 }), NOW) as any).identity, A);
  refuses(lease({ expiresAt: NOW - 16 * 60_000 }), /no valid end/);
  refuses(lease({ expiresAt: NOW + 24 * HOUR + 16 * 60_000 }), /no valid end/);
  refuses(lease({ expiresAt: 'soon' }), /no valid end/);
  refuses(lease({ gateways: { anthropic: 'http://llm.example.test' } }), /gateway address is not allowed/);
  refuses(lease({ gateways: { openai: GW.openai } }), /names no gateway/);
  refuses(lease({ gateways: undefined }), /names no gateway/);
  // the wire's parser gives the same answers as SchemaErrors
  assert.deepEqual(S.REQUIRES['host.orgLease'], ['orgCredentials']);
  assert.ok(S.FEATURES.includes('orgCredentials'));
  assert.equal(S.parseParams('host.orgLease', lease({ expiresAt: Date.now() + HOUR })).identity, A);
  assert.throws(
    () => S.parseParams('host.orgLease', lease({ token: 'x' })),
    (e: any) => e.code === 'invalid' && /not an organization token/.test(e.message),
  );
});

test('B: a gateway or issuer is https, or http on loopback only, with no credentials, query or fragment; hours and tokens are bounded', () => {
  assert.equal(baseUrlOf('https://llm.example.test/a/'), 'https://llm.example.test/a');
  for (const ok of ['http://127.0.0.1:8787/anthropic', 'http://localhost:8080/realms/x', 'http://[::1]:9/x']) assert.ok(baseUrlOf(ok), ok);
  for (const bad of [
    'http://10.0.0.5/x',
    'ftp://x.test',
    'https://u:p@x.test',
    'https://x.test/?q=1',
    'https://x.test/#f',
    'not a url',
    42,
    null,
    `https://x.test/${'a'.repeat(2050)}`,
  ])
    assert.equal(baseUrlOf(bad), null, String(bad).slice(0, 40));
  assert.deepEqual(
    [leaseHoursOf(1), leaseHoursOf(24), leaseHoursOf('12'), leaseHoursOf(0), leaseHoursOf(25), leaseHoursOf(2.5), leaseHoursOf(undefined)],
    [1, 24, 12, 8, 8, 8, 8],
  );
  assert.deepEqual([isLeaseToken(TOKEN_A), isLeaseToken('x'.repeat(16385)), isLeaseToken(7)], [true, false, false]);
  assert.deepEqual([isIdentity(A), isIdentity('A'.repeat(32)), isIdentity('a'.repeat(31)), isIdentity(null)], [true, false, false, false]);
});

test('I: with a lease in use, Claude Code gets the gateway address only, an ACP agent the address and the token, Codex nothing in its env; a lease goes before a key', () => {
  const leases = createCredentialLeases(fakeTimers());
  leases.set('claude', 'sk-ant-dummy-0000-test-key-abcd');
  leases.set('codex', 'sk-dummy-0000-test-key-openai-abcd');
  assert.deepEqual(leases.setOrg(lease(), NOW), { held: true });
  assert.deepEqual(
    leases.envFor('claude'),
    { ANTHROPIC_BASE_URL: GW.anthropic },
    'the token reaches Claude Code through its key helper, never its env',
  );
  leases.setOrg(lease({ harness: 'codex', gateways: { openai: GW.openai } }), NOW);
  assert.deepEqual(
    [leases.envFor('codex'), leases.loginKey('codex')],
    [{}, null],
    'Codex reads the lease through its model provider, never a login',
  );
  leases.setOrg(lease({ harness: 'acp' }), NOW);
  assert.deepEqual(leases.envFor('acp'), {
    ANTHROPIC_BASE_URL: GW.anthropic,
    ANTHROPIC_AUTH_TOKEN: TOKEN_A,
    OPENAI_BASE_URL: GW.openai,
    OPENAI_API_KEY: TOKEN_A,
  });
  leases.setOrg(lease({ harness: 'acp', identity: B, token: TOKEN_B, gateways: { openai: GW.openai } }), NOW);
  assert.deepEqual(leases.envFor('acp'), { OPENAI_BASE_URL: GW.openai, OPENAI_API_KEY: TOKEN_B }, 'only the gateways its lease names');
  leases.setOrg(lease({ harness: 'acp', identity: B, token: TOKEN_B, gateways: { anthropic: GW.anthropic } }), NOW);
  assert.deepEqual(leases.envFor('acp'), { ANTHROPIC_BASE_URL: GW.anthropic, ANTHROPIC_AUTH_TOKEN: TOKEN_B });
  leases.setOrg(lease({ harness: 'claude', gateways: { openai: GW.openai } }), NOW);
  assert.deepEqual(leases.envFor('claude'), {}, 'a Claude lease with no Anthropic gateway sets nothing');
  assert.deepEqual(
    [leases.has('claude'), leases.hasOrg('claude'), leases.hasOrg('gemini'), leases.has('gemini')],
    [true, true, false, false],
  );
  assert.deepEqual(leases.orgLease('claude'), { identity: A, token: TOKEN_A, gateways: { openai: GW.openai }, expiresAt: NOW + 8 * HOUR });
  assert.equal(leases.orgLease('gemini'), null);
});

test('A: a lease is dropped when it ends, and only if no fresh one replaced it; a renewal with the same gateways is told as `renewed`', () => {
  const timers = fakeTimers();
  const leases = createCredentialLeases(timers);
  const told: string[] = [];
  leases.onChange((h, change) => told.push(`${h}:${change}`));
  leases.setOrg(lease(), NOW);
  const [first] = [...timers.pending.keys()];
  assert.equal(timers.pending.get(first)?.ms, 8 * HOUR);
  // the same lease again (the next message) changes nothing
  leases.setOrg(lease(), NOW);
  assert.deepEqual(told, ['claude:changed']);
  leases.setOrg(lease({ token: TOKEN_A2, expiresAt: NOW + 16 * HOUR }), NOW + 6 * HOUR);
  assert.deepEqual(told, ['claude:changed', 'claude:renewed']);
  assert.equal(timers.pending.has(first), false, 'the old timer went with the old lease');
  leases.setOrg(
    lease({ token: TOKEN_A2, expiresAt: NOW + 16 * HOUR, gateways: { anthropic: 'https://other.example.test' } }),
    NOW + 6 * HOUR,
  );
  assert.equal(told.at(-1), 'claude:changed', 'other gateways are a new credential');
  const [live] = [...timers.pending.keys()];
  timers.fire(live);
  assert.equal(leases.hasOrg('claude'), false);
  assert.equal(told.at(-1), 'claude:changed');
  // a timer whose lease was already replaced does nothing
  leases.setOrg(lease(), NOW);
  const stale = [...timers.pending.keys()][0];
  const staleFn = timers.pending.get(stale)!.fn;
  leases.setOrg(lease({ token: TOKEN_A2 }), NOW);
  const before = told.length;
  staleFn();
  assert.equal(told.length, before);
  assert.equal(leases.orgLease('claude')?.token, TOKEN_A2);
});

test('W: two identities on one Host hold separate leases; the newest message picks the one in use; signing A out leaves B', () => {
  const timers = fakeTimers();
  const leases = createCredentialLeases(timers);
  const told: string[] = [];
  leases.onChange((h, change) => told.push(`${h}:${change}`));
  leases.setOrg(lease(), NOW);
  leases.setOrg(lease({ identity: B, token: TOKEN_B }), NOW);
  assert.deepEqual(told, ['claude:changed', 'claude:switched']);
  assert.equal(leases.orgLease('claude')?.token, TOKEN_B, 'B is in use');
  assert.equal(leases.orgLease('claude', A)?.token, TOKEN_A, "A's lease is kept for A, never handed to B");
  // A's message again: back to A's lease, never B's
  leases.setOrg(lease(), NOW);
  assert.equal(told.at(-1), 'claude:switched');
  assert.equal(leases.orgLease('claude')?.token, TOKEN_A);
  // B signs out while A is in use: A is untouched and nobody is told
  const n = told.length;
  assert.deepEqual(leases.setOrg({ harness: 'claude', identity: B, token: null }, NOW), { held: false });
  assert.equal(told.length, n);
  assert.equal(leases.orgLease('claude', B), null);
  assert.equal(leases.orgLease('claude')?.token, TOKEN_A);
  // A signs out while in use: the harness has no lease in use, and is told
  leases.setOrg(lease({ identity: B, token: TOKEN_B }), NOW);
  leases.setOrg(lease(), NOW);
  leases.setOrg({ harness: 'claude', identity: A, token: null }, NOW);
  assert.equal(told.at(-1), 'claude:changed');
  assert.equal(leases.hasOrg('claude'), false, 'B is not put in use by A leaving');
  assert.equal(leases.orgLease('claude', B)?.token, TOKEN_B, "B's lease stays for B's next message");
  // taking back a lease nobody holds tells nobody
  const m = told.length;
  leases.setOrg({ harness: 'codex', identity: A, token: null }, NOW);
  assert.equal(told.length, m);
  // B's lease running out while A is in use drops B's and tells nobody
  const fresh = fakeTimers();
  const two = createCredentialLeases(fresh);
  const heard: string[] = [];
  two.setOrg(lease({ identity: B, token: TOKEN_B }), NOW);
  const bTimer = [...fresh.pending.keys()][0];
  two.setOrg(lease(), NOW);
  two.onChange((h) => heard.push(h));
  fresh.fire(bTimer);
  assert.deepEqual(heard, []);
  assert.equal(two.orgLease('claude', B), null);
  assert.equal(two.orgLease('claude')?.token, TOKEN_A);
});

test('A: clear drops every key and lease and tells each harness once', () => {
  const timers = fakeTimers();
  const leases = createCredentialLeases(timers);
  leases.set('codex', 'sk-dummy-0000-test-key-openai-abcd');
  leases.setOrg(lease(), NOW);
  leases.setOrg(lease({ harness: 'acp', identity: B, token: TOKEN_B }), NOW);
  const told: string[] = [];
  const off = leases.onChange((h) => told.push(h));
  leases.clear();
  assert.deepEqual(told.sort(), ['acp', 'claude', 'codex']);
  assert.equal(timers.pending.size, 0);
  assert.deepEqual([leases.hasOrg('claude'), leases.has('codex')], [false, false]);
  off();
  leases.clear();
  assert.equal(told.length, 3);
  // the default timers are real ones that do not hold the process open
  const real = createCredentialLeases();
  real.setOrg(lease({ expiresAt: Date.now() + HOUR }), Date.now());
  real.clear();
});

test('host.orgLease: a Host with leases holds it in memory only; an end without the feature is refused; a Host without leases says so', async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 'p-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }) };
  const leases = createCredentialLeases();
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({}), leases }).connection(() => undefined);
  await conn.call('host.hello', S.helloParams());
  const live = lease({ expiresAt: Date.now() + HOUR });
  assert.deepEqual(await conn.call('host.orgLease', live), { held: true });
  assert.equal(leases.orgLease('claude')?.token, TOKEN_A);
  const onDisk = fs
    .readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, String(f)))
    .filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  assert.doesNotMatch(onDisk, /dummy-org-token/);
  assert.deepEqual(await conn.call('host.orgLease', { harness: 'claude', identity: A, token: null }), { held: false });
  leases.clear();
  const old = createProtocol({ runtime, epochs, guard, status: () => ({}), leases }).connection(() => undefined);
  await old.call('host.hello', { ...S.helloParams(), features: S.FEATURES.filter((f: string) => f !== 'orgCredentials') });
  await assert.rejects(old.call('host.orgLease', live), (e: any) => e.code === 'feature_missing');
  const none = createProtocol({ runtime, epochs, guard, status: () => ({}) }).connection(() => undefined);
  await none.call('host.hello', S.helloParams());
  await assert.rejects(none.call('host.orgLease', live), (e: any) => e.code === 'unsupported' && !String(e.message).includes(TOKEN_A));
});
