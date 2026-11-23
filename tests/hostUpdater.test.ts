// Updating a machine's Host from the app (electron/host/hostUpdate.cjs, machines.updateHost, host:update): the app signs a manifest for that Host with its key, sends the archive and the manifest over ssh and runs `update` there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MAX_VALIDITY_MS, checkManifest } from '../shared/host/updateSignature.mjs';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { keySafe, openKeyFile } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createHostUpdater, VALID_MS, STATUS_MS } = require('../electron/host/hostUpdate.cjs');
const { loadIdentity } = require('../electron/host/pairingClient.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-updater-'));
const FILE = path.join(dir, 'host.tgz');
const BYTES = Buffer.from('a Host tarball');
fs.writeFileSync(FILE, BYTES);
const SHA = createHash('sha256').update(BYTES).digest('hex');
const HOST_ID = 'ab'.repeat(16);
const identity = loadIdentity(path.join(dir, 'key.json'), keySafe);
const publicPem = (await import('node:crypto'))
  .createPublicKey({ key: Buffer.from(identity.publicKey, 'base64'), format: 'der', type: 'spki' })
  .export({ type: 'spki', format: 'pem' })
  .toString();

function world(t: any, o: { hostKey?: string; fail?: (command: string) => boolean; build?: string; status?: () => object } = {}) {
  const clock = installFakeClock(t, 1_700_000_000_000);
  const ran: { destination: string; command: string; input?: Buffer }[] = [];
  const built: string[] = [];
  const channel = async (destination: string, command: string, input?: Buffer) => {
    ran.push({ destination, command, input });
    return o.fail?.(command)
      ? { code: 1, stdout: '', stderr: 'disk full' }
      : {
          code: 0,
          stdout: command.includes('process.report')
            ? `${o.build ?? 'linux-x64-gnu'}\n`
            : command.includes('update --manifest')
              ? 'Staged version 9.9.9.\n'
              : '',
          stderr: '',
        };
  };
  const registry = {
    list: () => [{ id: 'ssh:me@box', address: 'me@box' }],
    hostKey: () => o.hostKey ?? HOST_ID,
  };
  const updater = createHostUpdater({
    session: async () => ({ close: () => undefined }),
    allowed: () => true,
    channel,
    registry,
    bundle: async (build: string) => {
      built.push(build);
      return { file: FILE, sha256: SHA, version: '9.9.9' };
    },
    identity: () => identity,
    ...(o.status && { status: async () => o.status?.(), isNewer: (r: any) => r.hostAppVersion > '0.4.27' }),
  });
  return { ran, updater, built, clock };
}

test('a machine with no build gets nothing: the update fails in words and its Host goes on running what it has (A)', async (t) => {
  const cases: [object, RegExp][] = [
    [{ build: 'linux-ppc64-gnu' }, /no Host build for this machine \(linux-ppc64-gnu\); a Host already on it keeps running\.$/],
    // a question that failed is not an unsupported machine
    [{ fail: (c: string) => c.includes('process.report') }, /^Could not ask this machine which Host build it needs: disk full\.$/i],
  ];
  for (const [o, words] of cases) {
    const w = world(t, o);
    await assert.rejects(w.updater.update('ssh:me@box'), (e: any) => {
      assert.equal(e.code, 'update_failed');
      assert.match(e.message, words);
      return true;
    });
    assert.deepEqual(w.built, []);
    assert.equal(w.ran.length, 1, 'only the question was sent: no archive, no manifest, no `update`');
  }
});

test('#4923: a Host that says it is newer right now is not replaced, whatever the registry last said; nothing is sent', async (t) => {
  const newer = world(t, { status: () => ({ build: 'b9', appVersion: '0.5.0' }) });
  await assert.rejects(newer.updater.update('ssh:me@box'), (e: any) => e.code === 'host_newer' && /newer than this app/.test(e.message));
  assert.deepEqual(newer.ran, [], 'not even the build question went out');
  assert.deepEqual(newer.built, []);
});

test('#4923: a Host that does not answer the live question in time, or fails it, is judged by the registry as before: no evidence, no refusal', async (t) => {
  const silent = world(t, { status: () => new Promise(() => undefined) });
  const pending = silent.updater.update('ssh:me@box');
  await Promise.resolve();
  silent.clock.advance(STATUS_MS);
  assert.equal((await pending).version, '9.9.9');
  const failing = world(t, {
    status: () => {
      throw new Error('tunnel down');
    },
  });
  assert.equal((await failing.updater.update('ssh:me@box')).version, '9.9.9');
});

