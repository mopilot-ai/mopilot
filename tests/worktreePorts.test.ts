// electron/platform/worktreePorts.cjs: one stable port block per worktree folder, recorded in one file that several processes change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createPorts, realHomeUnderTest, FIRST_PORT, BLOCKS, LOCK_TRIES, LOCK_STALE_MS } = require('../electron/platform/worktreePorts.cjs');

function table(t: any) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ports-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'state', 'worktree-ports.json');
}
const stored = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** Every folder exists unless a test says otherwise: these worktree paths are only names. */
const make = (file: string, more: object = {}) => createPorts({ file: () => file, exists: () => true, wait: () => {}, ...more });

test('each worktree keeps its own block of ten, across restarts', (t) => {
  const file = table(t);
  const a = make(file);
  assert.equal(a.portFor('/w/1/app'), FIRST_PORT);
  assert.equal(a.portFor('/w/2/app'), FIRST_PORT + 10);
  assert.equal(a.portFor('/w/1/app'), FIRST_PORT);
  // a second instance (another launch, or another build of the app) reads the same table
  const b = make(file);
  assert.equal(b.portFor('/w/2/app'), FIRST_PORT + 10);
  assert.equal(b.portFor('/w/3/app'), FIRST_PORT + 20);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'no lock is left behind');
});

test('a released block is the next one handed out; releasing an unknown folder writes nothing', (t) => {
  const file = table(t);
  const ports = make(file);
  ports.portFor('/w/1/app');
  ports.portFor('/w/2/app');
  ports.release('/w/1/app');
  assert.equal(ports.portFor('/w/3/app'), FIRST_PORT);
  const before = fs.statSync(file).ino;
  ports.release('/w/none');
  assert.equal(fs.statSync(file).ino, before, 'the table was not replaced');
});

test('a new block first gives up those of folders that are gone, however they went; a full table of live ones says so', (t) => {
  const file = table(t);
  const full: Record<string, number> = {};
  for (let i = 0; i < BLOCKS; i++) full[`/w/${i}/app`] = FIRST_PORT + i * 10;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(full));
  assert.equal(make(file).portFor('/w/new/app'), null);
  assert.equal(make(file, { exists: (dir: string) => dir !== '/w/7/app' }).portFor('/w/new/app'), FIRST_PORT + 70);
  assert.equal('/w/7/app' in stored(file), false);
  // the real check: a folder deleted outside the app loses its block at the next allocation
  const real = table(t);
  const gone = path.join(path.dirname(real), 'gone');
  const kept = path.join(path.dirname(real), 'kept');
  fs.mkdirSync(gone, { recursive: true });
  fs.mkdirSync(kept);
  const ports = createPorts({ file: () => real });
  ports.portFor(gone);
  ports.portFor(kept);
  fs.rmSync(gone, { recursive: true });
  assert.equal(ports.portFor(path.dirname(real)), FIRST_PORT);
  assert.deepEqual(stored(real), { [kept]: FIRST_PORT + 10, [path.dirname(real)]: FIRST_PORT });
});

test('entries that are not a block, or that repeat one, are dropped; a table that is not a map is empty', (t) => {
  const file = table(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ '/a': FIRST_PORT, '/dup': FIRST_PORT, '/odd': FIRST_PORT + 3, '/low': 80, '/high': 65000, '/text': 'x' }),
  );
  assert.equal(make(file).portFor('/dup'), FIRST_PORT + 10);
  assert.deepEqual(stored(file), { '/a': FIRST_PORT, '/dup': FIRST_PORT + 10 });
  for (const junk of ['[1]', '"x"', 'not json']) {
    fs.writeFileSync(file, junk);
    assert.equal(make(file).portFor('/b'), FIRST_PORT);
  }
});

