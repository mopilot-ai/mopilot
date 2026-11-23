// Browser import primitives: error classes, copying another browser's database to a private temp folder, and the shared Chromium cookie crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ImportError, classify, CODES } = require('../electron/capabilities/browser/import/errors.cjs');
const { withDatabase, readTextFile, MAX_BYTES } = require('../electron/capabilities/browser/import/snapshot.cjs');
const crypto = require('../shared/chromiumCrypto.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'import-snap-test-'));
const leftovers = (root: string) => fs.readdirSync(root).filter((n) => n.startsWith('mopilot-import-'));

function makeDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2)');
  db.close();
}

test('classify: permission errors block, a missing file is missing, anything else is a failed read', () => {
  assert.ok(CODES.includes('access_blocked'));
  for (const code of ['EPERM', 'EACCES']) assert.equal(classify(Object.assign(new Error('x'), { code })).code, 'access_blocked');
  assert.equal(classify(Object.assign(new Error('x'), { code: 'ENOENT' })).code, 'missing');
  assert.equal(classify(new Error('disk image is malformed')).code, 'read_failed');
  assert.equal(classify('plain string').message, 'plain string');
  const own = new ImportError('busy', 'later');
  assert.equal(classify(own), own);
  assert.equal(own.name, 'ImportError');
});

test('withDatabase: reads a copy read-only, with its -wal sidecar, and removes the copy afterwards', async () => {
  const root = tmp();
  const file = path.join(root, 'History');
  makeDb(file);
  // a sidecar that is present is copied; a symlinked sidecar is skipped
  fs.writeFileSync(`${file}-journal`, '');
  fs.symlinkSync(file, `${file}-shm`);
  const copies: string[] = [];
  const sum = await withDatabase(
    file,
    (db: DatabaseSync) => {
      copies.push(...fs.readdirSync(root).filter((n) => n.startsWith('mopilot-import-')));
      assert.throws(() => db.exec('INSERT INTO t VALUES (3)'), /readonly/i);
      return (db.prepare('SELECT SUM(n) AS s FROM t').get() as { s: number }).s;
    },
    { tmpRoot: root },
  );
  assert.equal(sum, 3);
  assert.equal(copies.length, 1, 'the copy exists while fn runs');
  assert.deepEqual(leftovers(root), [], 'and is gone after');
  // the original is untouched
  assert.equal(new DatabaseSync(file, { readOnly: true }).prepare('SELECT COUNT(*) AS c FROM t').get()!.c, 2);
});

test('withDatabase: refuses symlinks, missing files and oversized files, and still removes the copy when fn throws', async () => {
  const root = tmp();
  const file = path.join(root, 'History');
  makeDb(file);
  const link = path.join(root, 'link');
  fs.symlinkSync(file, link);
  await assert.rejects(() => withDatabase(link, () => 1, { tmpRoot: root }), { code: 'read_failed' });
  await assert.rejects(() => withDatabase(path.join(root, 'none'), () => 1, { tmpRoot: root }), { code: 'missing' });
  const fake = { ...fs, lstatSync: () => ({ isSymbolicLink: () => false, size: MAX_BYTES + 1 }) };
  await assert.rejects(() => withDatabase(file, () => 1, { tmpRoot: root, fs: fake as any }), { code: 'too_large' });
  await assert.rejects(
    () =>
      withDatabase(
        file,
        () => {
          throw new Error('boom');
        },
        { tmpRoot: root },
      ),
    { code: 'read_failed', message: 'boom' },
  );
  // a file that is not a database fails when opened
  const junk = path.join(root, 'junk');
  fs.writeFileSync(junk, 'not sqlite');
  await assert.rejects(() => withDatabase(junk, (db: DatabaseSync) => db.prepare('SELECT 1 FROM sqlite_master').all(), { tmpRoot: root }), {
    code: 'read_failed',
  });
  assert.deepEqual(leftovers(root), []);
});

