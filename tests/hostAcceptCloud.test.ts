// The cloud acceptance run (scripts/host-accept/cloud): the secrets reader that lets nothing of the key out, the read-only looks at the test compartment, the dry checks and the plan, and the command line, against a stand-in OCI that answers as its API reference shows (W: a check that fails, A: a compartment that is not empty, B: bad arguments, I: answers that are not what OCI documents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseArgs, runSteps } from '../scripts/host-accept.mjs';
import { LIMITS } from '../scripts/host-accept/cloud/limits.mjs';
import { drySteps, idleStopWired, planText } from '../scripts/host-accept/cloud/dry.mjs';
import { cloudRun } from '../scripts/host-accept/cloud/index.mjs';
import { createReaders } from '../scripts/host-accept/cloud/readers.mjs';
import { readOciSecrets } from '../scripts/host-accept/cloud/secrets.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-cloud-')));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CONFIG = {
  tenancy: 'ocid1.tenancy.t',
  user: 'ocid1.user.u',
  fingerprint: 'aa:bb',
  region: 'us-phoenix-1',
  compartmentId: 'ocid1.compartment.c',
  subnetId: 'ocid1.subnet.s',
};

/** A secrets directory: config.json and a key at mode 0600, with the marker line the OCI console appends. */
function secretsDir(name: string, edit: (c: any) => any = (c) => c, key = `${PEM}OCI_API_KEY\n`, mode = 0o600) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(edit({ ...CONFIG })));
  fs.writeFileSync(path.join(dir, 'key.pem'), key, { mode });
  fs.chmodSync(path.join(dir, 'key.pem'), mode);
  return dir;
}

test('I: the secrets reader gives a signer and the identifiers, and never the key, whatever is wrong', () => {
  const ok = readOciSecrets(secretsDir('ok'));
  assert.deepEqual(ok.config, CONFIG);
  assert.deepEqual(Object.keys(ok).sort(), ['config', 'sign'], 'nothing else leaves');
  const signature = ok.sign('text to sign');
  assert.ok(
    crypto.createVerify('RSA-SHA256').update('text to sign').verify(publicKey, signature, 'base64'),
    'the signer signs with the key',
  );
  // the key file may be named by the config (with `~`), else it is key.pem beside the config
  const home = tmp;
  fs.mkdirSync(path.join(home, 'k'), { recursive: true });
  fs.writeFileSync(path.join(home, 'k', 'a.pem'), PEM, { mode: 0o600 });
  const named = secretsDir('named', (c) => ({ ...c, keyFile: '~/k/a.pem' }), 'not used');
  assert.deepEqual(readOciSecrets(named, { home }).config, CONFIG);
  assert.deepEqual(readOciSecrets('~/named', { home: tmp }).config, CONFIG, 'the directory may start with ~');
  assert.equal(readOciSecrets(path.join(tmp, 'named'), { home: tmp }).config.region, 'us-phoenix-1', 'a plain directory');
  // every refusal names the file, never the content
  assert.throws(() => readOciSecrets(path.join(tmp, 'nowhere')), /nowhere\/config\.json is missing or is not JSON/);
  const bad = path.join(tmp, 'badjson');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'config.json'), '{ "tenancy": "SECRET-ish"');
  assert.throws(
    () => readOciSecrets(bad),
    (e: Error) => /is missing or is not JSON/.test(e.message) && !e.message.includes('SECRET-ish'),
  );
  assert.throws(() => readOciSecrets(secretsDir('nofield', (c) => ({ ...c, subnetId: ' ' }))), /config\.json has no subnetId/);
  assert.throws(() => readOciSecrets(secretsDir('null', () => null)), /config\.json has no tenancy/);
  assert.throws(
    () => readOciSecrets(secretsDir('nokey', (c) => ({ ...c, keyFile: '/nowhere/key.pem' }))),
    /The private key \/nowhere\/key\.pem is missing/,
  );
  assert.throws(() => readOciSecrets(secretsDir('open', (c) => c, PEM, 0o644)), /can be read by others: chmod 600/);
  assert.throws(
    () => readOciSecrets(secretsDir('notpem', (c) => c, 'hunter2-the-secret\n')),
    (e: Error) => /is not a PEM private key/.test(e.message) && !e.message.includes('hunter2'),
  );
});

