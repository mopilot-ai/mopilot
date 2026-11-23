// Only a desktop client is an update key (host/src/updateKeys.mjs, pairing.mjs desktopKeys): a phone or the CLI that is paired never signs a Host update, in the pairing and through key rotation (I6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore
import { createUpdateKeys } from '../host/src/updateKeys.mjs';
import { keyIdOf } from '../shared/host/updateSignature.mjs';
import { pemPair } from './support/hostUpdateKit.ts';
import { tmpDir } from './support/hostClientsWorld.ts';

const derOf = (pem: string) => pem.replace(/-----[A-Z ]+-----|\s/g, '');
const idsOf = (keys: any) => keys.entries().map((k: any) => k.id);

test('I6: a phone or CLI client key never appears among the update keys; a desktop one does', (t) => {
  const dir = tmpDir(t);
  const cfg = path.join(dir, 'config');
  const pairing = createPairing({ configDir: cfg });
  const keys = createUpdateKeys({ configDir: cfg, fileKey: () => null });
  const [desktop, phone, cli] = [pemPair(), pemPair(), pemPair()];
  pairing.add(derOf(desktop.pub), { kind: 'desktop', name: 'Mac' });
  pairing.add(derOf(phone.pub), { kind: 'phone', name: 'Pocket' });
  pairing.add(derOf(cli.pub), { kind: 'cli' });
  assert.deepEqual(idsOf(keys), [keyIdOf(desktop.pub)]);
  assert.equal(pairing.paired(), 3, 'the phone and the CLI still connect');
  assert.deepEqual(pairing.desktopKeys(), [derOf(desktop.pub)]);
  // a record read from an older file (a bare key) is a desktop, so an upgrade does not lock a Host out of its own updates
  const file = path.join(cfg, 'pairing.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.clients = { [Object.keys(raw.clients)[0]]: derOf(desktop.pub) };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.deepEqual(idsOf(keys), [keyIdOf(desktop.pub)]);
});

test('a signed rotation adds the next key as a desktop client introduced by the signing key; a client already there is kept as it is', (t) => {
  const dir = tmpDir(t);
  const cfg = path.join(dir, 'config');
  const pairing = createPairing({ configDir: cfg });
  const keys = createUpdateKeys({ configDir: cfg, fileKey: () => null });
  const [current, next, phone] = [pemPair(), pemPair(), pemPair()];
  const signedBy = pairing.add(derOf(current.pub), {
    kind: 'desktop',
    name: 'Mac',
  });
  const phoneFp = pairing.add(derOf(phone.pub), {
    kind: 'phone',
    name: 'Pocket',
  });
  keys.apply({ signedBy: keyIdOf(current.pub), nextKey: next.pub });
  const added = pairing.list().find((c: any) => c.fingerprint === keyIdOf(next.pub))!;
  assert.equal(added.kind, 'desktop');
  assert.equal(added.addedBy, keyIdOf(current.pub));
  assert.ok(idsOf(keys).includes(keyIdOf(next.pub)));
  // the phone is neither promoted nor removed by a rotation that names it as nothing
  assert.equal(pairing.principal(phoneFp)?.kind, 'phone');
  assert.equal(pairing.principal(signedBy)?.name, 'Mac');
  // the same rotation applied again leaves the record as it was
  const before = JSON.stringify(pairing.list());
  keys.apply({ signedBy: keyIdOf(current.pub), nextKey: next.pub });
  assert.equal(JSON.stringify(pairing.list()), before);
});

test('a rotation naming a key that is already a phone client does not change what kind of client it is', (t) => {
  const dir = tmpDir(t);
  const cfg = path.join(dir, 'config');
  const pairing = createPairing({ configDir: cfg });
  const keys = createUpdateKeys({ configDir: cfg, fileKey: () => null });
  const [current, phone] = [pemPair(), pemPair()];
  pairing.add(derOf(current.pub), { kind: 'desktop' });
  const fp = pairing.add(derOf(phone.pub), { kind: 'phone', name: 'Pocket' });
  keys.apply({ signedBy: keyIdOf(current.pub), nextKey: phone.pub });
  assert.deepEqual(pairing.principal(fp), {
    fingerprint: fp,
    name: 'Pocket',
    kind: 'phone',
  });
});
