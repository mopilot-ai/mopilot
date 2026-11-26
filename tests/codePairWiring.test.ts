// Pairing by code as the Host's process builds it (host/src/codePairWiring.mjs, R2b of #5576): off unless the flag is set; this Host's device key is made once, kept owner-only, and read back; the service it builds works with what the process gives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { codePairFor, deviceKeyOf, deviceOf, enrollOnly } from '../host/src/codePairWiring.mjs';
// @ts-ignore
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';

const dirOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'code-pair-wiring-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const forgotten: any[] = [];
const records: any[] = [];
let believe: any;
const gone: any[] = [];
const closed: number[] = [];
const retired: any[] = [];
let tombstoneHeard: any;
const parts = (dir: string, env: Record<string, string | undefined>): any => ({
  env,
  paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
  relayLinks: {
    enroll: () => ({}),
    forget: (p: any) => void gone.push(p),
    retire: (p: any) => void retired.push(p),
    retireLive: (p: any) => void retired.push({ live: p.hostId }),
    onTombstone: (fn: any) => void (tombstoneHeard = fn),
    close: () => void closed.push(1),
  },
  pairing: {
    add: () => 'fp',
    remove: () => true,
    onForgotten: (fn: any) => void forgotten.push(fn),
    hostId: () => 'host-h',
    controllerRecords: () => records.length,
    believeControllers: (fn: any) => void (believe = fn),
    admitClients: () => undefined,
    admitChanged: () => undefined,
  },
  policy: { allowsClient: () => true },
  audit: { note: () => undefined },
  report: () => undefined,
});

test('the flag is off unless it is exactly 1: no service, no key made', (t) => {
  const dir = dirOf(t);
  for (const env of [{}, { MOPILOT_HOST_CODE_PAIR: '0' }, { MOPILOT_HOST_CODE_PAIR: 'true' }])
    assert.equal(codePairFor(parts(dir, env)), undefined);
  assert.equal(fs.existsSync(path.join(dir, 'config')), false);
});

