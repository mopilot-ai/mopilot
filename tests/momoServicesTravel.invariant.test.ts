// Everything a MoMo service keeps travels with a move: after a real move between two Hosts made as the serve entry makes them (momoHomeFor, every service in host/src/momoServices loaded and started), every file under MoMo's folder on the target opens, except the ones the Host keeps for itself (HOST_OWN, and why).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { HOST_OWN } from '../host/src/momoHome.mjs';
// @ts-ignore
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';
// @ts-ignore
import { moveHome } from '../shared/momoMove.mjs';

/** Why each file in HOST_OWN stays with the Host and is sealed with its own key: a new entry needs a reason here, and a file that is not here is expected to travel. */
const WHY: Record<string, string> = {
  'grant.json': "this Host's entitlement to run MoMo at all; the target has its own",
  'home.json': "this Host's lease record: the target writes its own at the next epoch",
  'chats.json': "which of this Host's chats are MoMo's; the target makes its own chats",
  'stamps.json': 'the newest lease this Host has seen of any home: a fence kept per machine',
  'google-revoke-owed.json':
    'Google grants this Host disconnected while Google could not be reached: this Host tries the revoke again, wherever the home has gone, and a Reset must not forget them',
};
const B = { homeId: 'home-bbbb-2222', name: 'Mac mini' };
const A = { homeId: 'home-aaaa-1111', name: 'Studio' };

/** Every file under `dir`, relative, depth first, in a fixed order. */
const files = (dir: string, rel = ''): string[] =>
  fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]))
    .sort();

/** The files in `dir` that `data` cannot open (the audit log's own files are opened by its own verifier): a sealed envelope that does not decrypt, or a file that is no envelope. Named, so a new service's file is found by name. */
export function unopenable(dir: string, data: { decryptString: (b: Buffer) => string }, own: string[] = HOST_OWN): string[] {
  const bad: string[] = [];
  for (const rel of files(dir)) {
    if (own.includes(rel) || rel.startsWith('audit/') || /\.(lock|tmp)$/.test(rel)) continue;
    try {
      const env = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
      if (env?.enc !== 'safe') throw new Error('not sealed');
      data.decryptString(Buffer.from(env.data, 'base64'));
    } catch {
      bad.push(rel);
    }
  }
  return bad;
}

const sessions: any = { chats: { records: new Map(), patchMeta: () => undefined }, isolated: () => true, isolate: () => undefined };
const machine = (root: string, name: string, hostId: string, report: (m: string) => void = () => undefined): any =>
  momoHomeFor({
    paths: { dataDir: path.join(root, name, 'data'), configDir: path.join(root, name, 'config') },
    report,
    sessions,
    epochs: { current: () => 1 } as any,
    hidden: createMomoHidden(),
    hostId,
  });
const side = (home: any) => ({
  call: (op: string, p: object = {}) => home.move[op]({ op, ...p, ...(op === 'reclaim' ? { by: 'test-device' } : {}) }),
});

test('every file a service keeps travels: after a real move each file under MoMo’s folder on the target opens with the target’s data key', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-travel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = machine(root, 'a', A.homeId);
  const b = machine(root, 'b', B.homeId);
  t.after(() => Promise.all([a.close(), b.close()]));
  await a.grant({ account: 'a1', features: ['momo'] });
  await b.grant({ account: 'a1', features: ['momo'] });
  await a.start(A);
  // a record written through the handle a service is given, and one through the stores the home keeps itself
  await a.data.sealed('zz-service-record.json', (v: any) => v ?? {}).change((v: any) => void (v.kept = 'yes'));
  await a.stores().turns.accept({ turnId: 'key-00000001', chatId: 'claude:c1', deviceId: 'phone', leaseEpoch: 1 });
  // every loaded service writes through its normal path first (a file made lazily would otherwise never be checked), and none writes outside MoMo's folder
  const outside = () => files(path.join(root, 'a')).filter((f) => !f.startsWith(path.join('data', 'momo') + path.sep));
  const outsideBefore = outside();
  const unseeded = a
    .serviceList()
    .filter((x: any) => !x.seeds)
    .map((x: any) => x.id);
  assert.deepEqual(unseeded, [], 'these services have no seed hook, so what they keep is not checked after a move');
  await a.seed();
  assert.deepEqual(outside(), outsideBefore, 'a service wrote a file outside MoMo’s folder, where a move does not carry it');
  const before = files(path.join(root, 'a', 'data', 'momo')).filter((f) => !HOST_OWN.includes(f));
  assert.ok(before.includes('zz-service-record.json') && before.length > 1, `the home wrote ${JSON.stringify(before)}`);
  await moveHome({ moveId: 'move-0001', from: side(a), to: side(b), target: B, fromName: A.name });
  const target = path.join(root, 'b', 'data', 'momo');
  assert.deepEqual(unopenable(target, b.data.safeStorage), [], 'these files on the target cannot be opened with its data key');
  assert.equal((await b.stores().audit.verify()).ok, true, 'the audit chain (its own format) opens and verifies on the target');
  for (const f of before) assert.ok(fs.existsSync(path.join(target, f)), `${f} did not travel`);
});

