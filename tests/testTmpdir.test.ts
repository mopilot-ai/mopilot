// Each test process gets its own temp folder, removed on exit; a killed process's folder is swept by the next one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isolateTmpdir, OWNED, PARENT } from './support/test-tmpdir.ts';

export const GUARDS = ['tests/support/'];

test('this test process already runs in its own temp folder (register.ts installs the guard)', () => {
  assert.equal(path.basename(path.dirname(os.tmpdir())), PARENT);
  assert.match(path.basename(os.tmpdir()), new RegExp(`^${process.pid}-`));
  assert.equal(process.env[OWNED], os.tmpdir());
});

test('a new folder per process, dead owners swept, live owners and other names kept, removed on exit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, PARENT);
  for (const name of ['111-dead', '222-live', 'notes']) fs.mkdirSync(path.join(parent, name), { recursive: true });
  const env: Record<string, string | undefined> = { TMPDIR: root };
  const handlers: (() => void)[] = [];
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = root;
  let dir: string;
  try {
    dir = isolateTmpdir({ env, pid: 333, isAlive: (p) => p === 222, onExit: (h) => handlers.push(h) });
  } finally {
    process.env.TMPDIR = saved;
  }
  assert.equal(path.dirname(dir), parent);
  assert.match(path.basename(dir), /^333-/);
  assert.deepEqual([env.TMPDIR, env[OWNED]], [dir, dir]);
  assert.deepEqual(fs.readdirSync(parent).sort(), ['222-live', path.basename(dir), 'notes'].sort());
  fs.mkdirSync(path.join(dir, 'leaked-fixture'));
  handlers[0]();
  assert.equal(fs.existsSync(dir), false);
  // a folder that cannot be removed is left for the sweep, not thrown out of the exit handler
  const stuck = isolateTmpdir({
    env: {},
    fs: {
      ...fs,
      rmSync: () => {
        throw new Error('EBUSY');
      },
    } as any,
    onExit: (h) => handlers.push(h),
  });
  assert.doesNotThrow(() => handlers[1]());
  fs.rmSync(stuck, { recursive: true, force: true });
});

test("a dead owner's folder that cannot be removed is left, and the process still gets its own folder", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-locked-'));
  const locked = path.join(root, PARENT, '111-dead', 'ro');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'f'), '');
  fs.chmodSync(locked, 0o500);
  t.after(() => {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    const dir = isolateTmpdir({ env: {}, pid: 444, isAlive: () => false, onExit: () => {} });
    assert.equal(path.dirname(dir), path.join(root, PARENT));
  } finally {
    process.env.TMPDIR = saved;
  }
  assert.ok(fs.existsSync(locked), 'left for a later sweep instead of failing this process');
});

test('a test process started by a test keeps the folder it inherited instead of nesting one', () => {
  const env = { TMPDIR: '/t/mpt/9-abc', [OWNED]: '/t/mpt/9-abc' };
  const fail = () => {
    throw new Error('touched the file system');
  };
  assert.equal(isolateTmpdir({ env, fs: { mkdirSync: fail } as any, onExit: fail }), '/t/mpt/9-abc');
});

test('a real test process that leaks temp folders leaves nothing behind when it exits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const leak =
    "const fs=require('fs'),os=require('os'),p=require('path');for(let i=0;i<5;i++)fs.mkdtempSync(p.join(os.tmpdir(),'sage-main-'));";
  const r = spawnSync(process.execPath, ['--import', path.resolve('tests/support/register.ts'), '-e', leak], {
    env: { ...process.env, TMPDIR: root, [OWNED]: '' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(root), [PARENT]);
  assert.deepEqual(fs.readdirSync(path.join(root, PARENT)), []);
});
