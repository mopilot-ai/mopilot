// Add by command end to end (#2709), over a real relay: the app starts a command (relayBoot.cjs), the machine fetches its script and
// bundle from the relay's boot path (proxied from the app), and `enroll` (host/src/relayEnroll.mjs) joins with the code. The app's card
// shows the machine's name, system, user and where it connected from; Allow gives both ends one pair root (the Host keeps it in
// relay.json, the app as the machine's relay path) and Deny leaves nothing on either end. The code is in no file, log or output.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { enroll, parseInput, EnrollError } from '../host/src/relayEnroll.mjs';
import { createPairing } from '../host/src/pairing.mjs';
import { makeDb, makeKeys } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createRelayPaths } = require('../electron/host/relayPaths.cjs');
const { createRelayBoot, httpBase } = require('../electron/host/relayBoot.cjs');

const keys = await makeKeys();
const { db, reset } = await makeDb();
const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
const relay = createRelay({
  config,
  db: db as any,
  verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
  send: null,
});
const port = await relay.listen(0, '127.0.0.1');
after(() => relay.close());
const url = `ws://127.0.0.1:${port}/v1/ws`;
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`x${s}`),
  decryptString: (b: Buffer) => b.toString().slice(1),
};
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await wait();
  }
}

async function rig(t: any) {
  await reset();
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/renr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundleFile = path.join(dir, 'bundle.tgz');
  fs.writeFileSync(bundleFile, crypto.randomBytes(400 * 1024));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(bundleFile)).digest('hex');
  const paths = createRelayPaths({
    dir: path.join(dir, 'app'),
    url: () => url,
    getToken: () => keys.sign('u1', 'mac1'),
    safeStorage: safe,
  });
  t.after(() => paths.dispose());
  const views: any[] = [];
  const boot = createRelayBoot({
    lane: paths.lane,
    paths,
    url: () => url,
    bundle: () => ({ file: bundleFile, sha256, version: '9.9.9' }),
    updateKeyPem: () => null,
    onChange: (v: any) => views.push(v),
  });
  t.after(() => boot.dispose());
  return { dir, paths, boot, views, sha256, bundleFile };
}

/** The parts of the command the card shows: the script's URL, its hash, and the code. @param {string} command */
function partsOf(command: string) {
  const url = /curl -fsSL '(\S+)\/v1\/boot\/(b_[\w-]+)' -o/.exec(command)!;
  return {
    base: url[1],
    bootId: url[2],
    sha: /grep -q '\^([0-9a-f]{64}) '/.exec(command)![1],
    code: /sh "\$f" ([\w-]+);/.exec(command)![1],
  };
}

const machine = { hostname: () => 'far-box', platform: () => 'linux', arch: () => 'x64', user: () => 'ops' };

