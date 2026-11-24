// A relay link made for a Mac paired by code is only created (host/src/relayLink.mjs `createOnly`, R2b of #5576): the other Mac chose the host id, so an id that is already enrolled is another client's link and is never replaced; an ordinary enrolment still replaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayLinks } from '../host/src/relayLink.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { toBase64 } from '../shared/remote/envelope.mjs';

const prim = createNodePrimitives();
const keys = () => ({
  appPub: toBase64(prim.x25519Base(prim.randomBytes(32))),
  appEphPub: toBase64(prim.x25519Base(prim.randomBytes(32))),
});
const params = (hostId: string, secret: string) => ({
  relayUrl: 'wss://relay.example/v1/ws',
  hostId,
  secret,
  pairId: 'p_pairpairpair',
  ...keys(),
});
const quiet = () => ({ send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null });

function links(t: any, dir?: string) {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rl-create-'));
  if (!dir) t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const l = createRelayLinks({
    configDir: path.join(d, 'config'),
    socketPath: path.join(d, 'h.sock'),
    createSocket: quiet as any,
    report: () => undefined,
  });
  t.after(() => l.close());
  return { l, d, file: path.join(d, 'config', 'relay.json') };
}
const kept = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')).links;

test('createOnly makes a link for an id nobody has, and refuses one that is open or kept, leaving it as it was', (t) => {
  const a = links(t);
  a.l.enroll(params('h_first00000000000001', 'A'.repeat(43)), { createOnly: true });
  const before = kept(a.file);
  assert.throws(() => a.l.enroll(params('h_first00000000000001', 'B'.repeat(43)), { createOnly: true }), /already there/);
  assert.deepEqual(kept(a.file), before, 'the first link is untouched');
  // an enrolment from before a restart is kept in the file though no link is open yet
  const b = links(t, a.d);
  assert.throws(() => b.l.enroll(params('h_first00000000000001', 'C'.repeat(43)), { createOnly: true }), /already there/);
  assert.deepEqual(kept(a.file), before);
  b.l.enroll(params('h_second0000000000002', 'D'.repeat(43)), { createOnly: true });
  assert.equal(kept(a.file).length, 2);
});

test('an ordinary enrolment still replaces the link with the same id', (t) => {
  const a = links(t);
  a.l.enroll(params('h_first00000000000001', 'A'.repeat(43)));
  a.l.enroll(params('h_first00000000000001', 'B'.repeat(43)));
  assert.deepEqual(
    kept(a.file).map((e: any) => e.secret),
    ['B'.repeat(43)],
  );
});

test('a relay.json that cannot be read is no proof that an id is free: a created-only link is refused, and nothing is written; an ordinary enrolment is as before', (t) => {
  for (const junk of ['{', JSON.stringify({ version: 1 }), JSON.stringify({ links: 'x' })]) {
    const a = links(t);
    fs.mkdirSync(path.dirname(a.file), { recursive: true });
    fs.writeFileSync(a.file, junk);
    assert.throws(() => a.l.enroll(params('h_first00000000000001', 'A'.repeat(43)), { createOnly: true }), /cannot be read/, junk);
    assert.equal(fs.readFileSync(a.file, 'utf8'), junk, 'left as it was');
  }
  // no file at all is a Host with none
  const b = links(t);
  b.l.enroll(params('h_first00000000000001', 'A'.repeat(43)), { createOnly: true });
  assert.equal(kept(b.file).length, 1);
});
