// Two APNs credential sets (#5251), config side: the second set's names, an inline or file key, the refusals at start, and the preflight
// one-liner the README gives the operator, run the way the operator runs it. relay/src/{config,pushSenders}.mjs; no network and no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { apnsSetsOf, loadConfig } from '../relay/src/config.mjs';
import { REPO } from './support/scripts-shared-cli.ts';

const OLD = 'ai.mopilot.remote';
const NEW = 'ai.mopilot.phone';
const pemOf = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const base = { AUTH_JWKS_URL: 'https://x/jwks', DATABASE_URL: 'd', PUSH_MODE: 'direct' };
const first = { APNS_KEY: 'k1', APNS_KEY_ID: 'K1', APNS_TEAM_ID: 'T1', APNS_TOPIC: OLD };
const second = { APNS2_KEY: 'k2\\nline', APNS2_KEY_ID: 'K2', APNS2_TEAM_ID: 'T2', APNS2_TOPIC: NEW, APNS2_SANDBOX: '1' };

test('config: the default set alone is what it was; a second set follows it, with its own sandbox flag', () => {
  const one = loadConfig({ ...base, ...first }).push as any;
  assert.deepEqual([one.apns.topic, one.apnsSets.length], [OLD, 1]);
  const two = loadConfig({ ...base, ...first, ...second }).push as any;
  assert.deepEqual(
    two.apnsSets.map((s: any) => [s.topic, s.keyId, s.teamId, s.sandbox, s.keyPem]),
    [
      [OLD, 'K1', 'T1', false, 'k1'],
      [NEW, 'K2', 'T2', true, 'k2\nline'],
    ],
  );
  assert.equal(two.apns, two.apnsSets[0]);
  // the second alone is the only set; leftover default names without a key are ignored as before
  const only = loadConfig({ ...base, ...second, APNS_KEY_ID: 'x' }).push as any;
  assert.deepEqual(
    only.apnsSets.map((s: any) => s.topic),
    [NEW],
  );
  assert.equal(apnsSetsOf({ apns: only.apns })[0].topic, NEW);
  assert.deepEqual(apnsSetsOf({}), []);
  assert.equal(
    (loadConfig({ ...base, FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'e', private_key: 'k', project_id: 'p' }) }).push as any)
      .apnsSets.length,
    0,
  );
  assert.equal((loadConfig({ AUTH_JWKS_URL: 'https://x/jwks', DATABASE_URL: 'd' }).push as any).apnsSets, undefined);
});

test('config: a partial second set, or two sets with one topic, stops the relay from starting', () => {
  assert.throws(() => loadConfig({ ...base, ...first, APNS2_KEY: 'k' }), /APNS2_KEY needs APNS2_KEY_ID, APNS2_TEAM_ID and APNS2_TOPIC/);
  assert.throws(
    () => loadConfig({ ...base, ...first, ...second, APNS2_TEAM_ID: '' }),
    /APNS2_KEY needs APNS2_KEY_ID, APNS2_TEAM_ID and APNS2_TOPIC/,
  );
  for (const name of ['APNS2_KEY_ID', 'APNS2_TEAM_ID', 'APNS2_TOPIC', 'APNS2_SANDBOX'])
    assert.throws(() => loadConfig({ ...base, ...first, [name]: '1' }), /APNS2_KEY\(_FILE\) is missing/);
  assert.throws(() => loadConfig({ ...base, ...first, ...second, APNS2_TOPIC: OLD }), /Each APNs set needs its own topic/);
  // the default set's own rule is unchanged
  assert.throws(() => loadConfig({ ...base, ...second, APNS_KEY: 'k' }), /APNS_KEY needs APNS_KEY_ID, APNS_TEAM_ID and APNS_TOPIC/);
});

test('config: the second key may be inline with \\n escapes, as the relay.env of the box holds it, or a file', () => {
  const key = pemOf();
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-apns2-'));
  const file = path.join(dir, 'AuthKey2.p8');
  writeFileSync(file, key);
  const names = { APNS2_KEY_ID: 'K2', APNS2_TEAM_ID: 'T2', APNS2_TOPIC: NEW };
  const inline = loadConfig({ ...base, ...first, ...names, APNS2_KEY: key.trim().replace(/\n/g, '\\n') }).push as any;
  const filed = loadConfig({ ...base, ...first, ...names, APNS2_KEY_FILE: file }).push as any;
  assert.equal(inline.apnsSets[1].keyPem, key.trim());
  assert.equal(filed.apnsSets[1].keyPem, key);
});

/** the preflight one-liner the README tells the operator to run through the built image, run here the same way with the same kind of env */
const preflight = () => {
  const readme = readFileSync(path.join(REPO, 'relay/README.md'), 'utf8');
  const program = /node --input-type=module -e "([^"\n]+)"\n\s*```/.exec(readme)?.[1];
  assert.ok(program, 'the README has the preflight command');
  return (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: path.join(REPO, 'relay'),
      env: {
        PATH: process.env.PATH ?? '',
        AUTH_JWKS_URL: 'https://x/jwks',
        DATABASE_URL: 'postgres://unused',
        PUSH_MODE: 'direct',
        ...env,
      },
      encoding: 'utf8',
    });
};

test('the README preflight lists the sets for a good env, and stops with the reason, never the key, for a partial or unparsable second set', () => {
  const run = preflight();
  const key = pemOf().trim().replace(/\n/g, '\\n');
  const good = {
    APNS_KEY: key,
    APNS_KEY_ID: 'K1',
    APNS_TEAM_ID: 'T1',
    APNS_TOPIC: OLD,
    APNS2_KEY: key,
    APNS2_KEY_ID: 'K2',
    APNS2_TEAM_ID: 'T2',
    APNS2_TOPIC: NEW,
  };
  const ok = run(good);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `APNs set ${OLD} T1 K1 production\nAPNs set ${NEW} T2 K2 production\n`);
  const partial = run({ ...good, APNS2_TEAM_ID: '' });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /preflight failed: APNS2_KEY needs APNS2_KEY_ID, APNS2_TEAM_ID and APNS2_TOPIC/);
  const garbage = run({ ...good, APNS2_KEY: 'secret-garbage' });
  assert.equal(garbage.status, 1);
  assert.match(garbage.stderr, new RegExp(`preflight failed: The APNs key of topic ${NEW} is not a valid p8 private key`));
  assert.ok(
    ![ok, partial, garbage].some(
      (r) => `${r.stdout}${r.stderr}`.includes('secret-garbage') || `${r.stdout}${r.stderr}`.includes('PRIVATE'),
    ),
  );
});