test('#4923: a Host that says it is older, or says nothing, is updated as before', async (t) => {
  const w = world(t, { status: () => ({ build: 'b1', appVersion: '0.4.0' }) });
  assert.equal((await w.updater.update('ssh:me@box')).version, '9.9.9');
});

test('#4923: a Host that says nothing of itself is updated as before', async (t) => {
  const w = world(t, { status: () => ({}) });
  assert.equal((await w.updater.update('ssh:me@box')).version, '9.9.9');
});

test('M1: the archive and a manifest signed for that Host go to the machine, `update` runs there, and the files are removed; the Host accepts exactly that manifest', async (t) => {
  const w = world(t);
  const out = await w.updater.update('ssh:me@box');
  assert.deepEqual(out, { version: '9.9.9', output: 'Staged version 9.9.9.' });
  assert.deepEqual(
    w.ran.map((r) => r.destination),
    ['me@box', 'me@box', 'me@box', 'me@box'],
  );
  const [probe, archive, manifestUpload, update] = w.ran;
  // the archive is the one for the build the Host's own Node names
  assert.match(probe.command, /"\$\(\[ -x .*\)" -e 'process\.report/);
  assert.deepEqual(w.built, ['linux-x64-gnu']);
  const name = `host-${SHA.slice(0, 16)}.tgz`;
  assert.equal(archive.command, `mkdir -p "$HOME/.mopilot-host/incoming" && cat > "$HOME/.mopilot-host/incoming/${name}"`);
  assert.deepEqual(archive.input, BYTES);
  assert.equal(manifestUpload.command, 'cat > "$HOME/.mopilot-host/incoming/manifest.json"');
  assert.match(
    update.command,
    // on MoPilot's own Node when the install put it there, else the machine's node (a Host installed before it)
    /^"\$\(\[ -x "\$HOME\/\.mopilot-host\/runtime\/current\/bin\/node" \] && echo "\$HOME\/\.mopilot-host\/runtime\/current\/bin\/node" \|\| echo node\)" "\$HOME\/\.mopilot-host\/current\/host\/bin\/mopilot-host\.mjs" update --manifest "\$HOME\/\.mopilot-host\/incoming\/manifest\.json"; s=\$\?; rm -f .*; exit \$s$/,
  );
  const manifest = JSON.parse(String(manifestUpload.input));
  assert.deepEqual(
    { ...manifest, signature: undefined },
    {
      version: '9.9.9',
      sha256: SHA,
      url: name,
      hostId: HOST_ID,
      seq: 1_700_000_000_000,
      notAfter: 1_700_000_000_000 + VALID_MS,
      signature: undefined,
    },
  );
  // what the Host checks, with the app's key as the one it trusts (it learned it at pairing and at install)
  const now = 1_700_000_000_000;
  const o = { keys: [publicPem], hostId: HOST_ID, now, floor: null };
  assert.equal((checkManifest(manifest, o) as any).ok, true);
  assert.match((checkManifest(manifest, { ...o, hostId: 'cd'.repeat(16) }) as any).message, /another Host/, 'not for any other Host');
  assert.match((checkManifest(manifest, { ...o, now: now + VALID_MS + 1 }) as any).message, /expired/, 'and not for long');
  assert.ok(VALID_MS < MAX_VALIDITY_MS);
});

test('M1: a machine that is not in the list, one that was never paired, and a step that fails are refusals with a code; nothing is sent to a machine that cannot be named', async (t) => {
  const w = world(t);
  await assert.rejects(w.updater.update('nope'), { code: 'unknown_machine' });
  const unpaired = world(t, { hostKey: '' });
  await assert.rejects(unpaired.updater.update('ssh:me@box'), { code: 'not_paired', message: /Pair this machine/ });
  assert.equal(unpaired.ran.length, 0);
  assert.equal(w.ran.length, 0);
  for (const step of ['cat > "$HOME/.mopilot-host/incoming/host-', 'manifest.json"', 'update --manifest']) {
    const f = world(t, { fail: (c) => c.includes(step) });
    await assert.rejects(f.updater.update('ssh:me@box'), { code: 'update_failed', message: /Disk full/ });
  }
  const silent = createHostUpdater({
    session: async () => ({ close: () => undefined }),
    allowed: () => true,
    channel: async () => ({ code: 1, stdout: '', stderr: '' }),
    registry: { list: () => [{ id: 'm', address: 'a' }], hostKey: () => HOST_ID },
    bundle: async () => ({ file: FILE, sha256: SHA, version: '1' }),
    identity: () => identity,
  });
  await assert.rejects(silent.update('m'), { code: 'update_failed', message: /command failed/i });
});

test('M1: host:update is the window’s way to it, refused while Host is not allowed', async () => {
  const handlers = new Map<string, any>();
  const asked: string[] = [];
  let allowed = true;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined, live: {} },
    {
      create: () => ({
        list: () => ({ machines: [], resolved: true }),
        updateHost: async (id: string) => (asked.push(id), { version: '1', output: '' }),
      }),
      allowed: () => allowed,
    },
  );
  assert.deepEqual(await handlers.get('host:update')({}, 'ssh:me@box'), { value: { version: '1', output: '' } });
  assert.deepEqual(await handlers.get('host:update')({}, undefined), { value: { version: '1', output: '' } });
  assert.deepEqual(asked, ['ssh:me@box', '']);
  allowed = false;
  assert.equal((await handlers.get('host:update')({}, 'ssh:me@box')).error.code, 'not_allowed');
});

