// Where a Mac paired by a code is kept (host/src/pairing.mjs, trustState.mjs, R2b of #5576): in a file of its own that a Host from before controllers never reads, so a rollback leaves no controller (never a phone), and every client-table operation sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore
import { readControllers, readPairing } from '../host/src/trustState.mjs';
import { servedHost, tmpDir } from './support/hostClientsWorld.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { loadIdentity } = require('../electron/host/pairingClient.cjs');

/** How the Host before controllers read `pairing.json`: a kind it does not know is a phone (host/src/trustState.mjs as of the previous release). */
const oldParse = (file: string) =>
  Object.fromEntries(
    Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).clients as Record<string, any>).map(([fp, c]) => [
      fp,
      ['desktop', 'phone', 'cli'].includes(c.kind) ? c.kind : 'phone',
    ]),
  );

const world = (t: any) => {
  const dir = tmpDir(t);
  const configDir = path.join(dir, 'config');
  const removed: any[] = [];
  const pairing = createPairing({ configDir, audit: (e: any) => removed.push(e) });
  const key = (n: string) => loadIdentity(path.join(dir, `${n}.json`), keySafe).publicKey as string;
  return { dir, configDir, pairing, removed, key };
};

test('a controller is in its own file: a Host from before controllers has none, and never reads one as a phone', (t) => {
  const w = world(t);
  const desktop = w.pairing.add(w.key('d'), { name: 'Desk', kind: 'desktop' });
  const ctl = w.pairing.add(w.key('c'), { name: 'Other Mac', kind: 'controller' });
  const raw = path.join(w.configDir, 'pairing.json');
  assert.deepEqual(Object.keys(oldParse(raw)), [desktop], 'the old reader finds the desktop only');
  assert.equal(fs.statSync(path.join(w.configDir, 'controllers.json')).mode & 0o777, 0o600);
  assert.equal(readPairing(w.configDir).clients[ctl], undefined);
  assert.equal(readControllers(w.configDir)[ctl].kind, 'controller');
  // it is a client of this Host for everything else
  assert.deepEqual(w.pairing.principal(ctl), { fingerprint: ctl, name: 'Other Mac', kind: 'controller' });
  assert.equal(w.pairing.knows(ctl), true);
  assert.equal(w.pairing.stillKnows(ctl), true);
  assert.deepEqual(
    w.pairing.list().map((c: any) => [c.fingerprint, c.kind]),
    [
      [desktop, 'desktop'],
      [ctl, 'controller'],
    ],
  );
  assert.equal(w.pairing.fingerprints().includes(ctl), true);
  // it is not an update key and does not count as the Host being paired
  assert.deepEqual(w.pairing.desktopKeys().length, 1);
  assert.equal(w.pairing.paired(), 1);
  assert.equal(w.pairing.publicKeys().length, 1);
  // adding it again is the same record
  assert.equal(w.pairing.add(w.key('c'), { name: 'again', kind: 'controller' }), ctl);
  assert.equal(w.pairing.list().length, 2);
});

test('a controller can be renamed and removed, and its removal is audited; a key that is no client is left alone', (t) => {
  const w = world(t);
  const ctl = w.pairing.add(w.key('c'), { name: 'Old', kind: 'controller' });
  assert.equal(w.pairing.rename(ctl, 'New \n name'), true);
  assert.equal(w.pairing.principal(ctl)?.name, 'New   name', 'cleaned like every name');
  assert.equal(w.pairing.rename('f'.repeat(64), 'x'), false);
  assert.equal(w.pairing.remove(ctl), true);
  assert.equal(w.pairing.knows(ctl), false);
  assert.equal(w.pairing.stillKnows(ctl), false);
  assert.equal(w.pairing.remove(ctl), false);
  assert.deepEqual(
    w.removed.map((e) => [e.kind, e.by.kind]),
    [
      ['client.added', 'controller'],
      ['client.removed', 'controller'],
    ],
  );
});

