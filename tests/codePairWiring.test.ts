// Pairing by code as the Host's process builds it (host/src/codePairWiring.mjs, R2b of #5576): off unless the flag is set; this Host's device key is made once, kept owner-only, and read back; the service it builds works with what the process gives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { codePairFor, connectionsOpen, deviceKeyOf, deviceOf, enrollOnly } from '../host/src/codePairWiring.mjs';
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
const parts = (dir: string, env: Record<string, string | undefined>): any => ({
  env,
  paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
  relayLinks: { enroll: () => ({}), forget: (p: any) => void gone.push(p), close: () => void closed.push(1) },
  pairing: {
    add: () => 'fp',
    remove: () => true,
    onForgotten: (fn: any) => void forgotten.push(fn),
    hostId: () => 'host-h',
    controllerRecords: () => records.length,
    believeControllers: (fn: any) => void (believe = fn),
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

test('a controller that is revoked takes its relay link with it, and nothing else does; a failing forget is reported, not thrown', (t) => {
  forgotten.length = 0;
  gone.length = 0;
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
  assert.deepEqual(gone, [{ hostId: 'h_abcdefghijklmnop' }]);
  p.relayLinks.forget = () => {
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

test('the relay link a pairing makes is only created, and connections are accepted unless the Host is told otherwise at the time of the offer', () => {
  const asked: any[] = [];
  const enroll = enrollOnly({ enroll: (p: any, o: any) => (asked.push([p, o]), { hostPub: 'x' }) });
  assert.deepEqual(enroll({ hostId: 'h_a' }), { hostPub: 'x' });
  assert.deepEqual(asked, [[{ hostId: 'h_a' }, { createOnly: true }]]);
  const env: Record<string, string> = {};
  const open = connectionsOpen(env);
  assert.equal(open(), true);
  env.MOPILOT_HOST_ALLOW_CONNECTIONS = '0';
  assert.equal(open(), false, 'read at each offer');
  env.MOPILOT_HOST_ALLOW_CONNECTIONS = '1';
  assert.equal(open(), true);
});

test("the approval key is the Host's own: no key is no pairing, a controller record is believed only with the person's proof, and the key is enrolled through the service", async (t) => {
  const dir = dirOf(t);
  const p = parts(dir, { MOPILOT_HOST_CODE_PAIR: '1' });
  p.platform = 'darwin';
  const service: any = codePairFor(p);
  assert.deepEqual(service.status({ owner: new Set() }).approval, { available: false, reason: 'no_approval_helper' });
  assert.equal(believe({ key: 'x' }), false, 'a record with no proof is no controller');
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
