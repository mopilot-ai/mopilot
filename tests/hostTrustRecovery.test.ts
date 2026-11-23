// Host trust recovery: a signed change interrupted between pairing and update-key persistence must finish forward before any later trust read or authentication can serve half-applied state.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { keyIdOf } from '../shared/host/updateSignature.mjs';
import { KEYS, pemPair } from './support/hostUpdateKit.ts';
const require = createRequire(import.meta.url);
const { createPairing } = require('../host/src/pairing.mjs');
const { createUpdateKeys } = require('../host/src/updateKeys.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-trust-recovery-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const id = keyIdOf(KEYS.pub);
function world() {
  const configDir = fs.mkdtempSync(path.join(base, 'config-'));
  const pairing = () => createPairing({ configDir });
  pairing().add(KEYS.pub.replace(/-----[^-]+-----|\s/g, ''));
  const keys = () => createUpdateKeys({ configDir, fileKey: () => KEYS.pub, now: () => 1_800_000_000_000 });
  keys().entries();
  keys().markSeen(id);
  const next = pemPair();
  return { configDir, pairing, keys, next, change: { signedBy: keyIdOf(next.pub), nextKey: next.pub, revoke: [id] } };
}
function renameFault(target: string, work: () => void) {
  const rename = fs.renameSync;
  fs.renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
    if (String(b) === target) throw Object.assign(new Error('injected disk fault'), { code: 'EIO' });
    return rename(a, b);
  }) as typeof fs.renameSync;
  try {
    work();
  } finally {
    fs.renameSync = rename;
  }
}

test('a failed revocation write is recovered by the next store, never resurrected by authentication timestamps', () => {
  const w = world();
  renameFault(path.join(w.configDir, 'update-keys.json'), () => assert.throws(() => w.keys().apply(w.change), /injected disk fault/));
  assert.deepEqual(w.keys().revoked(), [id], 'the accepted revocation intent finishes forward on read');
  assert.equal(w.pairing().knows(id), false);
  assert.equal(w.pairing().knows(keyIdOf(w.next.pub)), true);
  w.keys().markSeen(id);
  assert.deepEqual(w.keys().revoked(), [id]);
  assert.equal(
    w
      .keys()
      .entries()
      .some((k: any) => k.id === id),
    false,
  );
});

test('a pairing-write failure is recovered before pairing reads expose a partial change', () => {
  const w = world();
  renameFault(path.join(w.configDir, 'pairing.json'), () => assert.throws(() => w.keys().apply(w.change), /injected disk fault/));
  assert.equal(w.pairing().knows(id), false);
  assert.equal(w.pairing().paired(), 1);
  assert.equal(w.pairing().publicKeys().length, 1);
  assert.deepEqual(w.keys().revoked(), [id]);
});

test('failure before intent publication changes nothing, and retry can commit normally', () => {
  const w = world();
  renameFault(path.join(w.configDir, 'trust-pending.json'), () => assert.throws(() => w.keys().apply(w.change), /injected disk fault/));
  assert.equal(w.pairing().knows(id), true);
  assert.deepEqual(w.keys().revoked(), []);
  w.keys().apply(w.change);
  assert.deepEqual(w.keys().revoked(), [id]);
});

test('an unreadable or malformed pending intent blocks every trust path rather than forgetting a revocation', () => {
  const w = world();
  const pending = path.join(w.configDir, 'trust-pending.json');
  for (const bytes of [
    'not json',
    '{"version":2}',
    '{"version":1,"pairing":{},"keys":{}}',
    '{"version":1,"pairing":{"clients":{}},"keys":{}}',
  ]) {
    fs.writeFileSync(pending, bytes, { mode: 0o600 });
    for (const read of [
      () => w.keys().entries(),
      () => w.keys().revoked(),
      () => w.pairing().knows(id),
      () => w.pairing().publicKeys(),
      () => w.pairing().paired(),
    ])
      assert.throws(read, (e: any) => e.code === 'trust_recovery_failed');
    assert.equal(fs.readFileSync(pending, 'utf8'), bytes);
  }
  fs.rmSync(pending);
  assert.equal(w.pairing().knows(id), true);
});

test('pending cleanup failure is retryable and replay never loses an intervening accepted timestamp', () => {
  const w = world();
  const unlink = fs.unlinkSync;
  fs.unlinkSync = ((file: fs.PathLike) => {
    if (String(file) === path.join(w.configDir, 'trust-pending.json')) throw Object.assign(new Error('cleanup fault'), { code: 'EIO' });
    return unlink(file);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(() => w.keys().apply(w.change), /cleanup fault/);
  } finally {
    fs.unlinkSync = unlink;
  }
  w.keys().markSeen('other-client');
  assert.deepEqual(w.keys().revoked(), [id]);
  const state = JSON.parse(fs.readFileSync(path.join(w.configDir, 'update-keys.json'), 'utf8'));
  assert.equal(state.seen['other-client'], 1_800_000_000_000);
  assert.equal(w.pairing().knows(id), false);
  assert.equal(fs.existsSync(path.join(w.configDir, 'trust-pending.json')), false);
});

test('another process can die between durable files; the next process recovers its lock and revocation', () => {
  const w = world();
  const module = new URL('../host/src/updateKeys.mjs', import.meta.url).href;
  assert.throws(
    () =>
      execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        `
    import fs from 'node:fs';
    import {createUpdateKeys} from ${JSON.stringify(module)};
    const rename = fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to)===${JSON.stringify(path.join(w.configDir, 'update-keys.json'))})process.exit(17);return rename(from,to);};
    createUpdateKeys({configDir:${JSON.stringify(w.configDir)},fileKey:()=>null}).apply(${JSON.stringify(w.change)});
  `,
      ]),
    (e: any) => e.status === 17,
  );
  assert.equal(w.pairing().knows(id), false);
  assert.equal(w.pairing().knows(keyIdOf(w.next.pub)), true);
  assert.deepEqual(w.keys().revoked(), [id]);
});