test('withDatabase: cleanup problems never replace the result', async () => {
  const root = tmp();
  const file = path.join(root, 'History');
  makeDb(file);
  const closing = {
    close() {
      throw new Error('already closed');
    },
  };
  const noRemove = {
    ...fs,
    rmSync() {
      throw new Error('busy');
    },
  };
  const out = await withDatabase(file, () => 'ok', { tmpRoot: root, open: () => closing, fs: noRemove as any });
  assert.equal(out, 'ok');
  // an unreadable sidecar (not ENOENT) only leaves the copy older
  const flaky = {
    ...fs,
    copyFileSync(from: string, to: string) {
      if (from.endsWith('-wal')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.copyFileSync(from, to);
    },
  };
  fs.writeFileSync(`${file}-wal`, '');
  assert.equal(await withDatabase(file, () => 'still ok', { tmpRoot: root, fs: flaky as any }), 'still ok');
});

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`withDatabase: refuses an oversized ${suffix} before copying or opening it`, async () => {
    const root = tmp();
    const file = path.join(root, 'History');
    makeDb(file);
    const sidecar = file + suffix;
    fs.writeFileSync(sidecar, '');
    const copied: string[] = [];
    let opened = false;
    const bounded = {
      ...fs,
      lstatSync(name: string) {
        const st = fs.lstatSync(name);
        return name === sidecar ? Object.assign(st, { size: MAX_BYTES + 1 }) : st;
      },
      copyFileSync(from: string, to: string) {
        copied.push(from);
        fs.copyFileSync(from, to);
      },
    };
    try {
      await assert.rejects(
        () =>
          withDatabase(file, () => 1, {
            tmpRoot: root,
            fs: bounded as any,
            open: () => {
              opened = true;
              return {};
            },
          }),
        { code: 'too_large' },
      );
      assert.equal(copied.includes(sidecar), false);
      assert.equal(opened, false);
      assert.deepEqual(leftovers(root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('withDatabase: sidecars exactly at the size limit are copied and opened', async () => {
  const root = tmp();
  const file = path.join(root, 'History');
  makeDb(file);
  const sidecars = ['-wal', '-shm', '-journal'].map((suffix) => file + suffix);
  for (const name of sidecars) fs.writeFileSync(name, '');
  const copied: string[] = [];
  const bounded = {
    ...fs,
    lstatSync(name: string) {
      const st = fs.lstatSync(name);
      return sidecars.includes(name) ? Object.assign(st, { size: MAX_BYTES }) : st;
    },
    copyFileSync(from: string, to: string) {
      copied.push(from);
      fs.copyFileSync(from, to);
    },
  };
  try {
    assert.equal(
      await withDatabase(file, () => 'ok', {
        tmpRoot: root,
        fs: bounded as any,
        open: () => {
          assert.deepEqual(copied, [file, ...sidecars]);
          return { close() {} };
        },
      }),
      'ok',
    );
    assert.deepEqual(leftovers(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readTextFile: reads a file and refuses symlinks, missing and oversized files', async () => {
  const root = tmp();
  const file = path.join(root, 'Bookmarks');
  fs.writeFileSync(file, '{"a":1}');
  assert.equal(await readTextFile(file), '{"a":1}');
  fs.symlinkSync(file, path.join(root, 'l'));
  await assert.rejects(() => readTextFile(path.join(root, 'l')), { code: 'read_failed' });
  await assert.rejects(() => readTextFile(path.join(root, 'none')), { code: 'missing' });
  const fake = { ...fs, lstatSync: () => ({ isSymbolicLink: () => false, size: MAX_BYTES + 1 }) };
  await assert.rejects(() => readTextFile(file, { fs: fake as any }), { code: 'too_large' });
});

test('chromiumCrypto: v10 values round-trip with and without the schema-24 host hash', () => {
  const key = crypto.deriveKey('pw');
  assert.equal(key.length, 16);
  for (const version of [23, crypto.DOMAIN_HASH_VERSION]) {
    const blob = crypto.encryptValue('abc', key, '.example.test', version);
    assert.equal(crypto.decryptValue(blob, key, '.example.test', version), 'abc');
  }
  const blob = crypto.encryptValue('abc', key, '.example.test', 24);
  assert.equal(crypto.decryptValue(blob, key, '.other.test', 24), null, 'wrong host');
  assert.equal(crypto.decryptValue(blob, crypto.deriveKey('x'), '.example.test', 24), null, 'wrong key');
  assert.equal(crypto.decryptValue(Buffer.from('v11xxxxxxxxxxxxxxxxxxxx'), key, 'h', 24), null, 'not v10');
  assert.equal(crypto.decryptValue(null, key, 'h', 24), null);
});