test("a key that is both is the owner's client, and pairing it with the Host's code retires its controller record", (t) => {
  const w = world(t);
  const id = w.key('both');
  const ctl = w.pairing.add(id, { kind: 'controller' });
  assert.equal(w.pairing.principal(ctl)?.kind, 'controller');
  // the same key registered as a desktop wins in the table, and the controller entry gives way
  const file = path.join(w.configDir, 'pairing.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      codeHash: null,
      expires: 0,
      wrong: 0,
      clients: { [ctl]: { key: id, name: 'D', kind: 'desktop', addedAt: 1, addedBy: 'code' } },
    }),
  );
  assert.equal(w.pairing.principal(ctl)?.kind, 'desktop');
  assert.equal(w.pairing.list().filter((c: any) => c.fingerprint === ctl).length, 1);
  assert.equal(w.pairing.add(id, { kind: 'controller' }), ctl, 'a key that is a client stays as it is');
});

test('a controllers file that cannot be read is no controllers, and one bad record does not take the rest', (t) => {
  const w = world(t);
  const file = path.join(w.configDir, 'controllers.json');
  const good = w.pairing.add(w.key('c'), { name: 'Good', kind: 'controller' });
  for (const text of ['not json', '[]', '{"v":2,"controllers":{}}', '{"v":1,"controllers":[]}', '{"v":1}']) {
    fs.writeFileSync(file, text);
    assert.deepEqual(readControllers(w.configDir), {}, text);
    assert.equal(w.pairing.knows(good), false);
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ v: 1, controllers: { bad: 7, [good]: { key: w.key('c'), name: 'Good', kind: 'desktop', addedAt: 1, addedBy: 'x' } } }),
  );
  assert.deepEqual(Object.keys(readControllers(w.configDir)), [good]);
  assert.equal(readControllers(w.configDir)[good].kind, 'controller', 'whatever the record says, it is a controller');
  fs.rmSync(file);
  assert.deepEqual(readControllers(w.configDir), {});
});

test("a key that is a controller and then pairs with the Host's own code is the owner's client, and the controller record is retired", async (t) => {
  const w = await servedHost(t);
  const id = w.identity('both');
  const fp = w.pairing.add(id.publicKey, { name: 'Mac', kind: 'controller' });
  assert.equal(w.pairing.principal(fp)?.kind, 'controller');
  await w.paired('both', 'Mac');
  assert.equal(w.pairing.principal(fp)?.kind, 'desktop');
  assert.deepEqual(readControllers(w.paths.configDir), {}, 'the controller record is gone');
  assert.equal(w.pairing.list().filter((c: any) => c.fingerprint === fp).length, 1);
});

test("the pairing's record of an audit line: a refused request is coalesced, anything else goes straight to the audit; a controller's connection is the governed line", async (t) => {
  const w = world(t);
  const lines: any[] = [];
  const pairing = createPairing({ configDir: w.configDir, audit: (e: any) => lines.push(e) });
  const by = { fingerprint: 'f'.repeat(64), name: 'Mac', kind: 'controller' };
  pairing.record({ kind: 'controller.connected', by });
  pairing.record({ kind: 'client.refused', by, what: { tool: 'host.modelKey' } });
  pairing.record({ kind: 'client.refused', by, what: { tool: 'host.modelKey' } });
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['controller.connected', 'client.refused'],
  );
  const { pairingAuditOf } = await import('../host/src/auditWiring.mjs');
  const seen: string[] = [];
  const wired = pairingAuditOf({
    governed: (e: any) => (seen.push(`governed ${e.kind}`), true),
    note: (e: any) => void seen.push(`note ${e.kind}`),
  });
  wired({ kind: 'controller.connected' });
  wired({ kind: 'client.added' });
  wired({ kind: 'client.refused' });
  assert.deepEqual(seen, ['governed controller.connected', 'note client.added', 'note client.refused']);
});