test('the device key is made once, kept owner-only and read back; one that cannot be read is replaced', (t) => {
  const dir = dirOf(t);
  const prim = createNodePrimitives();
  const first = deviceKeyOf(path.join(dir, 'config'), prim);
  const file = path.join(dir, 'config', 'code-pair-key.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = deviceKeyOf(path.join(dir, 'config'), prim);
  assert.deepEqual([...again.pk], [...first.pk]);
  assert.deepEqual([...again.sk], [...first.sk]);
  for (const junk of ['not json', JSON.stringify({ pk: 'AA==', sk: 'AA==' }), '{}']) {
    fs.writeFileSync(file, junk);
    const made = deviceKeyOf(path.join(dir, 'config'), prim);
    assert.equal(made.pk.length, 32, junk);
    assert.notDeepEqual([...made.pk], [...first.pk]);
  }
});

test('with the flag on the Host has the service, and its device signs what the protocol asks of it', async (t) => {
  const dir = dirOf(t);
  const service: any = codePairFor(parts(dir, { MOPILOT_HOST_CODE_PAIR: '1' }));
  assert.equal(typeof service.offer, 'function');
  assert.equal(service.open(), 0);
  assert.deepEqual(service.status({ owner: new Set() }).offers, []);
  assert.ok(fs.existsSync(path.join(dir, 'config', 'code-pair-key.json')));
});

test("this Host as a device signs, and what it signs the other side verifies; its name is the computer's own, one label", (t) => {
  const prim = createNodePrimitives();
  const device = deviceOf(path.join(dirOf(t), 'config'), prim);
  assert.equal(device.pub.length, 32);
  assert.match(device.name, /^[^.]+$/);
  const message = new TextEncoder().encode('proof');
  assert.equal(prim.edVerify(device.pub, message, device.sign(message)), true);
  assert.equal(prim.edVerify(device.pub, new TextEncoder().encode('other'), device.sign(message)), false);
});

test('a controller that is revoked leaves its relay link a tombstone (never forgotten at once), and nothing else does; a failing retire is reported, not thrown', (t) => {
  forgotten.length = 0;
  gone.length = 0;
  retired.length = 0;
  const reports: string[] = [];
  const dir = dirOf(t);
  const p = parts(dir, { MOPILOT_HOST_CODE_PAIR: '1' });
  p.report = (m: string) => void reports.push(m);
  codePairFor(p);
  assert.equal(forgotten.length, 1);
  const [heard] = forgotten;
  heard('fp', 'controller', 'h_abcdefghijklmnop');
  heard('fp', 'controller', undefined);
  heard('fp', 'phone', 'h_abcdefghijklmnop');
  assert.deepEqual(retired, [{ hostId: 'h_abcdefghijklmnop' }]);
  assert.deepEqual(gone, [], 'the link is not forgotten: the other Mac must still hear that it was removed');
  p.relayLinks.retire = () => {
    throw new Error('link table unreadable');
  };
  heard('fp', 'controller', 'h_abcdefghijklmnop');
  assert.ok(reports.some((m) => /link table unreadable/.test(m)));
});

test('the Host stopping closes its relay links and ends every offer first', (t) => {
  closed.length = 0;
  const p = parts(dirOf(t), { MOPILOT_HOST_CODE_PAIR: '1' });
  const service: any = codePairFor(p);
  assert.equal(service.open(), 0);
  p.relayLinks.close();
  assert.deepEqual(closed, [1]);
});

test("the relay link a pairing makes is only created (connections are the app's switch: tests/codePairConnections.test.ts)", () => {
  const asked: any[] = [];
  const enroll = enrollOnly({ enroll: (p: any, o: any) => (asked.push([p, o]), { hostPub: 'x' }) });
  assert.deepEqual(enroll({ hostId: 'h_a' }), { hostPub: 'x' });
  assert.deepEqual(asked, [[{ hostId: 'h_a' }, { createOnly: true }]]);
});

test("the approval key is the Host's own: no key is no pairing, a controller record is believed only with the person's proof, and the key is enrolled through the service", async (t) => {
  const dir = dirOf(t);
  const p = parts(dir, { MOPILOT_HOST_CODE_PAIR: '1' });
  p.platform = 'darwin';
  const service: any = codePairFor(p);
  assert.deepEqual(service.status({ owner: new Set() }).approval, { available: false, reason: 'no_approval_helper' });
  assert.equal(believe({ key: 'x' }), false, 'a record with no proof is no controller');
  service.connections({ open: true });
  await assert.rejects(service.offer({ relayUrl: 'https://relay.example', token: 't' }, { owner: new Set(), emit: () => undefined }), {
    code: 'no_approval_helper',
  });
  const { privateKey, publicKey } = (await import('node:crypto')).generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as any;
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  const text = ['mopilot-code-pair-enrol-v1', 'host-h', key, 'strong'].join('|');
  const signature = (await import('node:crypto'))
    .sign('sha256', Buffer.from(text), { key: privateKey, dsaEncoding: 'der' })
    .toString('base64');
  records.push({});
  assert.throws(
    () => service.enrol({ key, weak: false, signature }),
    { code: 'controllers_exist' },
    'a key is not enrolled while a controller exists',
  );
  records.length = 0;
  assert.deepEqual(service.enrol({ key, weak: false, signature }), { enrolled: true, weak: false });
  assert.deepEqual(service.status({ owner: new Set() }).approval, { available: true, weak: false });
  records.push({});
  assert.throws(() => service.enrol({ key, weak: false, signature }), { code: 'already_enrolled' });
  records.length = 0;
});

test('reset approval as the Host builds it: every controller goes with its relay link made a tombstone, and the approval key goes', (t) => {
  const dir = dirOf(t);
  gone.length = 0;
  retired.length = 0;
  const p = parts(dir, { MOPILOT_HOST_CODE_PAIR: '1' });
  p.platform = 'darwin';
  p.pairing = createPairing({ configDir: p.paths.configDir });
  const key = (n: number) => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, n)]).toString('base64');
  // two controllers already there (their proofs are not this test's: the Host does not believe them, and they still go)
  p.pairing.add(key(1), { name: 'A', kind: 'controller', link: 'h_aaaaaaaaaaaaaaaa' });
  p.pairing.add(key(2), { name: 'B', kind: 'controller', link: 'h_bbbbbbbbbbbbbbbb' });
  const service: any = codePairFor(p);
  const keyFile = path.join(p.paths.configDir, 'approval-key.json');
  fs.writeFileSync(keyFile, '{}');
  assert.deepEqual(service.resetApproval(), { reset: true, controllers: 2 });
  // the links are retired first, before any record (and again, harmlessly, as each record is told removed); none is forgotten
  assert.deepEqual(
    retired.slice(0, 2).map((g: any) => g.hostId),
    ['h_aaaaaaaaaaaaaaaa', 'h_bbbbbbbbbbbbbbbb'],
    'their relay links become tombstones first',
  );
  assert.deepEqual(gone, []);
  assert.equal(p.pairing.controllerRecords(), 0);
  assert.ok(!fs.existsSync(keyFile));
});