test('two processes allocating at once get different blocks: the second reads the table again under the lock', (t) => {
  const file = table(t);
  fs.mkdirSync(`${file}.lock`, { recursive: true });
  let waits = 0;
  // the other process finishes its change while this one waits for the lock
  const wait = () => {
    waits++;
    fs.writeFileSync(file, JSON.stringify({ '/w/other/app': FIRST_PORT }));
    fs.rmdirSync(`${file}.lock`);
  };
  const ports = make(file, { wait });
  assert.equal(ports.portFor('/w/mine/app'), FIRST_PORT + 10);
  assert.equal(waits, 1);
  assert.deepEqual(stored(file), { '/w/other/app': FIRST_PORT, '/w/mine/app': FIRST_PORT + 10 });
  // and when the other process recorded this very folder meanwhile, its block is the answer
  fs.mkdirSync(`${file}.lock`);
  const same = make(file, {
    wait: () => {
      fs.writeFileSync(file, JSON.stringify({ '/w/late/app': FIRST_PORT + 40 }));
      fs.rmdirSync(`${file}.lock`);
    },
  });
  assert.equal(same.portFor('/w/late/app'), FIRST_PORT + 40);
  // a release that raced an allocation keeps the allocation
  fs.mkdirSync(`${file}.lock`);
  const releasing = make(file, {
    wait: () => {
      fs.writeFileSync(file, JSON.stringify({ '/w/late/app': FIRST_PORT + 40, '/w/new/app': FIRST_PORT }));
      fs.rmdirSync(`${file}.lock`);
    },
  });
  releasing.release('/w/late/app');
  assert.deepEqual(stored(file), { '/w/new/app': FIRST_PORT });
});

test("a dead holder's lock is taken over; one that never ends does not stop the allocation", (t) => {
  const file = table(t);
  fs.mkdirSync(`${file}.lock`, { recursive: true });
  let waits = 0;
  const stuck = make(file, { wait: () => waits++ });
  assert.equal(stuck.portFor('/w/1/app'), FIRST_PORT);
  assert.equal(waits, LOCK_TRIES);
  assert.equal(fs.existsSync(`${file}.lock`), true, "another process's lock is not removed while it may be alive");
  const later = make(file, { wait: () => assert.fail('a stale lock is not waited for'), now: () => Date.now() + LOCK_STALE_MS + 1000 });
  assert.equal(later.portFor('/w/2/app'), FIRST_PORT + 10);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a lock released just as it is looked at is waited for briefly with the real clock, then taken', (t) => {
  const file = table(t);
  fs.mkdirSync(`${file}.lock`, { recursive: true });
  let asked = 0;
  // the holder finishes between the failed attempt and the look at its lock's age
  const now = () => {
    if (asked++ === 0) fs.rmdirSync(`${file}.lock`);
    return Date.now();
  };
  const started = Date.now();
  const ports = createPorts({ file: () => file, exists: () => true, now });
  assert.equal(ports.portFor('/w/1/app'), FIRST_PORT);
  assert.equal(asked, 2);
  assert.ok(Date.now() - started >= 9, 'the default wait pauses before the next attempt');
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a table that can be neither locked nor written still gives this run its block, without waiting', (t) => {
  const file = table(t);
  // its folder's name is taken by a file
  fs.writeFileSync(path.dirname(file), '');
  const ports = make(file, { wait: () => assert.fail('nothing to wait for') });
  assert.equal(ports.portFor('/w/1/app'), FIRST_PORT);
  ports.release('/w/1/app');
  assert.equal(fs.statSync(path.dirname(file)).isFile(), true);
  // the folder is there but the lock cannot be made in it
  const other = table(t);
  fs.mkdirSync(path.dirname(other), { recursive: true });
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (p: string, o: any) => {
    if (String(p).endsWith('.lock')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return mkdir(p, o);
  });
  assert.equal(make(other, { wait: () => assert.fail('nothing to wait for') }).portFor('/w/1/app'), FIRST_PORT);
  assert.deepEqual(stored(other), { '/w/1/app': FIRST_PORT });
});

test("under the test runner the real home's table is neither read nor written", () => {
  const home = os.userInfo().homedir;
  const real = path.join(home, '.mopilot', 'worktree-ports.json');
  const ports = createPorts({ file: () => real });
  assert.equal(ports.portFor('/w/1/app'), null);
  ports.release('/w/1/app');
  const testing = { NODE_TEST_CONTEXT: '1' };
  assert.equal(realHomeUnderTest(real, testing), true);
  assert.equal(realHomeUnderTest(path.join(home, '..cache', 'x.json'), testing), true, 'a folder in home whose name starts with dots');
  assert.equal(realHomeUnderTest(real, {}), false);
  assert.equal(realHomeUnderTest(`${home}-other/x.json`, testing), false, 'a sibling of home');
  assert.equal(realHomeUnderTest(path.dirname(home), testing), false);
  assert.equal(realHomeUnderTest(path.join(path.parse(home).root, 'elsewhere', 'x.json'), testing), false);
});
