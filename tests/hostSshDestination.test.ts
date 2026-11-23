// An ssh address typed as host:port or ssh://user@host:port is one machine ssh is run on with -p (shared/host/sshDestination.mjs), at the add channel, the tunnel and the reachable probe, and a failed add names its cause: the name, the route, the machine's silence, sshd off, keys only, a changed host key (with the fingerprint now and the exact ssh-keygen -R form).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { useFakeProc } from './support/ports/proc.ts';
import { hostWorld } from './support/host-wire-kit.ts';
// @ts-ignore: plain ESM, typed by its .d.mts
import { parseSshAddress, sshTarget, knownHostsName, normalAddress } from '../shared/host/sshDestination.mjs';
// @ts-ignore: plain ESM, typed by its .d.mts
import { explainFailure } from '../shared/host/installFailure.mjs';
const require = createRequire(import.meta.url);
const { createInstaller, createSshChannel, validDestination } = require('../electron/host/install.cjs');
const { reachable } = require('../electron/host/discovery.cjs');

test('every way of typing a machine becomes one address, and what is not one is refused (B1)', () => {
  const same = (raw: string, destination: string) => assert.equal(parseSshAddress(raw)?.destination, destination, raw);
  same('box', 'box');
  same('  me@box  ', 'me@box');
  same('me@box:22', 'me@box');
  same('me@box:2222', 'me@box:2222');
  same('box:2222', 'box:2222');
  same('ssh://me@box:2222', 'me@box:2222');
  same('SSH://me@box/', 'me@box');
  assert.deepEqual(parseSshAddress('me@box:2222'), { user: 'me', host: 'box', port: 2222, destination: 'me@box:2222' });
  for (const bad of [
    '',
    '   ',
    'me@',
    '@box',
    'box:',
    'box:0',
    'box:65536',
    'box:22x',
    '-oProxyCommand=x',
    'a b',
    'a;rm',
    '[::1',
    'fe80::1:zz',
    'x'.repeat(300),
    null,
    7,
  ])
    assert.equal(parseSshAddress(bad), null, String(bad));
});

test('IPv6 literals stay machines: bare as ssh takes them, bracketed to carry a port; a local address is never read as host:port (B1)', () => {
  assert.equal(parseSshAddress('fe80::1')?.destination, 'fe80::1');
  assert.equal(parseSshAddress('me@fe80::1')?.destination, 'me@fe80::1');
  assert.equal(parseSshAddress('[::1]')?.destination, '::1');
  assert.equal(parseSshAddress('me@[fe80::1]:2222')?.destination, 'me@[fe80::1]:2222');
  assert.deepEqual(sshTarget('me@[fe80::1]:2222'), { target: 'me@fe80::1', args: ['-p', '2222'] });
  assert.equal(knownHostsName('me@[fe80::1]:2222'), '[fe80::1]:2222');
  assert.equal(normalAddress('local:2222'), 'local:2222');
  assert.equal(validDestination('fe80::1'), true);
});

test('ssh is run on user@host with -p for a port other than 22; an address that is no ssh address passes through (B2)', () => {
  assert.deepEqual(sshTarget('me@box:2222'), { target: 'me@box', args: ['-p', '2222'] });
  assert.deepEqual(sshTarget('me@box'), { target: 'me@box', args: [] });
  assert.deepEqual(sshTarget('local:me'), { target: 'local:me', args: [] });
  // known_hosts keeps a machine on another port as [host]:port; the copied ssh-keygen -R must name it that way
  assert.equal(knownHostsName('me@box:2222'), '[box]:2222');
  assert.equal(knownHostsName('me@box'), 'box');
  assert.equal(knownHostsName('weird name'), 'weird name');
});

test('normalAddress keeps what is no ssh address as it was (B1)', () => {
  assert.deepEqual([normalAddress('ssh://me@box:22'), normalAddress('local:me'), normalAddress(undefined)], ['me@box', 'local:me', '']);
});

test('a destination is valid only in its normal form, and a local address stays valid (B1)', () => {
  assert.equal(validDestination('me@box:2222'), true);
  assert.equal(validDestination('me@box:22'), false);
  assert.equal(validDestination('ssh://me@box'), false);
  assert.equal(validDestination('local:me'), true);
  assert.equal(validDestination('local:-x'), false);
  assert.equal(validDestination('local:'), false);
});

class Child extends EventEmitter {
  stdin = { on() {}, end() {} };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() {}
}
test('the add channel connects to the host with -p, not to "host:port" as a name (B2)', async (t) => {
  const calls: string[][] = [];
  useFakeProc(t, {
    spawn: (_bin: string, args: string[]) => {
      calls.push(args);
      const c = new Child();
      setImmediate(() => c.emit('close', 0));
      return c;
    },
  });
  await createSshChannel({ env: () => ({}) })('me@box:2222', 'true');
  const args = calls[0];
  assert.deepEqual(args.slice(-5), ['-p', '2222', '--', 'me@box', 'true']);
  // the user's own -p from an option list and a per-machine option come after, so a stored key still applies
  assert.equal(args.indexOf('-p') > args.indexOf('ConnectTimeout=15'), true);
});