test('M1: machines.updateHost builds this app’s Host archive, signs for the machine’s Host with the app’s own key, and is refused while Host is not allowed', async (t) => {
  const { createMachines } = require('../electron/host/machines.cjs');
  const clock = installFakeClock(t, 1_700_000_000_000);
  const udir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-update-'));
  t.after(() => fs.rmSync(udir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(udir, 'host-registry.json'),
    JSON.stringify({ version: 1, hosts: [{ id: 'box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', hostKey: HOST_ID }] }),
  );
  const sent: { command: string; input?: Buffer }[] = [];
  let allowed = true;
  const root = path.join(udir, 'app');
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('host/package.json', JSON.stringify({ version: '0.0.9' }));
  put('host/bin/mopilot-host.mjs', 'export {};');
  put('build/vendor/host-core/linux-x64-gnu/mopilot_core.node', 'an addon');
  const m = createMachines({
    safeStorage: keySafe,
    dir: udir,
    root,
    // the machine answers its status like a Host does (a real tunnel to me@box would never)
    call: async () => ({}),
    session: async () => ({ call: async () => ({}), close: () => undefined }),
    allowed: () => allowed,
    watch: () => undefined,
    installer: {},
    channel: async (_d: string, command: string, input?: Buffer) => (
      sent.push({ command, input }), { code: 0, stdout: command.includes('process.report') ? 'linux-x64-gnu\n' : '', stderr: '' }
    ),
  });
  t.after(() => m.dispose());
  const out = await m.updateHost('box');
  assert.match(out.version, /^\d+\.\d+\.\d+/);
  const manifest = JSON.parse(String(sent[2].input));
  const key = openKeyFile(path.join(udir, 'host-client-key.json')).publicKey;
  const pem = (await import('node:crypto'))
    .createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
    .export({ type: 'spki', format: 'pem' })
    .toString();
  assert.equal(
    (checkManifest(manifest, { keys: [pem], hostId: HOST_ID, now: clock.now(), floor: null }) as any).ok,
    true,
    'signed by the key the machine was given at install',
  );
  allowed = false;
  await assert.rejects(m.updateHost('box'), (e: any) => e.code === 'not_allowed');
  assert.equal(sent.length, 4);
});

test('a machine joined by command has no ssh: its update is refused in words, nothing is sent', async (t) => {
  const w = world(t);
  const relay = createHostUpdater({
    session: async () => ({ close: () => undefined }),
    allowed: () => true,
    channel: async () => assert.fail('nothing is sent'),
    registry: { list: () => [{ id: 'r1', address: 'relay:abc' }], hostKey: () => HOST_ID },
    bundle: async () => assert.fail('nothing is built'),
    identity: () => identity,
  });
  await assert.rejects(relay.update('r1'), (e: any) => e.code === 'unsupported' && /no ssh/.test(e.message));
  assert.equal(w.ran.length, 0);
});