test('a file sealed with the Host’s own key is found by name, and HOST_OWN lists only what stays, each with its reason', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-travel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = machine(root, 'a', A.homeId);
  t.after(() => a.close());
  await a.grant({ account: 'a1', features: ['momo'] });
  await a.start(A);
  const wrong = a.hostOnlyStorage;
  const { SealedJson } = (await import('node:module')).createRequire(import.meta.url)('../electron/gateway/sealedFile.cjs');
  await new SealedJson({
    file: path.join(wrong.dir, 'zz-wrong-key.json'),
    safeStorage: wrong.safeStorage,
    shape: (v: any) => v ?? {},
  }).change((v: any) => void (v.x = 1));
  const dir = path.join(root, 'a', 'data', 'momo');
  assert.deepEqual(unopenable(dir, a.data.safeStorage), ['zz-wrong-key.json']);
  assert.throws(
    () => a.storage.safeStorage,
    /home\.data\.sealed/,
    'a service reaching home.storage.safeStorage fails at once, naming the way',
  );
  assert.deepEqual([...HOST_OWN].sort(), Object.keys(WHY).sort(), 'every file the Host keeps for itself has a reason above, and no other');
});

test('a service is given the home without the Host’s own key, home.storage fails at the first use of its key, and seeding reaches every service that can', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-travel-'));
  const mine = path.join(import.meta.dirname, '..', 'host', 'src', 'momoServices', `zz-view-${process.pid}.mjs`);
  (globalThis as any).__momoView = {};
  fs.writeFileSync(
    mine,
    "export default ({ home }) => { const g = globalThis.__momoView; g.hostOnly = home.hostOnlyStorage; g.dir = home.storage.dir; g.work = home.workDir('../tasks'); try { void home.storage.safeStorage; } catch (e) { g.error = e.message; } home.use('zz-view', { seed: () => (g.seeded = (g.seeded ?? 0) + 1) }); };\n",
  );
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mine, { force: true });
    delete (globalThis as any).__momoView;
  });
  const reports: string[] = [];
  const a = machine(root, 'a', A.homeId, (m: string) => reports.push(m));
  t.after(() => a.close());
  const seen = (globalThis as any).__momoView;
  assert.equal(seen.hostOnly, undefined);
  assert.match(seen.dir, /momo$/);
  assert.equal(
    seen.work,
    path.join(root, 'a', 'data', 'momo-work', 'tasks'),
    'a work folder is beside MoMo’s data, never inside it, whatever name a service passes',
  );
  assert.equal(fs.existsSync(seen.work), false, 'asking for the path makes nothing');
  assert.match(seen.error, /home\.data\.sealed/);
  assert.ok(a.hostOnlyStorage, 'the home itself still has it');
  // the services the Host ships are loaded too; this test's own are the ones named zz-
  const ours = () => a.serviceList().filter((x: any) => x.id.startsWith('zz-'));
  assert.deepEqual(ours(), [{ id: 'zz-view', seeds: true }]);
  // seeding runs every service that can, and one that throws is reported while the others still seed
  a.use('zz-quiet', {});
  a.use('zz-broken', {
    seed: () => {
      throw new Error('no disk');
    },
  });
  assert.deepEqual(
    ours().map((x: any) => [x.id, x.seeds]),
    [
      ['zz-view', true],
      ['zz-quiet', false],
      ['zz-broken', true],
    ],
  );
  await a.seed();
  assert.equal(seen.seeded, 1);
  assert.deepEqual(
    reports.filter((r) => r.includes('zz-')),
    ['MoMo service zz-broken failed on seed: no disk'],
  );
});

test('the Host’s service files never reach for the Host’s own key or for folders outside MoMo’s', () => {
  const dir = path.join(import.meta.dirname, '..', 'host', 'src', 'momoServices');
  for (const name of fs.readdirSync(dir).filter((n) => /\.(mjs|cjs|js)$/.test(n))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(
      text,
      /hostOnlyStorage|paths\.(dataDir|configDir)|\bdataDir\b|\bconfigDir\b/,
      `${name} reaches outside MoMo's data handle`,
    );
  }
});