test('nested reads recover a failed nested change even when the outer owner catches the error', () => {
  const w = world();
  const { withTrustWrite } = require('../host/src/trustWrite.mjs');
  withTrustWrite(w.configDir, () => {
    renameFault(path.join(w.configDir, 'update-keys.json'), () => assert.throws(() => w.keys().apply(w.change), /injected disk fault/));
    assert.deepEqual(w.keys().revoked(), [id]);
    assert.equal(w.pairing().knows(id), false);
  });
});

test('trust publication always forces0600 instead of inheriting broad file modes', () => {
  for (const mode of [0o644, 0o666]) {
    const w = world();
    for (const file of ['pairing.json', 'update-keys.json']) fs.chmodSync(path.join(w.configDir, file), mode);
    renameFault(path.join(w.configDir, 'pairing.json'), () => assert.throws(() => w.keys().apply(w.change), /injected disk fault/));
    const pending = path.join(w.configDir, 'trust-pending.json');
    assert.equal(fs.statSync(pending).mode & 0o777, 0o600);
    fs.chmodSync(pending, mode);
    w.keys().revoked();
    for (const file of ['pairing.json', 'update-keys.json']) assert.equal(fs.statSync(path.join(w.configDir, file)).mode & 0o777, 0o600);
    // Ordinary pairing/timestamp writes have the same strict private-mode contract.
    fs.chmodSync(path.join(w.configDir, 'update-keys.json'), mode);
    w.keys().markSeen('another-client');
    assert.equal(fs.statSync(path.join(w.configDir, 'update-keys.json')).mode & 0o777, 0o600);
  }
});

test('new pending snapshots reject wrong typed fields without weakening legacy-file compatibility', () => {
  const w = world();
  const good = {
    version: 1,
    pairing: JSON.parse(fs.readFileSync(path.join(w.configDir, 'pairing.json'), 'utf8')),
    keys: JSON.parse(fs.readFileSync(path.join(w.configDir, 'update-keys.json'), 'utf8')),
  };
  const cases: any[] = [
    null,
    [],
    { ...good, pairing: null },
    { ...good, keys: [] },
    ...[{ codeHash: 7 }, { expires: 'yesterday' }, { wrong: null }, { clients: [] }, { clients: { x: 7 } }].map((p) => ({
      ...good,
      pairing: { ...good.pairing, ...p },
    })),
    ...[
      { added: {} },
      { revoked: {} },
      { seen: [] },
      { added: [null] },
      { added: [{ id: 7, pem: 'x' }] },
      { added: [{ id: 'x', pem: 7 }] },
      { revoked: [7] },
      { seen: { x: 'yesterday' } },
    ].map((k) => ({ ...good, keys: { ...good.keys, ...k } })),
  ];
  for (const snapshot of cases) {
    const file = path.join(w.configDir, 'trust-pending.json');
    const text = JSON.stringify(snapshot);
    fs.writeFileSync(file, text);
    assert.throws(
      () => w.keys().entries(),
      (e: any) => e.code === 'trust_recovery_failed',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  const pending = path.join(w.configDir, 'trust-pending.json');
  fs.rmSync(pending);
  fs.mkdirSync(pending);
  assert.throws(
    () => w.pairing().paired(),
    (e: any) => e.code === 'trust_recovery_failed',
  );
  fs.rmSync(pending, { recursive: true });
  const target = path.join(w.configDir, 'linked-target.json');
  fs.writeFileSync(target, JSON.stringify(good), { mode: 0o644 });
  fs.symlinkSync(target, pending);
  assert.throws(
    () => w.keys().entries(),
    (e: any) => e.code === 'trust_recovery_failed',
  );
  assert.equal(fs.statSync(target).mode & 0o777, 0o644, 'a non-journal link cannot chmod its target');
  fs.unlinkSync(pending);
  assert.equal(w.pairing().knows(id), true);
});

test('a direct pairing removal finishes pending recovery before accepting the new removal', () => {
  const w = world();
  renameFault(path.join(w.configDir, 'update-keys.json'), () => assert.throws(() => w.keys().apply(w.change), /injected disk fault/));
  w.pairing().remove(keyIdOf(w.next.pub));
  assert.equal(w.pairing().knows(keyIdOf(w.next.pub)), false, 'recovery cannot later resurrect a removal that was accepted after it');
  assert.deepEqual(w.keys().revoked(), [id]);
  assert.equal(w.pairing().paired(), 0);
});