/** A stand-in OCI: the first route whose pattern matches the request path answers. */
function oci(routes: [RegExp, any][], seen: string[] = []) {
  return async (method: string, service: string, p: string) => {
    seen.push(`${method} ${service} ${p}`);
    const hit = routes.find(([re]) => re.test(p));
    if (!hit) throw new Error(`no stand-in answer for ${p}`);
    const value = hit[1];
    return typeof value === 'function' ? value(p) : value;
  };
}

const ADS = [{ name: 'xYz:PHX-AD-1' }, { name: 'xYz:PHX-AD-2' }, { name: 'xYz:PHX-AD-3' }];
const SECLIST = {
  ingressSecurityRules: [{ source: '0.0.0.0/0', protocol: '6', tcpOptions: { destinationPortRange: { min: 22, max: 22 } } }],
  egressSecurityRules: [{ destination: '0.0.0.0/0', protocol: 'all' }],
};
/** Answers for a healthy, empty test compartment. */
const healthy = (): [RegExp, any][] => [
  [/\/regions$/, [{ name: 'us-phoenix-1' }, { name: 'us-ashburn-1' }]],
  [/availabilityDomains/, ADS],
  [/\/instances\?/, []],
  [/\/bootVolumes/, []],
  [/\/volumes\?/, []],
  [/\/shapes/, [{ shape: 'VM.Standard.E4.Flex' }, { shape: LIMITS.shape }]],
  [/\/images/, [{ id: 'ocid1.image.i', displayName: 'Canonical-Ubuntu-24.04-aarch64' }]],
  [
    /\/subnets\//,
    { lifecycleState: 'AVAILABLE', cidrBlock: '10.0.0.0/24', prohibitPublicIpOnVnic: false, securityListIds: ['sl1'], routeTableId: 'rt1' },
  ],
  [/\/securityLists\//, SECLIST],
  [/\/routeTables\//, { routeRules: [{ destination: '0.0.0.0/0', networkEntityId: 'ocid1.internetgateway.oc1.x' }] }],
];

test('A: every reader is a GET, and look() counts what costs a place or a disk, not what is gone', async () => {
  const seen: string[] = [];
  const r = createReaders({
    call: oci(
      [
        [
          /\/instances\?/,
          [
            { id: 'm1', displayName: 'a', lifecycleState: 'RUNNING' },
            { id: 'm2', displayName: 'b', lifecycleState: 'TERMINATED' },
          ],
        ],
        [/bootVolumes\?availabilityDomain=xYz%3APHX-AD-1/, [{ id: 'v1', lifecycleState: 'AVAILABLE', sizeInGBs: 50 }]],
        [/bootVolumes/, [{ id: 'v2', lifecycleState: 'TERMINATING', sizeInGBs: 47 }]],
        [/\/volumes\?/, [{ id: 'v3', lifecycleState: 'AVAILABLE', sizeInGBs: 10 }]],
        ...healthy().filter(([re]) => /availabilityDomains/.test(re.source)),
      ],
      seen,
    ),
    config: CONFIG,
  });
  const look = await r.look();
  assert.deepEqual(look.live, [{ id: 'm1', name: 'a', state: 'RUNNING' }]);
  assert.equal(look.instances.length, 2);
  assert.deepEqual(
    look.volumes.map((v) => v.id),
    ['v1', 'v3'],
    'a terminating disk is not counted',
  );
  assert.equal(look.volumeGb, 60);
  assert.equal(look.empty, false);
  assert.ok(
    seen.every((s) => s.startsWith('GET ')),
    `only reads: ${seen.join(' | ')}`,
  );
  assert.ok(
    seen.every((s) => s.includes(encodeURIComponent(CONFIG.compartmentId)) || s.includes('/availabilityDomains')),
    'only this compartment',
  );
});

test('I: the security list, subnet and route readers read the shapes OCI documents, and a surprise as "no"', async () => {
  const lists = (rules: any[], egress: any[] = [{ destination: '0.0.0.0/0', protocol: '6' }]) =>
    createReaders({
      call: oci([[/securityLists/, { ingressSecurityRules: rules, egressSecurityRules: egress }]]),
      config: CONFIG,
    }).securityList('x');
  const ssh = async (rules: any[]) => (await lists(rules)).sshIn;
  assert.equal(await ssh([{ source: '0.0.0.0/0', protocol: 'all' }]), true, 'all protocols');
  assert.equal(await ssh([{ source: '0.0.0.0/0', protocol: '6' }]), true, 'tcp with no port options');
  assert.equal(await ssh([{ source: '0.0.0.0/0', protocol: '6', tcpOptions: {} }]), true, 'tcp options without a range');
  assert.equal(
    await ssh([{ source: '0.0.0.0/0', protocol: '6', tcpOptions: { destinationPortRange: { min: 1, max: 1024 } } }]),
    true,
    'a range around 22',
  );
  assert.equal(
    await ssh([{ source: '0.0.0.0/0', protocol: '6', tcpOptions: { destinationPortRange: { min: 80, max: 443 } } }]),
    false,
    'a range that skips 22',
  );
  assert.equal(
    await ssh([{ source: '0.0.0.0/0', protocol: '6', tcpOptions: { destinationPortRange: { min: 1, max: 21 } } }]),
    false,
    'a range below 22',
  );
  assert.equal(await ssh([{ source: '10.0.0.0/8', protocol: '6' }]), false, 'only from inside');
  assert.equal(await ssh([{ source: '0.0.0.0/0', protocol: '17' }]), false, 'udp');
  assert.equal((await lists([], [{ destination: '0.0.0.0/0', protocol: '17' }])).egressOut, false);
  assert.equal((await lists([], [{ destination: '10.0.0.0/8', protocol: 'all' }])).egressOut, false);
  const nothing = createReaders({ call: oci([[/./, null]]), config: CONFIG });
  assert.deepEqual(await nothing.securityList('x'), { sshIn: false, egressOut: false });
  assert.deepEqual(await nothing.subnet('x'), {
    state: 'undefined',
    cidr: 'undefined',
    isPublic: false,
    securityListIds: [],
    routeTableId: '',
  });
  assert.equal(await nothing.internetRoute('x'), false);
  assert.equal(await nothing.image('s'), null);
  assert.deepEqual(await nothing.regions(), []);
  const r = createReaders({
    call: oci([[/routeTables/, { routeRules: [{ destination: '0.0.0.0/0', networkEntityId: 'ocid1.natgateway.x' }] }]]),
    config: CONFIG,
  });
  assert.equal(await r.internetRoute('x'), false, 'a NAT gateway is not a way in');
});

/** The context of the dry checks. */
const ctxOf = (routes: [RegExp, any][], root = tmp) => ({
  root,
  cloud: { config: CONFIG, readers: createReaders({ call: oci(routes), config: CONFIG }), look: null as any },
});
const rowsOf = async (routes: [RegExp, any][], root = tmp) => runSteps({ steps: drySteps(), ctx: ctxOf(routes, root) });
const withRoutes = (extra: [RegExp, any][]): [RegExp, any][] => [...extra, ...healthy()];
const repoWith = (name: string, files: Record<string, string>) => {
  const root = path.join(tmp, name);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
};

test('W: the dry checks pass on a healthy compartment, and the idle stop that nothing builds is said, not hidden', async () => {
  const rows = await rowsOf(
    healthy(),
    repoWith('notwired', {
      'host/src/idleStop.mjs': 'export function createIdleStop() {}',
      'host/src/a.mjs': '// createIdleStop is mentioned',
    }),
  );
  assert.deepEqual(
    rows.map((r) => `${r.id} ${r.status}`),
    ['D1 PASS', 'D2 PASS', 'D3 PASS', 'D4 PASS', 'D5 PASS', 'D6 SKIP'],
  );
  assert.match(rows[1].detail, /3 availability domains/);
  assert.equal(rows[2].detail, 'PHX-AD-1 yes, PHX-AD-2 yes, PHX-AD-3 yes');
  assert.match(rows[5].detail, /NOT WIRED: nothing under host\/ calls createIdleStop/);
  const wired = await rowsOf(
    healthy(),
    repoWith('wired', {
      'host/src/main.mjs': 'const s = createIdleStop({});',
      'host/node_modules/x/y.mjs': 'createIdleStop(',
      'host/README.md': 'createIdleStop(',
    }),
  );
  assert.deepEqual([wired[5].status, wired[5].detail], ['PASS', 'wired']);
  assert.equal(
    idleStopWired(repoWith('hidden', { 'host/node_modules/x/y.mjs': 'createIdleStop(', 'host/README.md': 'createIdleStop(' })),
    false,
    'node_modules and non-code files do not count',
  );
});

test('A: a dry check that finds a reason not to launch fails and says why', async () => {
  const fail = async (extra: [RegExp, any][], id: string) => (await rowsOf(withRoutes(extra))).find((r) => r.id === id)!;
  assert.match((await fail([[/\/regions$/, [{ name: 'eu-x-1' }]]], 'D1')).detail, /us-phoenix-1 is not among the 1 regions/);
  const busy = await fail(
    [
      [/\/instances\?/, [{ id: 'm', displayName: 'prod-ish', lifecycleState: 'RUNNING' }]],
      [/\/volumes\?/, [{ id: 'v', lifecycleState: 'AVAILABLE', sizeInGBs: 50 }]],
    ],
    'D2',
  );
  assert.equal(busy.status, 'FAIL');
  assert.match(busy.detail, /Not empty \(prod-ish RUNNING, disk 50 GB AVAILABLE\)/);
  assert.match((await fail([[/\/shapes/, [{ shape: LIMITS.shape }]]], 'D3')).detail, /^$|yes/, 'a healthy AD list still passes');
  const noShape = await fail([[/shapes\?.*PHX-AD-2/, [{ shape: 'VM.Standard.E4.Flex' }]]], 'D3');
  assert.match(noShape.detail, /The free shape is missing somewhere: PHX-AD-1 yes, PHX-AD-2 NO, PHX-AD-3 yes/);
  assert.match((await fail([[/\/images/, []]], 'D4')).detail, /No Ubuntu image/);
  const priv = await fail([[/\/subnets\//, { lifecycleState: 'AVAILABLE', prohibitPublicIpOnVnic: true }]], 'D5');
  assert.match(priv.detail, /forbids public addresses/);
  const closed = await fail(
    [
      [/\/securityLists\//, { ingressSecurityRules: [], egressSecurityRules: [] }],
      [/\/routeTables\//, { routeRules: [] }],
    ],
    'D5',
  );
  assert.match(closed.detail, /route to an internet gateway NO; SSH in from anywhere NO; egress NO/);
  const noTable = await fail(
    [[/\/subnets\//, { lifecycleState: 'AVAILABLE', cidrBlock: '10.0.0.0/24', prohibitPublicIpOnVnic: false, securityListIds: [] }]],
    'D5',
  );
  assert.match(noTable.detail, /route to an internet gateway NO/);
  // D3 and D5 alone (without D2) still work: the domains are read again
  const only = await runSteps({ steps: drySteps().filter((s) => s.id === 'D3'), ctx: ctxOf(healthy()) });
  assert.equal(only[0].status, 'PASS');
});

test('B: the plan names one machine of the free shape, the order of the domains, and the teardown', () => {
  const text = planText({ config: CONFIG, ads: ['x:PHX-AD-1', 'x:PHX-AD-2'] });
  assert.match(
    text,
    /us-phoenix-1, one machine: VM\.Standard\.A1\.Flex:1:6, 50 GB boot volume, availability domains tried in order PHX-AD-1 → PHX-AD-2, then stop/,
  );
  for (const cell of ['| 1 |', '| 2 |', '| 3 |', '| 4 |', '| 5 |', '| 6 |']) assert.ok(text.includes(cell), cell);
  assert.match(text, /in a `finally`/);
  assert.deepEqual([LIMITS.shape, LIMITS.ocpus, LIMITS.memoryGb, LIMITS.bootGb, LIMITS.machines], ['VM.Standard.A1.Flex', 1, 6, 50, 1]);
});

test('B: --cloud takes oci, milestone M4 and a secrets directory, makes its own machine, and --dry/--secrets belong to it', () => {
  const o = parseArgs(['--milestone', 'M4', '--cloud', 'oci', '--secrets', '~/s', '--dry']);
  assert.deepEqual([o.cloud, o.secrets, o.dry, o.vm, o.ssh], ['oci', '~/s', true, '', '']);
  const base = ['--milestone', 'M4', '--cloud', 'oci', '--secrets', 'd'];
  assert.throws(() => parseArgs([...base.slice(0, 3), 'gcp', '--secrets', 'd']), /--cloud takes oci/);
  assert.throws(() => parseArgs(['--milestone', 'M1', '--cloud', 'oci', '--secrets', 'd']), /belongs to --milestone M4/);
  assert.throws(() => parseArgs(['--milestone', 'M4', '--cloud', 'oci']), /takes --secrets <dir>/);
  for (const extra of [['--vm', 'v'], ['--ssh', 'u@h'], ['--keep'], ['--only', 'S9']])
    assert.throws(() => parseArgs([...base, ...extra]), /makes its own machine/);
  assert.throws(() => parseArgs(['--vm', 'v', '--dry']), /belong to --cloud/);
  assert.throws(() => parseArgs(['--vm', 'v', '--secrets', 'd']), /belong to --cloud/);
});

test('W: the dry run through main reads, prints a table and the plan, and exits by the checks', async () => {
  const out: string[] = [];
  const seen: string[] = [];
  const io = (routes: [RegExp, any][], root = secretsDir(`main-${out.length}`)) => ({
    out: (t: string) => out.push(t),
    deps: (() => assert.fail('no machine')) as any,
    channelFor: (() => assert.fail('no machine')) as any,
    cloud: {
      readSecrets: (dir: string) => {
        seen.push(dir);
        return readOciSecrets(root);
      },
      fetch: (async (url: string, init: any) => {
        const m = /^https:\/\/(iaas|identity)\.us-phoenix-1\.oraclecloud\.com(.*)$/.exec(url)!;
        assert.equal(init.method, 'GET');
        assert.match(init.headers.authorization, /^Signature version="1",keyId="ocid1\.tenancy\.t\/ocid1\.user\.u\/aa:bb"/);
        assert.ok(!JSON.stringify(init).includes('BEGIN'), 'the key is in no request');
        const call = oci(routes);
        const body = await call('GET', m[1], m[2]);
        return new Response(JSON.stringify(body), { status: 200 });
      }) as any,
    },
  });
  const argv = ['--milestone', 'M4', '--cloud', 'oci', '--secrets', '/s', '--dry'];
  assert.equal(await main(argv, io(healthy())), 0);
  assert.deepEqual(seen, ['/s']);
  assert.match(out[0], /Host acceptance run on oci us-phoenix-1 \(dry: GET calls only\)/);
  assert.match(out[0], /Plan for the real run/);
  assert.equal(
    await main(argv, io(withRoutes([[/\/instances\?/, [{ id: 'm', displayName: 'x', lifecycleState: 'RUNNING' }]]]))),
    1,
    'a compartment that is not empty fails the run',
  );
  // a read that fails is a failed check, not a crash: the plan then has no domains to list
  assert.equal(await main(argv, io(healthy().filter(([re]) => !/instances/.test(re.source)))), 1);
  assert.match(out[2], /D2 .*FAIL .*could not reach the provider/);
  assert.match(out[2], /tried in order , then stop/);
  const file = path.join(tmp, 'report.md');
  await main([...argv, '--out', file], io(healthy()));
  assert.match(fs.readFileSync(file, 'utf8'), /Plan for the real run/, '--out writes the report of a cloud run too');
});

test('W: without stand-ins the run reads the secrets directory itself and uses the global fetch', async (t) => {
  const dir = secretsDir('real');
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(url.includes('/regions') ? [{ name: 'us-phoenix-1' }] : []), { status: 200 });
  });
  const out: string[] = [];
  const code = await cloudRun(
    { cloud: 'oci', secrets: dir, dry: true, milestone: 'M4' },
    { out: (x) => out.push(x), root: tmp, deps: () => ({}) },
    runSteps as any,
  );
  assert.equal(code, 1, 'an empty answer to every read fails D3 and D4');
  assert.ok(calls.every((u) => u.startsWith('https://')));
  assert.match(out[0], /D1 .*PASS/);
});
