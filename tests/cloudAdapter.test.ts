// The cloud adapter contract (C1): the interface check, the fake provider, and the OCI adapter against recorded request and response shapes with an injected fetch and signer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTER_CALLS, CloudError, MACHINE_STATES, adapterProblem, createFakeProvider, isMachineState } from '../shared/cloud/adapter.mjs';
import { createOciAdapter, parseSize } from '../shared/cloud/oci.mjs';

test('adapterProblem names the first thing wrong and passes a whole adapter', () => {
  const fake = createFakeProvider();
  assert.equal(adapterProblem(fake), null);
  assert.match(adapterProblem(null)!, /object/);
  assert.match(adapterProblem({})!, /no create/);
  const noId: any = { ...fake, id: '' };
  assert.match(adapterProblem(noId)!, /no id/);
  assert.match(adapterProblem({ ...fake, flags: null })!, /no flags/);
  assert.match(adapterProblem({ ...fake, flags: { resume: true } })!, /selfStop/);
  assert.deepEqual([...MACHINE_STATES], ['starting', 'running', 'stopped', 'gone']);
  assert.ok(ADAPTER_CALLS.includes('find'));
  assert.ok(isMachineState('gone') && !isMachineState('paused'));
});

test('the fake provider keeps machines, states, failures and a call log', async () => {
  const booted: string[] = [];
  const fake = createFakeProvider({
    boot: (command, id) => booted.push(`${id}:${command}`),
    flags: { resume: false },
  });
  assert.equal(fake.flags.resume, false);
  const { id } = await fake.create({
    name: 'a',
    size: 's',
    region: 'r',
    command: 'run',
  });
  assert.deepEqual(booted, [`${id}:run`]);
  assert.equal(await fake.status(id), 'starting');
  assert.equal(await fake.find('a'), id);
  assert.equal(await fake.find('zz'), null);
  fake.set(id, 'running');
  fake.set('nope', 'running');
  await fake.stop(id);
  assert.equal(await fake.status(id), 'stopped');
  await fake.resume(id);
  assert.equal(await fake.status(id), 'starting');
  await fake.resume(id);
  assert.equal(await fake.status(id), 'starting');
  assert.equal((await fake.sizes())[0].id, 'small');
  assert.equal((await fake.regions())[0].id, 'r1');
  fake.failNext('stop', new CloudError('busy', 'later', { retryable: true }));
  await assert.rejects(fake.stop(id), (e: any) => e.code === 'busy' && e.retryable === true && e.name === 'CloudError');
  await fake.destroy(id);
  await fake.destroy(id);
  assert.equal(await fake.status(id), 'gone');
  await assert.rejects(fake.stop(id), (e: any) => e.code === 'gone');
  await assert.rejects(fake.resume(id), (e: any) => e.code === 'gone');
  assert.ok(fake.calls.some((c) => c.call === 'destroy'));
});

