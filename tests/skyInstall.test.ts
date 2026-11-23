// electron/capabilities/skyInstall.cjs: when Codex Computer Use is installed or updated from the bundled copy,
// and the copy itself (ditto stubbed by a plain copy, in a temporary folder; never the real Codex home).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const runs: string[][] = [];
let dittoError: Error | null = null;
let copies = true;
mock.module('node:child_process', {
  namedExports: {
    // ditto --noqtn <src> <dst>, as a plain recursive copy
    execFile: (file: string, args: string[], cb: (err: Error | null, out?: string) => void) => {
      runs.push([file, ...args]);
      if (dittoError) return cb(dittoError);
      if (copies) fs.cpSync(args[1], args[2], { recursive: true });
      cb(null, '');
    },
  },
});
const require = createRequire(import.meta.url);
const { skyInstallPlan, installSky } = require('../electron/capabilities/skyInstall.cjs');

const CANON = '/h/.codex/computer-use/Codex Computer Use.app';
const sky = (o: any = {}) => ({ present: false, path: null, version: null, bundled: '26.2', source: '/b/Sky.app', canonical: CANON, ...o });

test('plan: install where missing, update an older canonical copy, otherwise nothing', () => {
  const plan = (action: string) => ({ action, source: '/b/Sky.app', target: CANON, version: '26.2' });
  assert.deepEqual(skyInstallPlan(sky()), plan('install'));
  assert.deepEqual(skyInstallPlan(sky({ present: true, path: CANON, version: '26.1' })), plan('update'));
  // the same or a newer version, or one that can't be compared, stays
  assert.equal(skyInstallPlan(sky({ present: true, path: CANON, version: '26.2' })), null);
  assert.equal(skyInstallPlan(sky({ present: true, path: CANON, version: '27.0' })), null);
  assert.equal(skyInstallPlan(sky({ present: true, path: CANON, version: null })), null);
  // a copy the plugin keeps somewhere else is its choice
  assert.equal(skyInstallPlan(sky({ present: true, path: '/Other/Sky.app', version: '26.1' })), null);
  // nothing to copy from, nowhere to put it, or no known bundled version
  assert.equal(skyInstallPlan(sky({ source: null })), null);
  assert.equal(skyInstallPlan(sky({ canonical: null })), null);
  assert.equal(skyInstallPlan(sky({ bundled: null })), null);
  assert.equal(skyInstallPlan(null), null);
});

/** A fake app bundle with a read-only folder, as shipped apps can have. */
function bundle(dir: string, version: string) {
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), version);
  fs.chmodSync(path.join(dir, 'Contents', 'MacOS'), 0o555);
}

test('install: ditto --noqtn into a sibling, then swapped in over a read-only older copy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-install-'));
  try {
    const source = path.join(root, 'bundled', 'Codex Computer Use.app');
    const target = path.join(root, 'codex', 'computer-use', 'Codex Computer Use.app');
    bundle(source, '26.2');
    // first install: the computer-use folder is created
    await installSky({ source, target });
    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8'), '26.2');
    assert.deepEqual(runs.at(-1), ['/usr/bin/ditto', '--noqtn', source, `${target}.mopilot-${process.pid}`]);
    // update over an older copy whose folders are read-only, with a stale staging folder left behind
    fs.writeFileSync(path.join(source, 'Contents', 'Info.plist'), '26.3');
    bundle(`${target}.mopilot-${process.pid}`, 'stale');
    await installSky({ source, target });
    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8'), '26.3');
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['Codex Computer Use.app']);
    // a failed copy leaves the installed one as it was, and no staging folder
    dittoError = new Error('ditto: No space left on device');
    await assert.rejects(installSky({ source, target }), /No space left/);
    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8'), '26.3');
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['Codex Computer Use.app']);
  } finally {
    dittoError = null;
    fs.chmodSync(root, 0o755);
    for (const d of fs.readdirSync(root, { recursive: true }) as string[]) {
      const p = path.join(root, d);
      if (fs.lstatSync(p).isDirectory()) fs.chmodSync(p, 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install: the copy error is reported even when cleaning up after it fails; a file in the way is just removed', async () => {
  dittoError = new Error('ditto failed');
  let lstats = 0;
  const fsp: any = {
    mkdir: async () => {},
    // the staging folder isn't there before the copy; after the failed copy it can't be read
    lstat: async () => {
      if (lstats++) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    rm: async () => {},
  };
  try {
    await assert.rejects(installSky({ source: '/s', target: '/t/Sky.app' }, fsp), /ditto failed/);
  } finally {
    dittoError = null;
  }
  // a path that is a file, not a folder, is just removed
  copies = false;
  const removed: string[] = [];
  const files: any = {
    mkdir: async () => {},
    lstat: async () => ({ isDirectory: () => false }),
    rm: async (p: string) => removed.push(p),
    rename: async () => {},
  };
  await installSky({ source: '/s', target: '/t/Sky.app' }, files);
  copies = true;
  assert.deepEqual(removed, [`/t/Sky.app.mopilot-${process.pid}`, '/t/Sky.app']);
});
