// The helper's build stamp (#4320): an older helper binary is reported as out of date instead of dropping clicks silently. The digest of the helper sources, the app's expected value (checkout or packaged), the client relaunching once and then refusing, and the build/install check that leaves no mismatched bundle.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { helperInfo, plist, bundleProblem, writeHelperDigest } from '../scripts/build-helper.mjs';
import { check } from '../scripts/check-helper-bundle.mjs';

const require = createRequire(import.meta.url);
const { UNKNOWN, sourceDigest, expectedDigest, stampProblem, DIGEST_FILE } = require('../electron/capabilities/helperStamp.cjs');
const { ComputerHelper, lineDecoder } = require('../electron/capabilities/computer.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** A repository root with a helper source tree. */
function tree(files: Record<string, string> = { 'Sources/ComputerUseHelper/A.swift': 'let a = 1' }) {
  const root = path.join(tmp, `tree${n++}`);
  fs.mkdirSync(path.join(root, 'native/helper/Sources/ComputerUseHelper'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native/helper/Package.swift'), '// pkg');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, 'native/helper', f), c);
  return root;
}
/** A helper bundle whose plist carries `digest` (none when null). */
function bundle(digest: string | null) {
  const app = path.join(tmp, `Helper${n++}.app`);
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), plist(helperInfo({ version: '1', build: '1', sourceDigest: digest })));
  return app;
}

test('the source digest follows the helper sources: same files, same digest; any edit, new file or manifest change moves it; no helper tree has none', () => {
  const a = tree();
  const same = tree();
  assert.match(sourceDigest(a), /^[0-9a-f]{16}$/);
  assert.equal(sourceDigest(a), sourceDigest(same));
  const before = sourceDigest(a);
  fs.writeFileSync(path.join(a, 'native/helper/Sources/ComputerUseHelper/A.swift'), 'let a = 2');
  assert.notEqual(sourceDigest(a), before);
  const edited = sourceDigest(a);
  fs.mkdirSync(path.join(a, 'native/helper/Sources/Sub'));
  fs.writeFileSync(path.join(a, 'native/helper/Sources/Sub/B.swift'), 'let b = 1');
  fs.writeFileSync(path.join(a, 'native/helper/Sources/ComputerUseHelper/notes.txt'), 'not swift');
  const added = sourceDigest(a);
  assert.notEqual(added, edited, 'a new Swift file counts, a text file beside it does not');
  fs.writeFileSync(path.join(a, 'native/helper/Package.resolved'), '{}');
  assert.notEqual(sourceDigest(a), added);
  assert.equal(sourceDigest(path.join(tmp, 'nothing')), null);
});

test('the expected digest: a checkout’s own sources; a packaged app’s file; unknown (nothing checked) when it cannot be read', () => {
  const root = tree();
  assert.equal(expectedDigest({ repoRoot: root }), sourceDigest(root));
  assert.equal(expectedDigest({ packaged: false, repoRoot: path.join(tmp, 'nothing') }), null);
  const broken = path.join(tmp, `broken${n++}`);
  fs.mkdirSync(path.join(broken, 'native/helper'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'native/helper/Package.swift'), '// no Sources');
  assert.equal(expectedDigest({ repoRoot: broken }), null, 'sources that cannot be read check nothing in a checkout');
  const app = path.join(tmp, `app${n++}`);
  fs.mkdirSync(app);
  assert.equal(expectedDigest({ packaged: true, repoRoot: app }), UNKNOWN, 'no file: nothing will match');
  fs.writeFileSync(path.join(app, DIGEST_FILE), '\n');
  assert.equal(expectedDigest({ packaged: true, repoRoot: app }), UNKNOWN, 'an empty file');
  writeHelperDigest(app);
  assert.equal(
    expectedDigest({ packaged: true, repoRoot: app }),
    sourceDigest(path.resolve(import.meta.dirname, '..')),
    'package.mjs writes what the build stamped',
  );
});

test('a hello is checked against the expected digest: a missing stamp is out of date, never a match', () => {
  assert.equal(stampProblem({ sourceDigest: 'abc' }, 'abc'), null);
  assert.equal(stampProblem({}, null), null, 'nothing expected, nothing checked');
  assert.match(stampProblem({}, 'abc'), /no build stamp/);
  assert.match(stampProblem({ sourceDigest: '' }, 'abc'), /no build stamp/);
  assert.match(stampProblem(undefined, 'abc'), /no build stamp/);
  assert.match(stampProblem({ sourceDigest: 'old' }, 'abc'), /other sources/);
  assert.match(
    stampProblem({ sourceDigest: UNKNOWN }, UNKNOWN),
    /no record of the helper/,
    'a packaged app with no digest file runs no helper',
  );
});

/** A fake `open` that starts a stand-in helper per launch; `stamps[i]` is what launch i reports (undefined: none). */
function launcher(stamps: (string | undefined)[], appPath: string) {
  let launches = 0;
  const servers: net.Server[] = [];
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    const config = JSON.parse(fs.readFileSync(args.at(-1)!, 'utf8'));
    const stamp = stamps[Math.min(launches++, stamps.length - 1)];
    const server = net.createServer((s) => {
      s.setEncoding('utf8');
      s.on(
        'data',
        lineDecoder((m: any) =>
          s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { pid: 7, ...(stamp && { sourceDigest: stamp }) } }) + '\n'),
        ),
      );
    });
    servers.push(server);
    server.listen(config.socket, () => child.emit('exit', 0));
    return child;
  };
  const make = (o: object = {}) => new ComputerHelper({ appPath, platform: 'darwin', exists: () => true, spawn, ...o });
  return { make, launches: () => launches, close: () => servers.forEach((s) => s.close()) };
}