test('a machine joins: the script and bundle through the relay, the card says who it is, Allow gives both ends one root', async (t) => {
  const r = await rig(t);
  const view = await r.boot.start();
  assert.equal(view.state, 'waiting');
  const { base, bootId, sha: scriptSha, code } = partsOf(view.command);
  assert.equal(base, httpBase(url));
  // the machine fetches its script, which is the one the command names by hash, and its bundle
  const script = await (await fetch(`${base}/v1/boot/${bootId}`)).text();
  assert.equal(crypto.createHash('sha256').update(script).digest('hex'), scriptSha);
  assert.match(script, /mopilot_install "\$@"/);
  assert.ok(!script.includes(code), 'the code is not in the script');
  const sha = /mopilot-host\/incoming\/([0-9a-f]{64})\.tgz/.exec(script)![1];
  assert.equal(sha, r.sha256);
  const bundle = Buffer.from(await (await fetch(`${base}/v1/boot/${bootId}/bundle/linux-x64-gnu`)).arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), r.sha256);
  // what the script hands `enroll` on standard input
  const json = /printf '(\{.*\})\\n'/.exec(script)![1].replace('%s', code);
  const input = parseInput(json);
  const configDir = path.join(r.dir, 'host-config');
  const said: string[] = [];
  const pairing = createPairing({ configDir });
  const joined = enroll({ input, configDir, socketPath: '/h/host.sock', pairing, say: (l) => said.push(l), machine });
  await until(() => r.boot.view.state === 'asking', 'the card asks');
  assert.deepEqual(r.boot.view.machine, { name: 'far-box', os: 'linux', arch: 'x64', user: 'ops', ip: '127.0.0.1' });
  const allowed = r.boot.allow();
  assert.equal(allowed.destination, `relay:${input.hostId}`);
  assert.equal(allowed.name, 'far-box');
  assert.equal(allowed.socketPath, '/h/host.sock');
  assert.match(allowed.pairingCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(allowed.hostKey, pairing.hostId());
  assert.deepEqual(await joined, { hostId: input.hostId });
  assert.equal(r.boot.view.state, 'joined');
  assert.throws(
    () => r.boot.allow(),
    (e: any) => e.code === 'no_boot',
  );
  // both ends hold one root; the app has the machine's relay path, pinned to the relay
  const hostRoot = JSON.parse(fs.readFileSync(path.join(configDir, 'relay.json'), 'utf8')).links[0].root;
  assert.ok(r.paths.enrolled(allowed.destination));
  assert.equal(r.paths.modeOf(allowed.destination), 'relay');
  assert.ok(hostRoot);
  // the code is in no file this ran, and in nothing the machine printed
  const files = [
    ...fs.readdirSync(configDir).map((f) => path.join(configDir, f)),
    ...fs.readdirSync(path.join(r.dir, 'app')).map((f) => path.join(r.dir, 'app', f)),
  ];
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(code), `${f} holds the code`);
  assert.ok(said.every((l) => !l.includes(code) && !l.includes(input.secret)));
  assert.deepEqual(said, ['Waiting for MoPilot on your Mac to allow this machine…']);
});

test('Deny tells the machine and revokes its credential; a new start ends the old command; an unknown wrong code never opens', async (t) => {
  const r = await rig(t);
  const view = await r.boot.start();
  const { bootId, code } = partsOf(view.command);
  const script = await (await fetch(`${httpBase(url)}/v1/boot/${bootId}`)).text();
  const json = /printf '(\{.*\})\\n'/.exec(script)![1];
  // a machine with the wrong code: its hello opens nothing on the app
  const wrongCode = 'W'.repeat(22);
  const configDir = path.join(r.dir, 'host-config');
  const wrong = enroll({
    input: parseInput(json.replace('%s', wrongCode)),
    configDir,
    socketPath: '/h/host.sock',
    pairing: createPairing({ configDir }),
    machine,
    waitMs: 1500,
  });
  await assert.rejects(wrong, (e: any) => e instanceof EnrollError && e.code === 'timeout');
  assert.equal(r.boot.view.state, 'waiting');
  // the right one: the user denies
  const right = enroll({
    input: parseInput(json.replace('%s', code)),
    configDir,
    socketPath: '/h/host.sock',
    pairing: createPairing({ configDir }),
    machine,
  });
  await until(() => r.boot.view.state === 'asking', 'the card asks');
  r.boot.deny();
  await assert.rejects(right, (e: any) => e.code === 'denied');
  assert.equal(r.boot.view.state, 'denied');
  assert.equal(fs.existsSync(path.join(configDir, 'relay.json')), false, 'nothing kept on the machine');
  await until(() => r.paths.lane.pendingRevokes().length === 0, 'the credential is revoked');
  const rows = await db.query('SELECT count(*) AS n FROM relay_hosts');
  assert.equal(Number(rows.rows[0].n), 0);
  r.boot.deny();
  // a command started and then replaced: the first is revoked, and its script is gone
  const first = await r.boot.start();
  const firstId = partsOf(first.command).bootId;
  await r.boot.start();
  // the live command keeps its own id on the revoke list until it is allowed; the first one's credential is gone from the relay
  const held = async () => Number((await db.query('SELECT count(*) AS n FROM relay_hosts')).rows[0].n);
  await waitFor(async () => (await held()) === 1, 'one relay host left');
  assert.equal(await held(), 1);
  assert.equal(r.paths.lane.pendingRevokes().length, 1);
  assert.match(await (await fetch(`${httpBase(url)}/v1/boot/${firstId}`)).text(), /expired or was already used/);
});

