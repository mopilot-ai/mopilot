// relay/src/config.mjs: the environment becomes one frozen config, and every unusable combination is refused with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../relay/src/config.mjs';

const base = { AUTH_PUBLIC_KEY: 'pem\\nline', DATABASE_URL: 'postgres://x' };

test('defaults: port, 7-day mailbox, no push, issuer of the desktop JWT', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 8787);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.auth.publicKeyPem, 'pem\nline');
  assert.equal(c.auth.issuer, 'https://code.mopilot.ai');
  assert.equal(c.auth.audience, 'relay');
  assert.equal(c.auth.revokeAudience, 'relay-revoke');
  assert.equal(c.mailbox.ttlMs, 7 * 24 * 3600_000);
  assert.deepEqual(c.push, {
    mode: 'none',
    proxyUrl: '',
    proxyToken: '',
    timeoutMs: 10_000,
    breakerFailures: 5,
    breakerCooldownMs: 30_000,
    maxInFlight: 32,
  });
  assert.equal(c.pairJoinMs, 180_000);
  assert.equal(c.pingMs, 30_000);
  assert.ok(Object.isFrozen(c));
});

test('every value can be set', () => {
  const c = loadConfig({
    AUTH_JWKS_URL: 'https://j',
    DATABASE_URL: 'd',
    HOST: '127.0.0.1',
    PORT: '9',
    AUTH_ISSUER: 'i',
    AUTH_AUDIENCE: 'a',
    AUTH_REVOKE_AUDIENCE: 'r',
    MAILBOX_TTL_DAYS: '1',
    MAILBOX_MAX_FRAMES: '2',
    MAILBOX_MAX_BYTES: '3',
    PAIR_JOIN_SECONDS: '4',
    PING_SECONDS: '5',
    SWEEP_SECONDS: '6',
    DB_POOL_MAX: '7',
    DB_STATEMENT_TIMEOUT_SECONDS: '8',
    SHUTDOWN_SECONDS: '9',
    AUTH_CLOCK_TOLERANCE_SECONDS: '12',
    MAX_CONNECTIONS: '11',
    MAX_CONNECTIONS_PER_ACCOUNT: '12',
    CONN_FRAMES_PER_SECOND: '13',
    CONN_FRAME_BURST: '14',
    PAIR_FRAMES_PER_SECOND: '15',
    PAIR_FRAME_BURST: '16',
    CONN_MESSAGES_PER_SECOND: '17',
    CONN_MESSAGE_BURST: '18',
    CONN_RECEIPTS_PER_SECOND: '21',
    CONN_RECEIPT_BURST: '22',
    CONNECTS_PER_SECOND: '23',
    CONNECT_BURST: '24',
    RATE_WAIT_MAX_SECONDS: '25',
    MAILBOX_GLOBAL_MAX_FRAMES: '19',
    MAILBOX_GLOBAL_MAX_BYTES: '20',
    HOSTS_PER_ACCOUNT: '26',
    HOST_AUTH_PER_SECOND: '27',
    HOST_AUTH_BURST: '28',
    HOST_AUTH_ADDRESS_PER_SECOND: '29',
    HOST_AUTH_ADDRESS_BURST: '30',
    PUSH_MODE: 'proxy',
    PUSH_PROXY_URL: 'https://p',
    PUSH_PROXY_TOKEN: 't',
    PUSH_TIMEOUT_SECONDS: '3',
    PUSH_BREAKER_FAILURES: '4',
    PUSH_BREAKER_COOLDOWN_SECONDS: '5',
    PUSH_MAX_IN_FLIGHT: '6',
    MAILBOX_ACCOUNT_MAX_FRAMES: '31',
    MAILBOX_ACCOUNT_MAX_BYTES: '32',
    PAIRS_PER_ACCOUNT: '33',
    BOOTS_PER_DAY: '34',
    AUTH_ACCESS_AUDIENCE: 'x',
  });
  assert.deepEqual(
    [c.host, c.port, c.auth.jwksUrl, c.auth.issuer, c.auth.audience, c.auth.revokeAudience, c.auth.accessAudience],
    ['127.0.0.1', 9, 'https://j', 'i', 'a', 'r', 'x'],
  );
  assert.deepEqual(
    [c.mailbox.ttlMs, c.mailbox.maxFrames, c.mailbox.maxBytes, c.pairJoinMs, c.pingMs, c.sweepMs],
    [86_400_000, 2, 3, 4000, 5000, 6000],
  );
  assert.deepEqual(c.push, {
    mode: 'proxy',
    proxyUrl: 'https://p',
    proxyToken: 't',
    timeoutMs: 3000,
    breakerFailures: 4,
    breakerCooldownMs: 5000,
    maxInFlight: 6,
  });
  const defaults = loadConfig({ AUTH_JWKS_URL: 'https://j', DATABASE_URL: 'd' }).push;
  assert.deepEqual(
    [defaults.timeoutMs, defaults.breakerFailures, defaults.breakerCooldownMs, defaults.maxInFlight],
    [10_000, 5, 30_000, 32],
  );
  assert.equal(loadConfig({ AUTH_JWKS_URL: 'https://j', DATABASE_URL: 'd', PUSH_MODE: 'dryrun' }).push.mode, 'dryrun');
  assert.deepEqual([c.db.poolMax, c.db.statementTimeoutMs, c.shutdownMs], [7, 8000, 9000]);
  assert.equal(c.auth.clockToleranceS, 12);
  assert.deepEqual(c.limits, {
    maxConnections: 11,
    maxConnectionsPerAccount: 12,
    frameRate: 13,
    frameBurst: 14,
    pairFrameRate: 15,
    pairFrameBurst: 16,
    controlRate: 17,
    controlBurst: 18,
    receiptRate: 21,
    receiptBurst: 22,
    connectRate: 23,
    connectBurst: 24,
    maxWaitMs: 25_000,
    globalMaxFrames: 19,
    globalMaxBytes: 20,
    accountMaxFrames: 31,
    accountMaxBytes: 32,
    pairsPerAccount: 33,
    bootsPerDay: 34,
    hostsPerAccount: 26,
    hostAuthRate: 27,
    hostAuthBurst: 28,
    hostAddressRate: 29,
    hostAddressBurst: 30,
  });
  const d = loadConfig({ AUTH_JWKS_URL: 'https://j', DATABASE_URL: 'd' });
  assert.deepEqual(
    [d.limits.accountMaxFrames, d.limits.accountMaxBytes, d.limits.pairsPerAccount, d.auth.accessAudience],
    [10_000, 128 * 1024 ** 2, 32, 'relay-access'],
  );
  assert.deepEqual([d.db.poolMax, d.db.statementTimeoutMs, d.shutdownMs], [10, 15_000, 8000]);
  assert.equal(d.auth.clockToleranceS, 5);
  assert.deepEqual([d.limits.maxConnections, d.limits.frameRate, d.limits.globalMaxBytes], [5000, 100, 2 * 1024 ** 3]);
});