test('a helper that reports the expected stamp runs; with nothing expected, whatever it reports runs', async () => {
  const l = launcher(['good'], bundle('good'));
  const h = l.make({ expectedDigest: 'good' });
  assert.equal((await h.start()).sourceDigest, 'good');
  assert.equal(l.launches(), 1);
  h.stop();
  const bare = launcher([undefined], bundle(null));
  const none = bare.make();
  assert.equal((await none.start()).pid, 7);
  none.stop();
  bare.close();
  l.close();
});

test('a helper process left over from a replaced bundle is stopped and launched again from disk, not just reported', async () => {
  const l = launcher(['old', 'good'], bundle('good'));
  const h = l.make({ expectedDigest: 'good' });
  assert.equal((await h.start()).sourceDigest, 'good');
  assert.equal(l.launches(), 2, 'the first launch was stale, the second is the bundle on disk');
  assert.equal(h.outdated, null);
  h.stop();
  l.close();
});

test('a bundle that stays out of date is refused with the fix, no launch more, until the bundle on disk changes; an older helper with no stamp is out of date too', async () => {
  for (const [packaged, fix] of [
    [false, /node scripts\/build-helper\.mjs/],
    [true, /update or reinstall MoPilot/],
  ] as const) {
    const app = bundle('old');
    const l = launcher([undefined], app);
    const h = l.make({ expectedDigest: 'good', packaged });
    await assert.rejects(
      h.start(),
      (e: any) =>
        e.reason === 'helper_outdated' && /out of date/.test(e.message) && /no build stamp/.test(e.message) && fix.test(e.message),
    );
    assert.equal(l.launches(), 2, 'one relaunch, then refused');
    assert.equal(h.running, false);
    await assert.rejects(h.start(), /out of date/);
    await assert.rejects(h.call('app.click', {}), /out of date/, 'no request goes to it');
    assert.equal(l.launches(), 2, 'refused without launching');
    // the bundle is rebuilt: the helper is tried again
    const plistFile = path.join(app, 'Contents/Info.plist');
    fs.utimesSync(plistFile, new Date(), new Date(Date.now() + 5000));
    const again = launcher(['good'], app);
    const fixed = again.make({ expectedDigest: 'good', packaged });
    fixed.outdated = h.outdated;
    assert.equal((await fixed.start()).sourceDigest, 'good');
    assert.equal(fixed.outdated, null);
    fixed.stop();
    l.close();
    again.close();
  }
});

