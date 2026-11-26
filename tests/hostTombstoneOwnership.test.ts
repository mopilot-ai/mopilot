// What a removed controller's relay link may and may not take with it (#5747, host/src/relayLink.mjs with codePairWiring.mjs and pairing.mjs): only a controller's link (made by pairing by code) is ever retired, never the Mac app's own or a phone's, even when a record edited by hand names it; a removal whose tombstone cannot be written still refuses the link in this process and says so in the audit record; a Mac that pairs by code again has the link it had retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayLinks } from '../host/src/relayLink.mjs';
// @ts-ignore: plain ESM without declarations
import { codePairFor } from '../host/src/codePairWiring.mjs';
// @ts-ignore
import { createPairing } from '../host/src/pairing.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { toBase64 } from '../shared/remote/envelope.mjs';

const prim = createNodePrimitives();
const key = (n: number) => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, n)]).toString('base64');
/** A relay socket that never opens: these links are judged on disk and in memory only. */
const quietSocket = () => ({ send: () => undefined, close: () => undefined });

function world(t: any) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tomb-own-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, 'config');
  const links = createRelayLinks({ configDir, socketPath: path.join(dir, 'h.sock'), createSocket: quietSocket });
  t.after(() => links.close());
  const enroll = (hostId: string, o: { createOnly?: boolean; client?: string } = {}) =>
    links.enroll(
      {
        relayUrl: 'wss://relay.example/v1/ws',
        hostId,
        secret: 'S'.repeat(43),
        pairId: `p_${hostId.slice(2, 12)}`,
        appPub: toBase64(prim.x25519Base(prim.randomBytes(32))),
        appEphPub: toBase64(prim.x25519Base(prim.randomBytes(32))),
        ...(o.client ? { client: o.client } : {}),
      },
      { createOnly: o.createOnly ?? false },
    );
  const file = path.join(configDir, 'relay.json');
  const kept = () => JSON.parse(fs.readFileSync(file, 'utf8')).links;
  const state = (id: string): any => links.status().links.find((l: any) => l.hostId === id);
  return { dir, configDir, links, enroll, file, kept, state };
}

test('only a controller’s link is retired: the Mac app’s own and a phone’s are refused and left serving, on disk and in memory', (t) => {
  const w = world(t);
  w.enroll('h_ctl0000000000001', { createOnly: true });
  w.enroll('h_app0000000000001');
  w.enroll('h_phone00000000001', { client: 'c'.repeat(64) });
  assert.deepEqual(w.links.retire({ hostId: 'h_app0000000000001' }), { retired: false, refused: 'not_controller' });
  assert.deepEqual(w.links.retire({ hostId: 'h_phone00000000001' }), { retired: false, refused: 'not_controller' });
  assert.deepEqual(w.links.retire({ hostId: 'h_ctl0000000000001' }), { retired: true });
  assert.deepEqual(
    w.kept().map((e: any) => [e.hostId, e.kind ?? null, e.retiredAt !== undefined]),
    [
      ['h_ctl0000000000001', 'controller', true],
      ['h_app0000000000001', null, false],
      ['h_phone00000000001', null, false],
    ],
  );
  // a link open here but no longer on disk goes only when it is a controller's
  fs.writeFileSync(w.file, JSON.stringify({ version: 1, links: [] }));
  assert.deepEqual(w.links.retire({ hostId: 'h_app0000000000001' }), { retired: false });
  assert.ok(w.state('h_app0000000000001'), 'the app’s own link is still open');
  assert.deepEqual(w.links.retireLive({ hostId: 'h_app0000000000001' }), { retired: false });
  assert.deepEqual(w.links.retireLive({ hostId: 'h_missing000000001' }), { retired: false });
});

