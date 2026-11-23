// Phone SQLite databases open one at a time: concurrent native opens raced expo-modules-core's file-system manager into a crash at launch.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));

type Pending = { name: string; resolve: (db: unknown) => void; reject: (error: Error) => void };
const pending: Pending[] = [];
mock.module(require.resolve('expo-sqlite'), {
  namedExports: {
    openDatabaseAsync: (name: string) => new Promise((resolve, reject) => pending.push({ name, resolve, reject })),
  },
});
// through a variable, so the desktop typecheck does not follow into React Native's global types
const openerPath = '../mobile/src/platform/sqliteOpen.ts';
const { openDatabase } = await import(openerPath);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a second open waits for the first, and a failed open does not hold back the next', async () => {
  const first = openDatabase('a.db');
  const second = openDatabase('b.db');
  const third = openDatabase('c.db');
  await settle();
  assert.deepEqual(
    pending.map((p) => p.name),
    ['a.db'],
  );
  pending[0].resolve('A');
  assert.equal(await first, 'A');
  await settle();
  assert.deepEqual(
    pending.map((p) => p.name),
    ['a.db', 'b.db'],
  );
  pending[1].reject(new Error('disk full'));
  await assert.rejects(second, /disk full/);
  await settle();
  assert.equal(pending[2].name, 'c.db');
  pending[2].resolve('C');
  assert.equal(await third, 'C');
});

test('no phone source opens a database except through the serial opener', () => {
  const root = new URL('../mobile/src/', import.meta.url).pathname;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry) && !path.endsWith('sqliteOpen.ts') && /openDatabase(Async|Sync)\s*\(/.test(readFileSync(path, 'utf8')))
        offenders.push(path);
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
