// Secrets in a carry (shared/host/carrySecrets.mjs, shared/host/codeCarry.mjs planCarry and pushCarry, electron/host/codeTransfer.cjs carryPlan; package 3.5): secret-named files are never sent and new files only when the user confirmed the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
import {
  base,
  run,
  roots,
  hostFs,
  host,
  key,
  refusal,
  branches,
  SHA_A,
  code,
  dirtySource,
  where,
  script,
  app,
  world,
  ids,
} from './support/carryKit.ts';
const require = createRequire(import.meta.url);
const C = require('../shared/host/codeCarry.mjs');
const T = require('../shared/host/codeTransfer.mjs');

// ---- secrets: never carried, and new files only when the user confirmed them ----
const X = require('../shared/host/carrySecrets.mjs');

test('M3: more names that hold secrets are recognised (env files by suffix, direnv, Terraform, kubeconfig, keystores, cloud keys, secrets folders)', () => {
  for (const p of [
    'prod.env',
    'config/secrets.env',
    '.envrc',
    'infra/terraform.tfvars',
    'prod.auto.tfvars',
    'terraform.tfstate',
    'terraform.tfstate.backup',
    'kubeconfig',
    'kubeconfig-prod.yaml',
    'app/release.keystore',
    '.pypirc',
    '.docker/config.json',
    '.dockercfg',
    '.s3cfg',
    '.boto',
    '.yarnrc.yml',
    'AuthKey_ABC123.p8',
    'private.gpg',
    'key.asc',
    'firebase-adminsdk-x1-abc.json',
    'service-account.json',
    'my-service_account-prod.json',
    'wp-config.php',
    '.vault_pass',
    '.bash_history',
    'secrets/prod.yaml',
    'deploy/secret/db.txt',
  ])
    assert.equal(X.isSecretPath(p), true, p);
  for (const p of ['envelope.txt', 'src/environment.ts', 'README.md', 'docs/secretary.md', 'keys.ts'])
    assert.equal(X.isSecretPath(p), false, p);
});

test('M3: a secret renamed to a plain name is still skipped, and its old name is not staged', () => {
  const z = ['R  config.txt', '.env', 'R  b.txt', 'a.txt', ' M c.txt'].join('\0');
  assert.deepEqual(X.planOf(z), {
    send: ['b.txt', 'c.txt'],
    untracked: [],
    skipped: ['config.txt'],
    stage: ['b.txt', 'a.txt', 'c.txt'],
  });
});

test('I1: names that say they hold secrets are recognised wherever they sit, and ordinary files are not', () => {
  const secret = [
    '.env',
    '.env.local',
    '.ENV.production',
    'app/.env',
    'a/b/.env.test',
    'server.pem',
    'k/tls.key',
    'cert.p12',
    'cert.pfx',
    'store.jks',
    'my.keystore',
    'putty.ppk',
    'vault.kdbx',
    'id_rsa',
    'id_rsa.pub',
    '.ssh/id_ed25519',
    'home/id_ecdsa',
    'id_dsa',
    'credentials',
    'credentials.json',
    'aws/credentials',
    'Credential.txt'.replace('Credential', 'credentials'),
    'credentials-prod.yml',
    'docs/credentials.md',
    '.npmrc',
    'pkg/.npmrc',
    '.netrc',
    '.pypirc',
    '.git-credentials',
    '.pgpass',
    '.htpasswd',
    'auth.json',
    'config/auth.json',
    'service-account.json',
    'my_service_account.json',
    'tokens.yaml',
    'api-key.txt',
    'github-token.json',
    'secrets.toml',
    'app.secret.ini',
    '.ssh/config',
    '.aws/config',
    '.gnupg/pubring.kbx',
    '.kube/config',
    '.docker/config.json',
    'home/.ssh/known_hosts',
  ];
  for (const p of secret) assert.equal(X.isSecretPath(p), true, p);
  const fine = [
    'src/env.ts',
    'environment.json',
    'README.md',
    'src/auth.ts',
    'token.ts',
    'src/tokenizer.json',
    'keys.md',
    'monkey.txt',
    'turkey.ts',
    'package.json',
    'src/key/index.ts',
    'envrc',
    'src/dotenv.js',
    'author.json',
    'oauth.ts',
  ];
  for (const p of fine) assert.equal(X.isSecretPath(p), false, p);
});