test('the fallback when a tombstone cannot be written: the controller’s link refuses in this process, told once as unsaved, and the unreadable file is never written over', (t) => {
  const w = world(t);
  const told: any[] = [];
  w.links.onTombstone((e) => told.push(e));
  w.enroll('h_ctl0000000000001', { createOnly: true });
  w.enroll('h_ctl0000000000002', { createOnly: true });
  fs.writeFileSync(w.file, '{"version":1,"links":[');
  assert.throws(() => w.links.retire({ hostId: 'h_ctl0000000000001' }), /cannot be read/);
  assert.deepEqual(w.links.retireLive({ hostId: 'h_ctl0000000000001' }), { retired: true });
  assert.deepEqual(w.links.retireLive({ hostId: 'h_ctl0000000000001' }), { retired: true });
  assert.equal(w.state('h_ctl0000000000001').retired, true);
  assert.equal(w.state('h_ctl0000000000001').session, 'closed');
  assert.deepEqual(told, [{ kind: 'link.retired', outcome: 'unsaved' }]);
  // forgetting another link leaves the file as it was, so the links it hides are not lost
  assert.deepEqual(w.links.forget({ hostId: 'h_ctl0000000000002' }), { removed: true });
  assert.equal(fs.readFileSync(w.file, 'utf8'), '{"version":1,"links":[');
});

/** The Host's pairing by code over the real relay links and client table (no approval proofs: those have their own tests). */
function served(t: any) {
  const w = world(t);
  const pairing = createPairing({ configDir: w.configDir });
  const notes: any[] = [];
  const reports: string[] = [];
  const service: any = codePairFor({
    env: { MOPILOT_HOST_CODE_PAIR: '1' },
    paths: { dataDir: path.join(w.dir, 'data'), configDir: w.configDir },
    relayLinks: w.links,
    pairing: { ...pairing, believeControllers: () => undefined },
    policy: { allowsClient: () => true },
    audit: { note: (e: any) => notes.push(e) },
    report: (m: string) => reports.push(m),
    platform: 'darwin',
  });
  return { ...w, pairing, service, notes, reports };
}

test('Revoke with relay.json unreadable: the record goes, the link refuses at once, and the audit record says it was not kept', (t) => {
  const s = served(t);
  s.enroll('h_ctl0000000000001', { createOnly: true });
  const fp = s.pairing.add(key(1), { name: 'A', kind: 'controller', link: 'h_ctl0000000000001' });
  fs.writeFileSync(s.file, '{');
  assert.equal(s.pairing.remove(fp), true);
  assert.equal(s.state('h_ctl0000000000001').retired, true);
  assert.ok(s.reports.some((m) => /could not retire a relay link/.test(m)));
  assert.deepEqual(
    s.notes.filter((e) => e.kind.startsWith('link.')),
    [{ kind: 'link.retired', by: { kind: 'controller' }, what: { outcome: 'unsaved' } }],
  );
});

test('a Mac that pairs by code again has the link it had retired; reset approval never retires a link a record edited by hand points at', (t) => {
  const s = served(t);
  s.enroll('h_ctl0000000000001', { createOnly: true });
  s.pairing.add(key(1), { name: 'A', kind: 'controller', link: 'h_ctl0000000000001' });
  s.enroll('h_ctl0000000000002', { createOnly: true });
  s.pairing.add(key(1), { name: 'A', kind: 'controller', link: 'h_ctl0000000000002' });
  assert.equal(s.state('h_ctl0000000000001').retired, true, 'the old link is a tombstone');
  assert.equal(s.state('h_ctl0000000000002').retired, undefined, 'the new one serves');
  // a record edited by hand names the Mac app's own link
  s.enroll('h_app0000000000001');
  s.pairing.add(key(2), { name: 'B', kind: 'controller', link: 'h_app0000000000001' });
  fs.writeFileSync(path.join(s.configDir, 'approval-key.json'), '{}');
  assert.deepEqual(s.service.resetApproval(), { reset: true, controllers: 2 });
  assert.equal(s.state('h_ctl0000000000002').retired, true);
  assert.equal(s.state('h_app0000000000001').retired, undefined, 'the app’s own link is left serving');
  assert.equal(s.kept().find((e: any) => e.hostId === 'h_app0000000000001').retiredAt, undefined);
});