test('refusals', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'd' }), /AUTH_PUBLIC_KEY/);
  assert.throws(() => loadConfig({ ...base, AUTH_JWKS_URL: 'https://j' }), /only one/);
  assert.throws(() => loadConfig({ AUTH_PUBLIC_KEY: 'k' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), /PORT must be a positive integer/);
  assert.throws(() => loadConfig({ ...base, PORT: '0' }), /PORT/);
  assert.throws(() => loadConfig({ ...base, DB_POOL_MAX: '-1' }), /DB_POOL_MAX must be a positive integer/);
  assert.throws(() => loadConfig({ ...base, CONN_FRAMES_PER_SECOND: '0' }), /CONN_FRAMES_PER_SECOND must be a positive integer/);
  // the clock tolerance may be 0, but not a minute or more (a token the relay takes could then be closed as expired at once)
  assert.equal(loadConfig({ ...base, AUTH_CLOCK_TOLERANCE_SECONDS: '0' }).auth.clockToleranceS, 0);
  for (const bad of ['60', '-1', '1.5', 'abc'])
    assert.throws(
      () => loadConfig({ ...base, AUTH_CLOCK_TOLERANCE_SECONDS: bad }),
      /AUTH_CLOCK_TOLERANCE_SECONDS must be a whole number from 0 to 59/,
    );
  assert.throws(() => loadConfig({ ...base, PUSH_MODE: 'direct' }), /APNS_KEY/);
  assert.throws(() => loadConfig({ ...base, PUSH_MODE: 'smoke' }), /none, proxy, direct or dryrun/);
  assert.throws(() => loadConfig({ ...base, PUSH_TIMEOUT_SECONDS: '0' }), /PUSH_TIMEOUT_SECONDS must be a positive integer/);
  assert.throws(() => loadConfig({ ...base, PUSH_MODE: 'proxy' }), /PUSH_PROXY_URL/);
});