test('input that is not the command’s is refused without repeating it; a cancelled command ends the wait', async (t) => {
  for (const bad of [
    'not json',
    '{}',
    JSON.stringify({
      relayUrl: 'ws://relay.example/v1/ws',
      hostId: 'h_host0000000000001',
      secret: 'S'.repeat(43),
      pairId: 'p_hostpair01',
      code: 'A'.repeat(22),
    }),
  ]) {
    assert.throws(
      () => parseInput(bad),
      (e: any) => e.code === 'input' && e.message === 'Run the whole command MoPilot showed.',
    );
  }
  const r = await rig(t);
  const view = await r.boot.start();
  const { bootId, code } = partsOf(view.command);
  const script = await (await fetch(`${httpBase(url)}/v1/boot/${bootId}`)).text();
  const input = parseInput(/printf '(\{.*\})\\n'/.exec(script)![1].replace('%s', code));
  // the user ends the command before the machine joins: its credential is revoked, and the machine hears so when it dials
  r.boot.deny();
  await until(() => r.paths.lane.pendingRevokes().length === 0, 'the credential is revoked');
  const configDir = path.join(r.dir, 'host-config');
  await assert.rejects(
    enroll({ input, configDir, socketPath: '/h/host.sock', pairing: createPairing({ configDir }), machine }),
    (e: any) => e.code === 'cancelled',
  );
  // closing the app ends a command here only: its id waits on the revoke list for the next start
  await r.boot.start();
  r.boot.dispose();
  r.boot.dispose();
  assert.equal(r.paths.lane.pendingRevokes().length, 1);
});

test('the first hello is the one Allow answers; the same machine asking again hears the same answer; a start overtaken leaves nothing', async (t) => {
  const r = await rig(t);
  const view = await r.boot.start();
  const { bootId, code } = partsOf(view.command);
  const script = await (await fetch(`${httpBase(url)}/v1/boot/${bootId}`)).text();
  const input = parseInput(/printf '(\{.*\})\\n'/.exec(script)![1].replace('%s', code));
  const configDir = path.join(r.dir, 'host-config');
  const first = enroll({ input, configDir, socketPath: '/h/host.sock', pairing: createPairing({ configDir }), machine });
  await until(() => r.boot.view.state === 'asking', 'the card asks');
  // a second machine with the same command and credential: ignored, the card still shows the first
  const otherDir = path.join(r.dir, 'other-config');
  const second = enroll({
    input,
    configDir: otherDir,
    socketPath: '/h/other.sock',
    pairing: createPairing({ configDir: otherDir }),
    machine: { ...machine, hostname: () => 'intruder' },
    waitMs: 1500,
  });
  await assert.rejects(second, (e: any) => e.code === 'timeout' || e.code === 'cancelled');
  assert.equal(r.boot.view.machine!.name, 'far-box');
  r.boot.allow();
  assert.deepEqual(await first, { hostId: input.hostId });
  assert.ok(r.paths.needsRotation(`relay:${input.hostId}`), 'its credential is still the script’s until it is replaced');
  // a start that is overtaken by Deny while it registers: no command is shown and its credential is revoked
  const pending = r.boot.start();
  r.boot.deny();
  const v = await pending;
  assert.equal(v.state, 'denied');
  const held = async () => Number((await db.query('SELECT count(*) AS n FROM relay_hosts')).rows[0].n);
  await waitFor(async () => (await held()) === 1, 'one relay host left');
  assert.equal(await held(), 1, 'only the joined machine’s credential is left');
});