test('planOf reads git status -z: new files, secrets apart, renames with their source, short entries ignored', () => {
  const z = [
    ' M src/a.ts',
    '?? new.txt',
    '?? .env',
    'A  added.ts',
    'R  renamed.ts',
    'old.ts',
    ' M .npmrc',
    'C  copied.ts',
    'orig.ts',
    '?? dir/sp ace.txt',
    '',
    'xx',
  ].join('\0');
  assert.deepEqual(X.planOf(z), {
    send: ['src/a.ts', 'new.txt', 'added.ts', 'renamed.ts', 'copied.ts', 'dir/sp ace.txt'],
    untracked: ['new.txt', 'dir/sp ace.txt'],
    skipped: ['.env', '.npmrc'],
    // the old name of a rename is staged with it, so the target loses the file; a copy keeps its original
    stage: ['src/a.ts', 'new.txt', 'added.ts', 'renamed.ts', 'old.ts', 'copied.ts', 'dir/sp ace.txt'],
  });
  assert.deepEqual(X.planOf(''), { send: [], untracked: [], skipped: [], stage: [] });
});

/** A source with a modified file, a modified tracked secret, and untracked ordinary and secret files. */
function secretWorld() {
  const w = world();
  fs.writeFileSync(path.join(w.source, '.env'), 'TOKEN=1\n');
  run(w.source, 'add', '-f', '.env');
  run(w.source, 'commit', '-qm', 'tracked secret');
  run(w.source, 'push', '-q', 'origin', 'main');
  run(w.target, 'pull', '-q');
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(w.source, '.env'), 'TOKEN=2\n');
  fs.writeFileSync(path.join(w.source, '.env.local'), 'X=1\n');
  fs.mkdirSync(path.join(w.source, 'keys'));
  fs.writeFileSync(path.join(w.source, 'keys', 'deploy.pem'), 'PEM');
  fs.writeFileSync(path.join(w.source, 'notes.txt'), 'plain\n');
  return w;
}

test('B2/I1: secrets (tracked or new) are never in the pushed commit; they are reported by name and stay in the source', async () => {
  const w = secretWorld();
  const plan = await host.carryPlan({ path: w.source });
  assert.deepEqual(plan, {
    untracked: ['notes.txt'],
    // the file git already knew that the carry sends is named too, not only the new one
    changed: plan.changed,
    skipped: ['.env', '.env.local', 'keys/deploy.pem'],
    files: 2,
    unpushed: 0,
    remote: w.remote,
  });
  assert.equal(plan.changed.length, 1);
  assert.ok(!plan.changed.includes('notes.txt') && !plan.changed.some((f: string) => f.startsWith('.env')));
  const pushed = await host.carryPush({ key: key('sec'), path: w.source, untracked: plan.untracked });
  assert.deepEqual([pushed.files, pushed.skipped], [2, plan.skipped]);
  const names = run(w.source, 'ls-tree', '-r', '--name-only', pushed.commit).split('\n');
  assert.deepEqual(
    names.filter((f) => /env|pem/.test(f)),
    ['.env'],
  );
  assert.equal(run(w.source, 'show', `${pushed.commit}:.env`), 'TOKEN=1');
  assert.equal(fs.readFileSync(path.join(w.source, '.env'), 'utf8'), 'TOKEN=2\n');
  await host.carryApply({ key: key('sec'), path: w.target, ...pushed });
  assert.equal(fs.readFileSync(path.join(w.target, '.env'), 'utf8'), 'TOKEN=1\n');
  assert.ok(!fs.existsSync(path.join(w.target, '.env.local')));
  assert.equal(fs.readFileSync(path.join(w.target, 'notes.txt'), 'utf8'), 'plain\n');
});

test('A: a new file that appeared after the list was confirmed stops the carry before anything is pushed', async () => {
  const w = secretWorld();
  const plan = await host.carryPlan({ path: w.source });
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(w.source, `late${i}.txt`), 'x');
  await refusal(host.carryPush({ key: key('late'), path: w.source, untracked: plan.untracked }), C.CARRY_CODES.unconfirmed);
  await assert.rejects(host.carryPush({ key: key('late2'), path: w.source }), (e: any) => /late0\.txt, late1\.txt.*, …$/.test(e.message));
  assert.deepEqual(branches(w.remote), []);
});