test('the public key can be mounted as a file', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'relay-key-')), 'key.pem');
  writeFileSync(file, '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n');
  const c = loadConfig({ AUTH_PUBLIC_KEY_FILE: file, DATABASE_URL: 'd' });
  assert.match(c.auth.publicKeyPem, /^-----BEGIN PUBLIC KEY-----\nabc\n/);
  // an inline key wins over the file
  assert.equal(loadConfig({ AUTH_PUBLIC_KEY: 'inline', AUTH_PUBLIC_KEY_FILE: file, DATABASE_URL: 'd' }).auth.publicKeyPem, 'inline');
});

test('direct push reads the APNs p8 key and the FCM service account, inline or from files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-push-'));
  const p8 = path.join(dir, 'AuthKey.p8');
  writeFileSync(p8, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
  const sa = { client_email: 'e', private_key: 'k\n-----END-----\n', project_id: 'p', token_uri: 'https://t' };
  const saFile = path.join(dir, 'sa.json');
  writeFileSync(saFile, JSON.stringify(sa));
  const apns = { APNS_KEY_FILE: p8, APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_TOPIC: 'ai.app', APNS_SANDBOX: '1' };
  const c = loadConfig({ ...base, PUSH_MODE: 'direct', ...apns, FCM_SERVICE_ACCOUNT_FILE: saFile });
  assert.equal((c.push as any).mode, 'direct');
  assert.deepEqual(
    [
      (c.push as any).apns!.keyId,
      (c.push as any).apns!.teamId,
      (c.push as any).apns!.topic,
      (c.push as any).apns!.sandbox,
      (c.push as any).apns!.keyPem.startsWith('-----BEGIN'),
    ],
    ['K', 'T', 'ai.app', true, true],
  );
  assert.deepEqual({ ...(c.push as any).fcm }, sa);
  const inline = loadConfig({ ...base, PUSH_MODE: 'direct', APNS_KEY: 'a\\nb', APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_TOPIC: 't' });
  assert.equal((inline.push as any).apns!.keyPem, 'a\nb');
  assert.equal((inline.push as any).apns!.sandbox, false);
  assert.equal((inline.push as any).fcm, null);
  const fcmOnly = loadConfig({ ...base, PUSH_MODE: 'direct', FCM_SERVICE_ACCOUNT: JSON.stringify({ ...sa, token_uri: undefined }) });
  assert.equal((fcmOnly.push as any).apns, null);
});

test('direct push refuses missing or malformed credentials', () => {
  const direct = { ...base, PUSH_MODE: 'direct' };
  assert.throws(() => loadConfig({ ...direct, APNS_KEY: 'k' }), /APNS_KEY_ID, APNS_TEAM_ID and APNS_TOPIC/);
  assert.throws(() => loadConfig({ ...direct, FCM_SERVICE_ACCOUNT: '{' }), /not valid JSON/);
  assert.throws(() => loadConfig({ ...direct, FCM_SERVICE_ACCOUNT: '{"client_email":"e"}' }), /client_email, private_key and project_id/);
  assert.throws(() => loadConfig({ ...direct, FCM_SERVICE_ACCOUNT: 'null' }), /client_email, private_key and project_id/);
});

test('the durable mailbox is on unless DURABLE_MAILBOX=0', () => {
  assert.equal(loadConfig(base).durable, true);
  assert.equal(loadConfig({ ...base, DURABLE_MAILBOX: '1' }).durable, true);
  assert.equal(loadConfig({ ...base, DURABLE_MAILBOX: '0' }).durable, false);
});
