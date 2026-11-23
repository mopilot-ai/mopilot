// electron/platform/privateFiles.cjs and fsutil's writeAtomic under it (#2144): in the data folder, files are written 0600 and
// folders 0700 whatever the umask or the replaced file's mode; tightenTree takes group and other access off what an
// earlier version left, keeps the user's own bits, never follows a link, and leaves Chromium's and harnesses' insides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keepPrivate, isPrivatePath, mkdirPrivate, tightenTree, ownerOnly } = require('../electron/platform/privateFiles.cjs');
const { writeAtomic } = require('../electron/platform/fsutil.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const mode = (p: string) => fs.lstatSync(p).mode & 0o777;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'private-files-'));

test('writeAtomic in a private folder makes new files 0600 and folders 0700, and takes others off a replaced file', () => {
  const root = tmp();
  keepPrivate(root);
  assert.equal(isPrivatePath(path.join(root, 'a', 'b.json')), true);
  assert.equal(isPrivatePath(root), true);
  assert.equal(isPrivatePath(`${root}-other/x`), false);
  writeAtomic(path.join(root, 'threads', 'c.v2'), '{}');
  assert.equal(mode(path.join(root, 'threads', 'c.v2')), 0o600);
  assert.equal(mode(path.join(root, 'threads')), 0o700);
  const old = path.join(root, 'ui-state.json');
  fs.writeFileSync(old, 'x', { mode: 0o644 });
  fs.chmodSync(old, 0o644);
  writeAtomic(old, 'y');
  assert.equal(mode(old), 0o600);
  // an executable stays one for the user only; an explicit new mode is made owner-only too
  const tool = path.join(root, 'bin', 'tool');
  writeAtomic(tool, '#!/bin/sh', fs, 0o755);
  assert.equal(mode(tool), 0o700);
  // outside it, writeAtomic keeps what it did: a replaced file keeps its mode
  const elsewhere = tmp();
  const kept = path.join(elsewhere, 'project.txt');
  fs.writeFileSync(kept, 'x');
  fs.chmodSync(kept, 0o644);
  writeAtomic(kept, 'y');
  assert.equal(mode(kept), 0o644);
  assert.equal(ownerOnly(0o100755), 0o700);
});

test('mkdirPrivate makes a folder only the user can open, one already there included, never a link’s target', () => {
  const root = tmp();
  const dir = path.join(root, 'uploads', 'chat');
  mkdirPrivate(dir);
  assert.equal(mode(dir), 0o700);
  fs.chmodSync(dir, 0o755);
  mkdirPrivate(dir);
  assert.equal(mode(dir), 0o700);
  // one the user made read-only stays read-only: only group and other access go
  fs.chmodSync(dir, 0o555);
  mkdirPrivate(dir);
  assert.equal(mode(dir), 0o500);
  fs.chmodSync(dir, 0o700);
  const target = tmp();
  fs.chmodSync(target, 0o755);
  fs.symlinkSync(target, path.join(root, 'linked'));
  mkdirPrivate(path.join(root, 'linked'));
  assert.equal(mode(target), 0o755);
});

test('tightenTree leaves Windows alone, where every file reads as 0666', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a'), 'x', { mode: 0o644 });
  fs.chmodSync(path.join(root, 'a'), 0o644);
  assert.equal(await tightenTree(root, fs.promises, 'win32'), 0);
  assert.equal(mode(path.join(root, 'a')), 0o644);
});

test('tightenTree makes what was left open owner-only, skips links, Chromium folders and harness homes’ insides', async () => {
  const root = tmp();
  fs.chmodSync(root, 0o755);
  const put = (rel: string, m: number, body = 'x') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    fs.chmodSync(p, m);
    return p;
  };
  const thread = put('threads/a.v2', 0o644);
  fs.chmodSync(path.join(root, 'threads'), 0o755);
  const script = put('capabilities/bin/sh', 0o755);
  const cache = put('Cache/data_0', 0o644);
  fs.chmodSync(path.join(root, 'Cache'), 0o755);
  const homeFile = put('accounts/one/logs_2.sqlite', 0o644);
  fs.chmodSync(path.join(root, 'accounts', 'one'), 0o755);
  const outside = put('../outside-target', 0o644);
  fs.symlinkSync(outside, path.join(root, 'link'));
  const already = put('ok.json', 0o600);
  const changed = await tightenTree(root);
  assert.equal(mode(root), 0o700);
  assert.equal(mode(thread), 0o600);
  assert.equal(mode(path.join(root, 'threads')), 0o700);
  assert.equal(mode(script), 0o700, 'the user keeps execute');
  assert.equal(mode(cache), 0o644, "Chromium's own folders are left alone");
  assert.equal(mode(path.join(root, 'accounts', 'one')), 0o700, 'a harness home is owner-only');
  assert.equal(mode(homeFile), 0o644, 'what the harness keeps inside its home is its own');
  assert.equal(mode(outside), 0o644, 'a link is never followed');
  assert.equal(mode(already), 0o600);
  // the root, threads/ and its file, capabilities/ and bin/ and its script, accounts/ and the home in it
  assert.equal(changed, 8);
  assert.equal(await tightenTree(root), 0, 'nothing left to change');
});

test('tightenTree goes on past an entry it cannot change, and a missing folder is nothing to do', async () => {
  clearIgnored();
  assert.equal(await tightenTree(path.join(tmp(), 'missing')), 0);
  assert.deepEqual(recentIgnored(), []);
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a', 'f'), 'x');
  fs.chmodSync(path.join(root, 'a', 'f'), 0o644);
  fs.writeFileSync(path.join(root, 'b'), 'x');
  fs.chmodSync(path.join(root, 'b'), 0o644);
  const real = fs.promises;
  const failing = {
    ...real,
    chmod: async (p: string, m: number) => {
      if (p.endsWith(`${path.sep}a`)) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return real.chmod(p, m);
    },
    readdir: async (p: string, o: any) => {
      if (p.endsWith(`${path.sep}gone`)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return real.readdir(p, o);
    },
  };
  fs.mkdirSync(path.join(root, 'gone'));
  fs.chmodSync(path.join(root, 'gone'), 0o755);
  clearIgnored();
  await tightenTree(root, failing);
  assert.equal(mode(path.join(root, 'b')), 0o600, 'the rest goes on');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['make a data file private', 'list a data folder to make it private'],
  );
  const lstatFails = { ...real, lstat: async () => Promise.reject(Object.assign(new Error('io'), { code: 'EIO' })) };
  clearIgnored();
  assert.equal(await tightenTree(root, lstatFails), 0);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['make the data folder private'],
  );
});