test('only secrets changed: nothing to carry, said as no changes', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, '.env'), 'X=1');
  await refusal(host.carryPush({ key: key('onlysec'), path: w.source }), C.CARRY_CODES.noChanges);
  assert.deepEqual(await host.carryPlan({ path: w.source }), {
    untracked: [],
    changed: [],
    skipped: ['.env'],
    files: 0,
    unpushed: 0,
    remote: w.remote,
  });
});

test('a status git cannot read is a refusal, not an empty plan', async () => {
  const fail = script({ status: { ok: false, stderr: 'fatal: index.lock' } });
  await code(C.planCarry(fail.run), C.CARRY_CODES.nothingToCarry);
  await assert.rejects(host.carryPlan({ path: path.join(base, 'gone') }), (e: any) => e.code === 'directory_missing');
  const plain = path.join(roots, `plainplan${ids.n++}`);
  fs.mkdirSync(plain);
  await refusal(host.carryPlan({ path: plain }), C.CARRY_CODES.nothingToCarry);
});

test('over the socket: git.carryPlan answers the plan', async () => {
  const w = secretWorld();
  const paths = createPaths({ dataDir: path.join(base, `d${ids.n++}`), env: {} });
  const server = await startServer({ paths, runtime: { send: async () => ({ ok: true }) } as any, dirs: { hostFs, hostGit: host } });
  try {
    const plan = (await callHost(paths.socketPath, 'git.carryPlan', { path: w.source })) as any;
    assert.deepEqual(plan.result.untracked, ['notes.txt']);
  } finally {
    await server.close();
  }
});

test('codeLines: skipped names are listed (eight at most) whether or not anything was carried', () => {
  const src = { isRepo: true, remote: 'https://github.com/a/b', branch: 'main', head: SHA_A, dirty: 2 };
  const few = T.codeLines({ source: src, carried: 1, skipped: ['.env', 'id_rsa'] });
  assert.ok(few.includes('Not carried over, because they look like secrets: .env, id_rsa.'));
  const many = T.codeLines({ source: src, skipped: Array.from({ length: 10 }, (_, i) => `k${i}.pem`) });
  assert.ok(many.some((l: string) => /k7\.pem, and 2 more\.$/.test(l)));
  assert.ok(!T.codeLines({ source: src }).some((l: string) => /secrets/.test(l)));
});

test("carryPlan and carryChanges: the plan is read from the source Host; new files need the user's confirmation before anything is pushed", async () => {
  const a = app();
  assert.deepEqual(await a.t.carryPlan({ source: dirtySource, sourceHostId: 'A', cwd: '/w' }), {
    untracked: ['n.txt'],
    skipped: ['.env'],
    files: 3,
  });
  for (const source of [null, { ...dirtySource, dirty: 0 }])
    assert.equal(await a.t.carryPlan({ source, sourceHostId: 'A', cwd: '/w' }), null);
  assert.deepEqual(a.calls, ['plan:A:/w']);
  const b = app();
  await assert.rejects(
    b.t.carryChanges({ source: dirtySource, ...where, untracked: ['n.txt'] }),
    (e: any) => e.code === 'carry_unconfirmed',
  );
  assert.deepEqual(b.calls, []);
  assert.deepEqual(await b.t.carryChanges({ source: dirtySource, ...where, untracked: ['n.txt'], confirmed: true, key: 'key-conf-0001' }), {
    carried: 2,
    skipped: ['.env'],
  });
  assert.ok((b.calls as string[]).includes('push:A:/w:key-conf-0001:n.txt'));
  // a confirmation with nothing to confirm is harmless
  assert.equal((await app().t.carryChanges({ source: dirtySource, ...where, confirmed: true })).carried, 2);
});

test('A: one unconfirmed new file is named without an ellipsis', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'only.txt'), 'x');
  await assert.rejects(
    host.carryPush({ key: key('one'), path: w.source }),
    (e: any) => e.code === 'carry_unconfirmed' && /: only\.txt$/.test(e.message),
  );
});
