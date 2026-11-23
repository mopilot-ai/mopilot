// MoMo Google sealed files (shared/momoGoogle/store.mjs): sealed at rest, never plain, never taken for empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as io from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createAccountFile,
  createClientsFile,
  createVersionStore,
  SealUnavailableError,
  type SafeStorage,
} from '../shared/momoGoogle/store.mjs';
import { record } from './support/googleAccountKit.ts';

const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
const storage = (available = true): SafeStorage => ({
  isEncryptionAvailable: () => available,
  encryptString: (t) => xor(Buffer.from(t)),
  decryptString: (b) => xor(b).toString('utf8'),
});
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'momo-google-'));

test('the account file is sealed (no token in plain text), owner-only, and round-trips', async () => {
  const dir = path.join(await tmp(), 'google');
  const file = createAccountFile(dir, storage(), io);
  assert.equal(await file.load(), null);
  await file.save(record());
  const onDisk = await readFile(path.join(dir, 'google-account.sealed'), 'utf8');
  const envelope = JSON.parse(onDisk);
  assert.equal(envelope.enc, 'safe', 'the envelope every sealed MoMo file has, which the move check opens');
  assert.ok(!Buffer.from(envelope.data, 'base64').toString().includes('refreshToken'), 'not even the sealed form is the JSON');
  assert.ok(!onDisk.includes('refreshToken'));
  assert.equal((await stat(path.join(dir, 'google-account.sealed'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await file.load(), record());
  await file.clear();
  assert.equal(await file.load(), null);
  await file.clear();
});

test('without encryption nothing is read or written; a file that does not decrypt is an error, never empty', async () => {
  const dir = await tmp();
  await assert.rejects(createAccountFile(dir, storage(false), io).save(record()), SealUnavailableError);
  await assert.rejects(createAccountFile(dir, storage(false), io).load(), /cannot be sealed/);
  await writeFile(path.join(dir, 'google-account.sealed'), 'bm90IGpzb24=');
  await assert.rejects(createAccountFile(dir, storage(), io).load());
  const unreadable = await tmp();
  await mkdir(path.join(unreadable, 'google-account.sealed'));
  await assert.rejects(createAccountFile(unreadable, storage(), io).load(), /EISDIR/);
});

test('changes to the same file run one after another and a failed one does not block the next', async () => {
  const dir = await tmp();
  let ok = true;
  const s: SafeStorage = {
    isEncryptionAvailable: () => ok,
    encryptString: storage().encryptString,
    decryptString: storage().decryptString,
  };
  const file = createAccountFile(dir, s, io);
  ok = false;
  await assert.rejects(file.save(record()), SealUnavailableError);
  ok = true;
  await Promise.all([file.save(record({ email: 'a@x.com' })), file.save(record({ email: 'b@x.com' }))]);
  assert.equal((await file.load())?.email, 'b@x.com');
});

test('the version store keeps cursors durably, loads once, and survives a failed first read', async () => {
  const dir = await tmp();
  const s1 = createVersionStore(dir, storage(), io);
  assert.equal(await s1.get('gmail:t1'), undefined);
  await s1.set('gmail:t1', 'v1');
  await s1.set('calendar:token', 'tok');
  await s1.flush();
  const s2 = createVersionStore(dir, storage(), io);
  assert.equal(await s2.get('gmail:t1'), 'v1');
  await s2.set('pending', 'x'); // a change still waiting for its write is dropped by a clear
  await s2.clear();
  assert.equal(await s2.get('gmail:t1'), undefined);
  assert.equal(await createVersionStore(dir, storage(), io).get('gmail:t1'), undefined);

  let ok = false;
  const flaky = createVersionStore(dir, { ...storage(), isEncryptionAvailable: () => ok }, io);
  await assert.rejects(flaky.get('k'), SealUnavailableError);
  ok = true;
  assert.equal(await flaky.get('k'), undefined);
  await flaky.set('k', 'v');
  await flaky.flush();
  assert.equal(await createVersionStore(dir, storage(), io).get('k'), 'v');
});

test('the Google clients file keeps the clients sealed and answers none before they are set', async () => {
  const dir = await tmp();
  const file = createClientsFile(dir, storage(), io);
  assert.equal(await file.load(), null);
  const clients = { desktop: { clientId: 'd', clientSecret: 's', authUri: 'a', tokenUri: 't', revokeUri: 'r' } };
  await file.save(clients);
  assert.ok(!(await readFile(path.join(dir, 'google-clients.sealed'), 'utf8')).includes('clientSecret'));
  assert.deepEqual(await createClientsFile(dir, storage(), io).load(), clients);
  await file.clear();
  assert.equal(await file.load(), null);
});

test('a file that is not a sealed envelope is refused, never taken for empty', async () => {
  const dir = path.join(await tmp(), 'google');
  const file = createAccountFile(dir, storage(), io);
  await file.save(record());
  await writeFile(path.join(dir, 'google-account.sealed'), JSON.stringify({ enc: 'plain', data: 'x' }));
  await assert.rejects(file.load(), /not a sealed envelope/);
});