test('a helper whose bundle cannot be read is refused until it can be (the plist time is unknown, not changed)', async () => {
  const app = path.join(tmp, `gone${n++}.app`);
  const l = launcher(['old'], app);
  const h = l.make({ expectedDigest: 'good' });
  await assert.rejects(h.start(), /other sources/);
  await assert.rejects(h.start(), /out of date/);
  assert.equal(l.launches(), 2);
  l.close();
});

test('a fake helper on a socket (the e2e tests) is never checked', async () => {
  const socket = path.join(tmp, `fake${n++}.sock`);
  const server = net.createServer((s) => {
    s.setEncoding('utf8');
    s.on(
      'data',
      lineDecoder((m: any) => s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { pid: 1 } }) + '\n')),
    );
  });
  await new Promise<void>((r) => server.listen(socket, () => r()));
  const h = new ComputerHelper({ expectedDigest: 'good', connectTo: socket });
  assert.equal((await h.start()).pid, 1, 'no stamp, and still accepted');
  assert.equal(h.outdated, null);
  h.stop();
  server.close();
});

test('a bundle is checked against the tree: matching, other sources, no stamp and no plist are told apart; the install check exits 1 for the last three', () => {
  const root = tree();
  const digest = sourceDigest(root);
  assert.equal(bundleProblem(bundle(digest), root), null);
  assert.match(bundleProblem(bundle('old'), root)!, /other sources \(old\) than this tree/);
  assert.match(bundleProblem(bundle(null), root)!, /no build stamp/);
  assert.match(bundleProblem(path.join(tmp, 'none.app'), root)!, /no Info\.plist/);
  assert.equal(bundleProblem(bundle('x'), path.join(tmp, 'nothing')), null, 'a tree without helper sources has nothing to compare');
  const said: string[] = [];
  assert.equal(check([bundle(null)], { log: (m) => said.push(m), problem: (a: string) => bundleProblem(a, root) }), 1);
  assert.match(said[0], /^outdated helper:/);
  assert.equal(check([bundle(digest)], { log: (m) => said.push(m), problem: (a: string) => bundleProblem(a, root) }), 0);
  assert.match(said[1], /^helper matches this tree/);
  assert.equal(check([], { log: (m) => said.push(m), problem: () => null }), 0, 'default bundle path');
});

test('the helper’s Info.plist carries the digest only when the build has one', () => {
  assert.equal(helperInfo({ version: '1', build: '1', sourceDigest: 'abc' }).MPCSourceDigest, 'abc');
  assert.equal('MPCSourceDigest' in helperInfo({ version: '1', build: '1' }), false);
});

test('the install check run as a command exits 1 for a helper bundle with no stamp and prints why', () => {
  const run = spawnSync(process.execPath, ['scripts/check-helper-bundle.mjs', bundle(null)], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /outdated helper: .* no build stamp/);
});

test('the expected digest is read at each launch: a helper rebuilt while the app runs is compared with the sources as they are now', async () => {
  let want = 'old-sources';
  const l = launcher(['new-sources'], bundle('new-sources'));
  const h = l.make({ expectedDigest: () => want });
  await assert.rejects(h.start(), /other sources/);
  want = 'new-sources';
  fs.utimesSync(path.join(h.appPath, 'Contents/Info.plist'), new Date(), new Date(Date.now() + 9000));
  assert.equal((await h.start()).sourceDigest, 'new-sources');
  h.stop();
  l.close();
});

test('the helper is checked against this checkout’s helper sources, read at each launch', async () => {
  const { rig } = await import('./support/computer-use-setup-rig.ts');
  const { helper } = rig({ kind: 'acp:gemini' }).runtime;
  assert.equal(typeof helper.expectedDigest, 'function');
  assert.match(helper.expectedDigest(), /^[0-9a-f]{16}$/);
});