test('the tunnel connects to the host with -p for a machine on another port (B2)', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel({ destination: 'me@build-box:2222' });
  tun.acquire();
  assert.deepEqual(w.children[0].args.slice(-4), ['-p', '2222', '--', 'me@build-box']);
});

test('the reachable probe asks ssh about the host and port, and dials the port ssh names, or the typed one', async () => {
  const asked: string[][] = [];
  const run = async (_b: string, args: string[]) => {
    asked.push(args);
    return '';
  };
  const dialed: [number, string][] = [];
  const connect = (port: number, host: string) => {
    dialed.push([port, host]);
    const s: any = new EventEmitter();
    s.destroy = () => {};
    s.setTimeout = () => {};
    setImmediate(() => s.emit('connect'));
    return s;
  };
  assert.equal(await reachable({ destination: 'me@box:2222', run, connect }), true);
  assert.deepEqual(asked[0], ['-G', '-p', '2222', '--', 'me@box']);
  // ssh -G echoes -p back as "port 2222"
  const run2 = async () => 'hostname box.example\nport 2222\n';
  await reachable({ destination: 'ssh://me@box:2222', run: run2, connect });
  assert.deepEqual(dialed.at(-1), [2222, 'box.example']);
});

test('a changed host key says what it shows now, and the command to copy names the host as known_hosts does (A1)', async () => {
  const stderr =
    'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nThe fingerprint for the ED25519 key sent by the remote host is\nSHA256:abcDEF123+/=.\nHost key verification failed.';
  const installer = createInstaller({ channel: async () => ({ code: 255, stdout: '', stderr }) });
  const out = await installer.install('me@box:2222');
  assert.equal(out.ok, false);
  assert.match(out.error, /Fingerprint now: SHA256:abcDEF123\+\/=/);
  const f = explainFailure({ step: 'connect', output: out.error, target: 'box', destination: 'me@box:2222' });
  assert.equal(f.cause, 'hostKeyChanged');
  assert.equal(f.fingerprint, 'SHA256:abcDEF123+/=');
  assert.match(f.reason, /It now shows SHA256:abcDEF123/);
  assert.deepEqual(f.action, { kind: 'copy', label: 'Copy command', text: "ssh-keygen -R '[box]:2222'" });
  // an older ssh names no fingerprint: the same card without one
  const plain = explainFailure({
    step: 'connect',
    output: "This machine's host key changed since you last connected.",
    target: 'box',
    destination: 'box',
  });
  assert.deepEqual(
    [plain.cause, plain.fingerprint, (plain.action as { text?: string }).text],
    ['hostKeyChanged', undefined, 'ssh-keygen -R box'],
  );
  const noFingerprint = createInstaller({
    channel: async () => ({ code: 255, stdout: '', stderr: 'REMOTE HOST IDENTIFICATION HAS CHANGED' }),
  });
  assert.doesNotMatch((await noFingerprint.install('box')).error, /Fingerprint now/);
});

test('each way a connection fails is its own cause with its own words, and the 2-minute cap is not "can\'t reach" (A2)', () => {
  const why = (output: string, extra: object = {}) =>
    explainFailure({ step: 'connect', output, target: 'box', destination: 'box', ...extra });
  const rows: [string, string, string][] = [
    ['ssh: Could not resolve hostname box: Name or service not known', 'name', 'Can’t find box'],
    ['ssh: connect to host box port 22: No route to host', 'route', 'No route to box'],
    ['ssh: connect to host box port 22: Network is unreachable', 'route', 'No route to box'],
    ['ssh: connect to host box port 22: Operation timed out', 'timeout', 'box didn’t answer'],
    ['Timed out.', 'timeout', 'box didn’t answer'],
    ['ssh: connect to host box port 22: Connection refused', 'remoteLoginOff', 'Turn on Remote Login on box'],
    ['Permission denied (publickey).', 'keyOnly', 'box only takes keys'],
    ['Permission denied (publickey,password).', 'wrongPassword', 'box didn’t accept the sign-in'],
    ['MoPilot: no answer was given to ssh.', 'declined', 'You didn’t connect to box'],
    ['kex_exchange_identification: read: Connection reset by peer', 'other', 'Lost the connection to box'],
  ];
  for (const [output, cause, title] of rows) {
    const f = why(output);
    assert.deepEqual([f.cause, f.title], [cause, title], output);
  }
  assert.equal(why('Permission denied (publickey).', { publicKey: 'ssh-ed25519 AAAA x' }).cause, 'keyOnly');
  // a step that is not the connection falls back to "other"
  assert.equal(explainFailure({ step: 'upload', output: 'Timed out.', target: 'box', destination: 'box' }).cause, 'other');
});