test('reset approval stops with the record kept when a relay link cannot be forgotten, so resetting again finds it', (t) => {
  const dir = dirOf(t);
  const p = parts(dir, { MOPILOT_HOST_CODE_PAIR: '1' });
  p.platform = 'darwin';
  p.pairing = createPairing({ configDir: p.paths.configDir });
  p.pairing.add(Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, 7)]).toString('base64'), {
    name: 'A',
    kind: 'controller',
    link: 'h_aaaaaaaaaaaaaaaa',
  });
  let broken = true;
  p.relayLinks.retire = (q: any) => {
    if (broken) throw new Error('relay.json cannot be written');
    retired.push(q);
  };
  const service: any = codePairFor(p);
  assert.throws(() => service.resetApproval(), { code: 'reset_incomplete' });
  assert.equal(p.pairing.controllerRecords(), 1, 'the record stays with its link');
  broken = false;
  assert.deepEqual(service.resetApproval(), { reset: true, controllers: 1 });
  assert.equal(p.pairing.controllerRecords(), 0);
});

test('each tombstone made or forgotten is a line in the audit record, by a controller', (t) => {
  const notes: any[] = [];
  const p = parts(dirOf(t), { MOPILOT_HOST_CODE_PAIR: '1' });
  p.audit = { note: (e: any) => void notes.push(e) };
  codePairFor(p);
  tombstoneHeard({ kind: 'link.retired', outcome: 'kept' });
  tombstoneHeard({ kind: 'link.forgotten', outcome: 'pair_removed' });
  assert.deepEqual(notes, [
    { kind: 'link.retired', by: { kind: 'controller' }, what: { outcome: 'kept' } },
    { kind: 'link.forgotten', by: { kind: 'controller' }, what: { outcome: 'pair_removed' } },
  ]);
});

test('a removal whose tombstone cannot be written still refuses the link in this process; a link another record names is left; a Mac that pairs again has its old link retired', (t) => {
  forgotten.length = 0;
  retired.length = 0;
  const reports: string[] = [];
  const relinked: any[] = [];
  const p = parts(dirOf(t), { MOPILOT_HOST_CODE_PAIR: '1' });
  p.report = (m: string) => void reports.push(m);
  p.pairing.controllerLinks = () => ['h_shared0000000001'];
  p.pairing.onRelinked = (fn: any) => void relinked.push(fn);
  p.relayLinks.retire = (q: any) => {
    if (q.hostId === 'h_broken0000000001') throw new Error('relay.json cannot be read');
    retired.push(q);
  };
  codePairFor(p);
  const [heard] = forgotten;
  heard('fp', 'controller', 'h_broken0000000001');
  heard('fp', 'controller', 'h_shared0000000001');
  relinked[0]('fp', 'h_old000000000001');
  assert.deepEqual(retired, [{ live: 'h_broken0000000001' }, { hostId: 'h_old000000000001' }]);
  assert.ok(reports.some((m) => /could not retire a relay link: .*cannot be read/.test(m)));
  // a pairing table without the newer hooks is still served
  const plain = parts(dirOf(t), { MOPILOT_HOST_CODE_PAIR: '1' });
  delete plain.pairing.onRelinked;
  codePairFor(plain);
  forgotten.at(-1)('fp', 'controller', 'h_lone00000000001');
  assert.deepEqual(retired.at(-1), { hostId: 'h_lone00000000001' });
});