// ---- OCI, against the shapes in the public API reference ----
const config = {
  tenancy: 'ocid1.tenancy.oc1..t',
  user: 'ocid1.user.oc1..u',
  fingerprint: 'aa:bb',
  region: 'us-ashburn-1',
  compartmentId: 'ocid1.compartment.oc1..c',
  subnetId: 'ocid1.subnet.oc1..s',
};
type Req = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};
function oci(answers: Array<[number, unknown] | Error>, over: Record<string, unknown> = {}) {
  const reqs: Req[] = [];
  const signed: string[] = [];
  const fetchFn = async (url: string, init: any) => {
    reqs.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    const next = answers.shift() ?? [200, null];
    if (next instanceof Error) throw next;
    const [status, body] = next;
    return {
      ok: status < 300,
      status,
      text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  const adapter = createOciAdapter({
    config: { ...config, ...over },
    fetch: fetchFn as any,
    sign: (s) => (signed.push(s), 'SIG=='),
    now: () => new Date('2026-11-14T10:00:00Z'),
  });
  return { adapter, reqs, signed };
}

test('OCI create signs a POST with its body hash and sends the join command as cloud-init user data', async () => {
  const { adapter, reqs, signed } = oci([
    [200, [{ name: 'AD-1' }]],
    [200, [{ id: 'ocid1.image.oc1..i' }]],
    [200, { id: 'ocid1.instance.oc1..m' }],
  ]);
  const made = await adapter.create({
    name: 'dev-cloud',
    size: 'VM.Standard.A1.Flex:2:12',
    region: 'us-ashburn-1',
    command: 'curl x | sh',
  });
  assert.deepEqual(made, { id: 'ocid1.instance.oc1..m' });
  assert.equal(
    reqs[0].url,
    'https://identity.us-ashburn-1.oraclecloud.com/20160918/availabilityDomains?compartmentId=ocid1.compartment.oc1..c',
  );
  assert.match(
    reqs[1].url,
    /^https:\/\/iaas\.us-ashburn-1\.oraclecloud\.com\/20160918\/images\?compartmentId=.*&shape=VM\.Standard\.A1\.Flex&sortBy=TIMECREATED/,
  );
  const post = reqs[2];
  assert.equal(post.method, 'POST');
  assert.equal(post.url, 'https://iaas.us-ashburn-1.oraclecloud.com/20160918/instances');
  const body = JSON.parse(post.body!);
  assert.equal(body.availabilityDomain, 'AD-1');
  assert.deepEqual(body.shapeConfig, { ocpus: 2, memoryInGBs: 12 });
  assert.equal(body.sourceDetails.imageId, 'ocid1.image.oc1..i');
  assert.equal(body.createVnicDetails.subnetId, config.subnetId);
  assert.equal(Buffer.from(body.metadata.user_data, 'base64').toString(), '#!/bin/sh\ncurl x | sh\n');
  assert.match(
    post.headers.authorization,
    /^Signature version="1",keyId="ocid1.tenancy.oc1..t\/ocid1.user.oc1..u\/aa:bb",algorithm="rsa-sha256",headers="date \(request-target\) host content-length content-type x-content-sha256",signature="SIG=="$/,
  );
  assert.equal(post.headers['content-length'], String(Buffer.byteLength(post.body!)));
  assert.equal(post.headers['x-content-sha256'].length, 44);
  assert.match(
    signed[2],
    /^date: Sat, 14 Nov 2026 10:00:00 GMT\n\(request-target\): post \/20160918\/instances\nhost: iaas\.us-ashburn-1\.oraclecloud\.com\ncontent-length: \d+\ncontent-type: application\/json\nx-content-sha256: .{44}$/,
  );
  assert.match(signed[0], /^date: .*\n\(request-target\): get \/20160918\/availabilityDomains\?compartmentId=.*\nhost: identity\./);
});

test('OCI create takes a given domain and image, rejects a bad size and an answer without an id', async () => {
  const { adapter, reqs } = oci([[200, {}]], {
    availabilityDomain: 'AD-9',
    imageId: 'img',
  });
  await assert.rejects(
    adapter.create({
      name: 'n',
      size: 'VM.Standard.A1.Flex:1:6',
      region: 'r',
      command: 'c',
    }),
    /did not name/,
  );
  assert.equal(reqs.length, 1);
  assert.equal(JSON.parse(reqs[0].body!).availabilityDomain, 'AD-9');
  assert.throws(
    () => parseSize('weird'),
    (e: any) => e.code === 'invalid',
  );
  assert.throws(() => parseSize('VM.Standard.A1.Flex:0:6'), /not offered/);
  await assert.rejects(adapter.create({ name: 'n', size: 'bad', region: 'r', command: 'c' }), /not offered/);
  const nonArray = oci([[200, null]]);
  await assert.rejects(nonArray.adapter.create({ name: 'n', size: 'VM.Standard.A1.Flex:1:6', region: 'r', command: 'c' }), /no place/);
  const noImageList = oci([
    [200, [{ name: 'AD' }]],
    [200, null],
  ]);
  await assert.rejects(noImageList.adapter.create({ name: 'n', size: 'VM.Standard.A1.Flex:1:6', region: 'r', command: 'c' }), /no image/);
  const none = oci([[200, []]]);
  await assert.rejects(
    none.adapter.create({
      name: 'n',
      size: 'VM.Standard.A1.Flex:1:6',
      region: 'r',
      command: 'c',
    }),
    /no place/,
  );
  const noImage = oci([
    [200, [{ name: 'AD' }]],
    [200, []],
  ]);
  await assert.rejects(
    noImage.adapter.create({
      name: 'n',
      size: 'VM.Standard.E4.Flex:1:8',
      region: 'r',
      command: 'c',
    }),
    /no image/,
  );
});

test('OCI status folds lifecycle states into the four, and a 404 is gone', async () => {
  const states: Array<[string, string]> = [
    ['PROVISIONING', 'starting'],
    ['RUNNING', 'running'],
    ['STOPPING', 'stopped'],
    ['STOPPED', 'stopped'],
    ['TERMINATED', 'gone'],
    ['TERMINATING', 'gone'],
    ['WEIRD', 'starting'],
  ];
  for (const [lifecycleState, want] of states) assert.equal(await oci([[200, { lifecycleState }]]).adapter.status('i'), want);
  const { adapter, reqs, signed } = oci([[404, { code: 'NotAuthorizedOrNotFound', message: 'x' }]]);
  assert.equal(await adapter.status('ocid1.instance.oc1..m'), 'gone');
  assert.equal(reqs[0].headers['content-length'], undefined);
  assert.doesNotMatch(signed[0], /content-length/);
  await assert.rejects(oci([[500, { message: 'down' }]]).adapter.status('i'), (e: any) => e.code === 'failed' && e.retryable);
});

test('OCI stop, resume and destroy use the instance action and delete shapes, and tolerate the state they lead to', async () => {
  const stop = oci([[200, {}]]);
  await stop.adapter.stop('i1');
  assert.equal(stop.reqs[0].url, 'https://iaas.us-ashburn-1.oraclecloud.com/20160918/instances/i1?action=SOFTSTOP');
  assert.equal(stop.reqs[0].body, '{}');
  const resume = oci([[200, {}]]);
  await resume.adapter.resume('i1');
  assert.match(resume.reqs[0].url, /action=START$/);
  // already stopped: the provider says "incorrect state" and a read confirms it
  await oci([
    [409, { code: 'IncorrectState', message: 'busy' }],
    [200, { lifecycleState: 'STOPPED' }],
  ]).adapter.stop('i1');
  await oci([
    [409, { code: 'IncorrectState' }],
    [200, { lifecycleState: 'RUNNING' }],
  ]).adapter.resume('i1');
  await assert.rejects(
    oci([
      [409, { code: 'IncorrectState', message: 'busy' }],
      [200, { lifecycleState: 'RUNNING' }],
    ]).adapter.stop('i1'),
    (e: any) => e.code === 'busy' && e.retryable,
  );
  const del = oci([[204, undefined]]);
  await del.adapter.destroy('i1');
  assert.equal(del.reqs[0].method, 'DELETE');
  assert.match(del.reqs[0].url, /instances\/i1\?preserveBootVolume=false$/);
  await oci([[404, {}]]).adapter.destroy('i1');
  await assert.rejects(oci([[500, {}]]).adapter.destroy('i1'), (e: any) => e.code === 'failed');
});

test('OCI sizes carry a price, regions and find read lists, and errors become the words a person can read', async () => {
  const { adapter } = oci([]);
  const sizes = await adapter.sizes();
  assert.equal(sizes.length, 4);
  assert.equal(sizes[0].id, 'VM.Standard.A1.Flex:1:6');
  assert.equal(sizes[0].pricePerHour, 0.019);
  assert.equal(adapter.flags.publicPrice, true);
  assert.deepEqual(await oci([[200, [{ name: 'us-ashburn-1' }]]]).adapter.regions(), [{ id: 'us-ashburn-1', label: 'us-ashburn-1' }]);
  assert.deepEqual(await oci([[200, null]]).adapter.regions(), []);
  const found = oci([
    [
      200,
      [
        { id: 'dead', lifecycleState: 'TERMINATED' },
        { id: 'live', lifecycleState: 'RUNNING' },
      ],
    ],
  ]);
  assert.equal(await found.adapter.find('n'), 'live');
  assert.match(found.reqs[0].url, /displayName=n&limit=5$/);
  assert.equal(await oci([[200, []]]).adapter.find('n'), null);
  assert.equal(await oci([[200, [{ lifecycleState: 'RUNNING' }]]]).adapter.find('n'), null);
  assert.equal(await oci([[200, null]]).adapter.find('n'), null);
  const codes: Array<[number, any, string]> = [
    [401, { code: 'NotAuthenticated' }, 'refused'],
    [403, {}, 'refused'],
    [500, { code: 'OutOfHostCapacity', message: 'Out of host capacity for shape' }, 'capacity'],
    [500, { message: 'we are out of capacity' }, 'capacity'],
    [500, { code: 'OutOfHostCapacity' }, 'capacity'],
    [400, { code: 'LimitExceeded', message: 'limit' }, 'limit'],
    [400, { code: 'QuotaExceeded' }, 'limit'],
    [429, {}, 'failed'],
    [400, { message: 'bad' }, 'failed'],
    [400, 'not json', 'failed'],
  ];
  for (const [status, body, code] of codes) {
    await assert.rejects(oci([[status, body]]).adapter.regions(), (e: any) => e.code === code && !/SIG|ocid1/.test(e.message));
  }
  await assert.rejects(
    oci([new Error('ECONNRESET')]).adapter.regions(),
    (e: any) => e.code === 'failed' && e.retryable && /could not reach/.test(e.message),
  );
  assert.deepEqual(await oci([[200, '']]).adapter.regions(), []);
});

test('defaults: a fake provider without a boot hook, and an OCI adapter that reads the real clock', async () => {
  const fake = createFakeProvider();
  assert.equal((await fake.create({ name: 'x', size: 's', region: 'r', command: 'c' })).id, 'fake-1');
  let date = '';
  const adapter = createOciAdapter({
    config,
    fetch: (async (_u: string, init: any) => ((date = init.headers.date), { ok: true, status: 200, text: async () => '[]' })) as any,
    sign: () => 'S',
  });
  await adapter.regions();
  assert.match(date, /GMT$/);
});
